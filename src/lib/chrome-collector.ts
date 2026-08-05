import { and, eq, inArray, isNotNull } from "drizzle-orm";
import {
  collectionRuns,
  evidence,
  getDb,
  missionResults,
  siteMissions,
  sites,
  type MissionType,
} from "@/lib/db";
import { getCollectionRun, listWorkItemsForRun } from "@/lib/db/repository";
import { uploadEvidence } from "@/lib/evidence";
import { finalizeRunIfDone } from "@/lib/run-executor";
import { MISSION_EXPLORATION } from "@/lib/collector/mission-knowledge";
import { captureAdImages } from "@/lib/collector/ad-images";

export const CHROME_COLLECTOR_PROTOCOL_VERSION = 3;

export type ChromeCaptureStateKind =
  | "base"
  | "carousel"
  | "tab"
  | "disclaimer"
  | "failure";

export interface ChromeCollectionItem {
  siteId: string;
  siteName: string;
  missionId: string;
  missionType: MissionType;
  missionName: string;
  url: string;
  explore: {
    carousels: boolean;
    tabs: boolean;
    accordions: boolean;
    disclaimers: boolean;
  };
}

export interface ChromeCollectionJob {
  protocolVersion: number;
  runId: string;
  items: ChromeCollectionItem[];
}

/** How long a Chrome run may go silent before we call its tab dead.
 *  ponytail: the heartbeat piggybacks on the extension's existing result POSTs
 *  rather than a dedicated ping, so this window has to cover the longest
 *  plausible gap between captures. Add a real ping if a slow dealer page ever
 *  trips it mid-run. */
export const CHROME_HEARTBEAT_STALE_MS = 3 * 60_000;

/** Chrome collection happens in the operator's browser, so `isRunExecuting`
 *  (the in-process Playwright registry) never knows about it. A fresh
 *  heartbeat is what "this run is actually collecting right now" means. */
export function isChromeRunLive(run: {
  collectorMode: string;
  status: string;
  chromeHeartbeatAt: Date | null;
}): boolean {
  if (run.collectorMode !== "chrome_extension" || run.status !== "running") {
    return false;
  }
  if (!run.chromeHeartbeatAt) return false;
  return Date.now() - run.chromeHeartbeatAt.getTime() < CHROME_HEARTBEAT_STALE_MS;
}

/** Called on every result POST from the driving tab — that traffic is the
 *  proof of life, so no separate ping channel is needed. */
export async function touchChromeHeartbeat(runId: string): Promise<void> {
  await getDb()
    .update(collectionRuns)
    .set({ chromeHeartbeatAt: new Date() })
    .where(eq(collectionRuns.id, runId));
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

  const chromeItems = items.map(({ site, mission, siteMission }) => {
    const explore = MISSION_EXPLORATION[mission.missionType];
    return {
      siteId: site.id,
      siteName: site.name,
      missionId: mission.id,
      missionType: mission.missionType,
      missionName: mission.name,
      url:
        siteMission?.lastKnownUrl?.trim() ||
        siteMission?.alternateUrls.find((value) => value.trim())?.trim() ||
        site.url,
      explore: {
        carousels: Boolean(explore.carousels),
        tabs: Boolean(explore.tabs),
        accordions: Boolean(explore.accordions),
        disclaimers: Boolean(explore.disclaimers),
      },
    };
  });

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
      .set({
        status: "running",
        startedAt: run.startedAt ?? now,
        completedAt: null,
        chromeHeartbeatAt: now,
      })
      .where(eq(collectionRuns.id, runId));

    return {
      protocolVersion: CHROME_COLLECTOR_PROTOCOL_VERSION,
      runId,
      items: chromeItems,
    };
  }

  // Resuming an already-running run: claim it now so the page reads as live
  // before the first capture lands.
  await touchChromeHeartbeat(runId);

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

