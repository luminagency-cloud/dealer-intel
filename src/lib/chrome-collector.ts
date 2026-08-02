import { and, eq, inArray } from "drizzle-orm";
import {
  collectionRuns,
  getDb,
  missionResults,
  siteMissions,
  sites,
  type MissionType,
} from "@/lib/db";
import { getCollectionRun, listWorkItemsForRun } from "@/lib/db/repository";
import { uploadEvidence } from "@/lib/evidence";
import { finalizeRunIfDone } from "@/lib/run-executor";

export const CHROME_COLLECTOR_PROTOCOL_VERSION = 2;

export interface ChromeCollectionItem {
  siteId: string;
  siteName: string;
  missionId: string;
  missionType: MissionType;
  missionName: string;
  url: string;
}

export interface ChromeCollectionJob {
  protocolVersion: number;
  runId: string;
  items: ChromeCollectionItem[];
}

export class ChromeCollectorError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
    this.name = "ChromeCollectorError";
  }
}

/** Seeds the complete run scope before desktop Chrome starts. This keeps the
 *  run lifecycle authoritative on the server while the extension processes
 *  work items sequentially, grouped by dealer. */
export async function startChromeRun(
  runId: string
): Promise<ChromeCollectionJob> {
  const run = await getCollectionRun(runId);
  if (!run) throw new ChromeCollectorError("Run not found", 404);
  if (run.collectorMode !== "chrome_extension") {
    throw new ChromeCollectorError(
      "This run is assigned to the Current collector",
      409
    );
  }
  if (run.status !== "pending" && run.status !== "running") {
    throw new ChromeCollectorError(
      `Chrome runs must be pending or running; this run is ${run.status}`,
      409
    );
  }

  const items = await listWorkItemsForRun(run);
  if (items.length === 0) {
    throw new ChromeCollectorError("This run has no active work items", 409);
  }

  const chromeItems = items.map(({ site, mission, siteMission }) => ({
    siteId: site.id,
    siteName: site.name,
    missionId: mission.id,
    missionType: mission.missionType,
    missionName: mission.name,
    url:
      siteMission?.lastKnownUrl?.trim() ||
      siteMission?.alternateUrls.find((value) => value.trim())?.trim() ||
      site.url,
  }));

  const db = getDb();
  if (run.status === "pending") {
    const now = new Date();
    await db
      .insert(missionResults)
      .values(
        items.map(({ site, mission }) => ({
          collectionRunId: runId,
          missionId: mission.id,
          siteId: site.id,
          missionType: mission.missionType,
          status: "pending" as const,
          startedAt: now,
        }))
      )
      .onConflictDoUpdate({
        target: [
          missionResults.collectionRunId,
          missionResults.siteId,
          missionResults.missionId,
        ],
        set: {
          status: "pending",
          pagesCaptured: 0,
          successfulUrl: null,
          error: null,
          startedAt: now,
          completedAt: null,
        },
      });
    await db
      .update(collectionRuns)
      .set({ status: "running", startedAt: run.startedAt ?? now, completedAt: null })
      .where(eq(collectionRuns.id, runId));

    return {
      protocolVersion: CHROME_COLLECTOR_PROTOCOL_VERSION,
      runId,
      items: chromeItems,
    };
  }

  const unfinished = await db
    .select({
      siteId: missionResults.siteId,
      missionId: missionResults.missionId,
    })
    .from(missionResults)
    .where(
      and(
        eq(missionResults.collectionRunId, runId),
        inArray(missionResults.status, ["pending", "running"])
      )
    );
  const unfinishedKeys = new Set(
    unfinished.map((item) => `${item.siteId}:${item.missionId}`)
  );

  return {
    protocolVersion: CHROME_COLLECTOR_PROTOCOL_VERSION,
    runId,
    items: chromeItems.filter((item) =>
      unfinishedKeys.has(`${item.siteId}:${item.missionId}`)
    ),
  };
}

async function requireChromeWorkItem(
  runId: string,
  siteId: string,
  missionId: string
) {
  const run = await getCollectionRun(runId);
  if (!run) throw new ChromeCollectorError("Run not found", 404);
  if (run.collectorMode !== "chrome_extension") {
    throw new ChromeCollectorError("Run is not assigned to Chrome", 409);
  }
  const items = await listWorkItemsForRun(run);
  const item = items.find(
    (candidate) =>
      candidate.site.id === siteId && candidate.mission.id === missionId
  );
  if (!item) throw new ChromeCollectorError("Work item is outside this run", 403);
  return item;
}

export async function completeChromeItem(input: {
  runId: string;
  siteId: string;
  missionId: string;
  finalUrl: string;
  pageTitle: string;
  html: string;
  screenshot: Uint8Array;
}): Promise<void> {
  const item = await requireChromeWorkItem(
    input.runId,
    input.siteId,
    input.missionId
  );
  const label = `${input.pageTitle.trim() || item.site.name} — ${input.finalUrl}`;

  await uploadEvidence({
    collectionRunId: input.runId,
    siteId: input.siteId,
    missionType: item.mission.missionType,
    evidenceType: "html_snapshot",
    fileName: "page.html",
    body: Buffer.from(input.html, "utf8"),
    label,
  });
  await uploadEvidence({
    collectionRunId: input.runId,
    siteId: input.siteId,
    missionType: item.mission.missionType,
    evidenceType: "screenshot",
    fileName: "page.png",
    body: input.screenshot,
    label,
  });

  const now = new Date();
  const db = getDb();
  await db
    .update(missionResults)
    .set({
      status: "success",
      pagesCaptured: 1,
      successfulUrl: input.finalUrl,
      error: null,
      completedAt: now,
    })
    .where(
      and(
        eq(missionResults.collectionRunId, input.runId),
        eq(missionResults.siteId, input.siteId),
        eq(missionResults.missionId, input.missionId)
      )
    );
  await db
    .update(sites)
    .set({ lastCollectedAt: now })
    .where(eq(sites.id, input.siteId));
  if (item.siteMission) {
    await db
      .update(siteMissions)
      .set({ lastKnownUrl: input.finalUrl, lastSuccessAt: now })
      .where(eq(siteMissions.id, item.siteMission.id));
  }

  await finalizeRunIfDone(input.runId);
}

export async function failChromeItem(input: {
  runId: string;
  siteId: string;
  missionId: string;
  error: string;
}): Promise<void> {
  await requireChromeWorkItem(input.runId, input.siteId, input.missionId);
  await getDb()
    .update(missionResults)
    .set({
      status: "failure",
      pagesCaptured: 0,
      error: input.error.slice(0, 1000),
      completedAt: new Date(),
    })
    .where(
      and(
        eq(missionResults.collectionRunId, input.runId),
        eq(missionResults.siteId, input.siteId),
        eq(missionResults.missionId, input.missionId)
      )
    );
  await finalizeRunIfDone(input.runId);
}
