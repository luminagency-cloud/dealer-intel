import { and, eq, inArray } from "drizzle-orm";
import {
  getDb,
  collectionRuns,
  missionResults,
  type MissionResultStatus,
} from "@/lib/db";
import { listWorkItemsForRun, type WorkItem } from "@/lib/db/repository";
import { runMission, type MissionRunResult } from "@/lib/collector";

/**
 * Background run execution. Server actions enqueue work here and return
 * immediately; processing happens off-request in this Node process, writing
 * progress to mission_results so the UI can poll. Requires a persistent
 * server (which Playwright already demands — see CLAUDE.md).
 */

// Survives dev-server HMR module reloads; one active execution per run.
const globalState = globalThis as unknown as {
  __activeRunExecutions?: Set<string>;
};
const activeRuns = (globalState.__activeRunExecutions ??= new Set<string>());

export function isRunExecuting(runId: string): boolean {
  return activeRuns.has(runId);
}

/** (site, mission) pair identifying one unit of work within a run. */
export interface WorkKey {
  siteId: string;
  missionId: string;
}

function outcomeStatus(result: MissionRunResult): MissionResultStatus {
  if (result.notFound) return "not_found";
  if (result.status === "failure") return "failure";
  // Captured something, but not every configured page — operator should look.
  if (result.pagesCaptured < result.pagesAttempted) return "needs_review";
  return "success";
}

function resultFilter(runId: string, item: WorkKey) {
  return and(
    eq(missionResults.collectionRunId, runId),
    eq(missionResults.siteId, item.siteId),
    eq(missionResults.missionId, item.missionId)
  );
}

async function seedResults(runId: string, items: WorkItem[]): Promise<void> {
  const db = getDb();
  for (const { mission, site } of items) {
    await db
      .insert(missionResults)
      .values({
        collectionRunId: runId,
        missionId: mission.id,
        siteId: site.id,
        missionType: mission.missionType,
        status: "pending",
      })
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
          startedAt: null,
          completedAt: null,
        },
      });
  }
}

async function processQueue(runId: string, items: WorkItem[]): Promise<void> {
  const db = getDb();
  try {
    for (const item of items) {
      const key = { siteId: item.site.id, missionId: item.mission.id };
      await db
        .update(missionResults)
        .set({ status: "running", startedAt: new Date() })
        .where(resultFilter(runId, key));

      let update: Partial<typeof missionResults.$inferInsert>;
      try {
        const result = await runMission({
          collectionRunId: runId,
          mission: item.mission,
          site: item.site,
          siteMission: item.siteMission,
        });
        update = {
          status: outcomeStatus(result),
          pagesCaptured: result.pagesCaptured,
          successfulUrl: result.successfulUrl ?? null,
          error: result.error ?? null,
        };
      } catch (err) {
        // runMission handles its own failures; this guards infrastructure
        // errors (R2/database down) so the queue keeps moving.
        update = {
          status: "failure",
          error: err instanceof Error ? err.message : String(err),
        };
      }
      await db
        .update(missionResults)
        .set({ ...update, completedAt: new Date() })
        .where(resultFilter(runId, key));
    }

    await finalizeRunIfDone(runId);
  } finally {
    activeRuns.delete(runId);
  }
}

/** Collection finished: move running -> review (or failed when nothing at
 *  all was captured). Only fires once every work item in the run's scope has
 *  a settled result — single-mission collects leave the run open. */
async function finalizeRunIfDone(runId: string): Promise<void> {
  const db = getDb();
  const [run] = await db
    .select()
    .from(collectionRuns)
    .where(eq(collectionRuns.id, runId));
  if (!run || run.status !== "running") return;

  const results = await db
    .select({
      status: missionResults.status,
      missionId: missionResults.missionId,
      siteId: missionResults.siteId,
    })
    .from(missionResults)
    .where(eq(missionResults.collectionRunId, runId));
  if (results.some((r) => r.status === "pending" || r.status === "running")) {
    return;
  }
  const covered = new Set(results.map((r) => `${r.siteId}:${r.missionId}`));
  const scope = await listWorkItemsForRun(run);
  if (scope.some((i) => !covered.has(`${i.site.id}:${i.mission.id}`))) return;

  const anyCaptured = results.some(
    (r) => r.status === "success" || r.status === "needs_review"
  );
  await db
    .update(collectionRuns)
    .set({
      status: anyCaptured ? "review" : "failed",
      completedAt: new Date(),
    })
    .where(eq(collectionRuns.id, runId));
}

/** Seeds result rows for the run's scope (or the given work-item subset) and
 *  starts background processing. Returns the number of items queued, or
 *  null when the run is already executing. */
export async function startRunExecution(
  runId: string,
  only?: WorkKey[]
): Promise<number | null> {
  if (activeRuns.has(runId)) return null;
  activeRuns.add(runId);

  try {
    const db = getDb();
    const [run] = await db
      .select()
      .from(collectionRuns)
      .where(eq(collectionRuns.id, runId));
    if (!run) throw new Error("Run not found");

    let items = await listWorkItemsForRun(run);
    if (only && only.length > 0) {
      const keys = new Set(only.map((k) => `${k.siteId}:${k.missionId}`));
      items = items.filter((i) => keys.has(`${i.site.id}:${i.mission.id}`));
    }
    if (items.length === 0) {
      activeRuns.delete(runId);
      return 0;
    }

    await seedResults(runId, items);
    if (run.status === "pending") {
      await db
        .update(collectionRuns)
        .set({ status: "running", startedAt: run.startedAt ?? new Date() })
        .where(eq(collectionRuns.id, runId));
    }

    // Deliberately not awaited: the action returns while collection runs.
    void processQueue(runId, items).catch((err) => {
      console.error(`run ${runId} execution crashed:`, err);
      activeRuns.delete(runId);
    });
    return items.length;
  } catch (err) {
    activeRuns.delete(runId);
    throw err;
  }
}

/** Re-queues an existing result (review workflow's Retry). */
export async function retryMissionResult(resultId: string): Promise<void> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(missionResults)
    .where(eq(missionResults.id, resultId));
  if (!row) throw new Error("Result not found");
  if (
    !(["needs_review", "failure", "not_found"] as MissionResultStatus[]).includes(
      row.status
    )
  ) {
    throw new Error(`Cannot retry a ${row.status} result`);
  }
  await startRunExecution(row.collectionRunId, [
    { siteId: row.siteId, missionId: row.missionId },
  ]);
}

/** Operator resolution: the content genuinely is not on the site. */
export async function markContentRemoved(resultId: string): Promise<void> {
  await getDb()
    .update(missionResults)
    .set({ status: "content_removed", completedAt: new Date() })
    .where(
      and(
        eq(missionResults.id, resultId),
        inArray(missionResults.status, ["needs_review", "failure", "not_found"])
      )
    );
}