export async function uploadChromeCaptureState(input: {
  runId: string;
  siteId: string;
  missionId: string;
  stateId: string;
  stateKind: ChromeCaptureStateKind;
  stateOrder: number;
  finalUrl: string;
  pageTitle: string;
  label: string;
  html: string;
  screenshot: Uint8Array;
  textContent?: string;
}): Promise<void> {
  const item = await requireChromeWorkItem(
    input.runId,
    input.siteId,
    input.missionId
  );
  const stateId = input.stateId.trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(stateId)) {
    throw new ChromeCollectorError("Invalid capture state id");
  }
  if (!Number.isInteger(input.stateOrder) || input.stateOrder < 0) {
    throw new ChromeCollectorError("Invalid capture state order");
  }
  const manifestStateId = `${input.missionId}:${stateId}`;
  const artifactPrefix = [
    input.runId,
    input.siteId,
    input.missionId,
    stateId,
  ].join(":");
  const label =
    input.label.trim() ||
    `${input.pageTitle.trim() || item.site.name} — ${input.finalUrl}`;
  const metadata = {
    captureStateId: manifestStateId,
    captureState: input.stateKind,
    sourceUrl: input.finalUrl,
    captureOrder: input.stateOrder,
    label,
  };

  await uploadEvidence({
    collectionRunId: input.runId,
    siteId: input.siteId,
    missionType: item.mission.missionType,
    evidenceType:
      input.stateKind === "base" ? "html_snapshot" : "state_html_snapshot",
    fileName: `${stateId}.html`,
    body: Buffer.from(input.html, "utf8"),
    captureKey: `${artifactPrefix}:html`,
    ...metadata,
  });
  await uploadEvidence({
    collectionRunId: input.runId,
    siteId: input.siteId,
    missionType: item.mission.missionType,
    evidenceType:
      input.stateKind === "disclaimer"
        ? "disclaimer_screenshot"
        : input.stateKind === "failure"
          ? "failure_screenshot"
        : "screenshot",
    fileName: `${stateId}.png`,
    body: input.screenshot,
    textContent: input.textContent,
    captureKey: `${artifactPrefix}:screenshot`,
    ...metadata,
  });

  // Same as the Current collector: on image-rendered platforms the offer lives
  // inside a JPEG, so the ad graphic is evidence and belongs to this capture,
  // not to a later analysis pass re-downloading it from the dealer's CDN.
  // Skipped for failure states, which have no page worth mining.
  if (input.stateKind !== "failure") {
    await captureAdImages({
      collectionRunId: input.runId,
      siteId: input.siteId,
      missionType: item.mission.missionType,
      html: input.html,
      pageUrl: input.finalUrl,
      captureStateId: manifestStateId,
    });
  }

  await getDb()
    .update(missionResults)
    .set({ status: "running" })
    .where(
      and(
        eq(missionResults.collectionRunId, input.runId),
        eq(missionResults.siteId, input.siteId),
        eq(missionResults.missionId, input.missionId)
      )
    );
}

async function chromeStateIds(input: {
  runId: string;
  siteId: string;
  missionId: string;
  missionType: MissionType;
}): Promise<Set<string>> {
  const rows = await getDb()
    .select({ captureStateId: evidence.captureStateId })
    .from(evidence)
    .where(
      and(
        eq(evidence.collectionRunId, input.runId),
        eq(evidence.siteId, input.siteId),
        eq(evidence.missionType, input.missionType),
        isNotNull(evidence.captureStateId)
      )
    );
  const prefix = `${input.missionId}:`;
  return new Set(
    rows
      .map((row) => row.captureStateId)
      .filter((value): value is string => Boolean(value?.startsWith(prefix)))
  );
}

export async function completeChromeItem(input: {
  runId: string;
  siteId: string;
  missionId: string;
  finalUrl: string;
  stateCount: number;
}): Promise<void> {
  const item = await requireChromeWorkItem(
    input.runId,
    input.siteId,
    input.missionId
  );
  if (!Number.isInteger(input.stateCount) || input.stateCount < 1) {
    throw new ChromeCollectorError("Chrome collection returned no capture states");
  }
  const stateIds = await chromeStateIds({
    ...input,
    missionType: item.mission.missionType,
  });
  if (!stateIds.has(`${input.missionId}:base`)) {
    throw new ChromeCollectorError("Chrome collection did not upload its base state", 409);
  }
  if (stateIds.size < input.stateCount) {
    throw new ChromeCollectorError(
      `Chrome uploaded ${stateIds.size} of ${input.stateCount} capture states`,
      409
    );
  }

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
  const item = await requireChromeWorkItem(
    input.runId,
    input.siteId,
    input.missionId
  );
  const stateIds = await chromeStateIds({
    ...input,
    missionType: item.mission.missionType,
  });
  const partialCapture = stateIds.size > 0;
  await getDb()
    .update(missionResults)
    .set({
      status: partialCapture ? "needs_review" : "failure",
      pagesCaptured: stateIds.has(`${input.missionId}:base`) ? 1 : 0,
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
