import { and, eq, inArray } from "drizzle-orm";
import {
  getDb,
  collectionRuns,
  missionResults,
  sites,
  type MissionResultStatus,
  type RunStatus,
} from "@/lib/db";
import { listWorkItemsForRun, type WorkItem } from "@/lib/db/repository";
import {
  collectSite,
  type MissionRunResult,
  type SiteMissionWork,
} from "@/lib/collector";

/** Auto-publish gate (Phase 8): a finished run advances straight to
 *  published when at least this share of its in-scope sites collected
 *  something. Below it the run waits in review for the operator; the manual
 *  Publish / Mark Failed controls on the run page always override.
 *  Env-overridable (`AUTO_PUBLISH_MIN_SITE_SUCCESS`); set it above 1 to disable
 *  auto-publish entirely so every run lands in review — useful for a full
 *  fan-out where the operator wants to triage all per-mission failures (the
 *  review queue hides published runs). */
const AUTO_PUBLISH_MIN_SITE_SUCCESS = Number(
  process.env.AUTO_PUBLISH_MIN_SITE_SUCCESS ?? 0.8
);

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
    // Phase 8: one browser visit per site. Group the run's work by site and
    // let collectSite handle the single session + fresh-session retry.
    const bySite = new Map<string, WorkItem[]>();
    for (const item of items) {
      const list = bySite.get(item.site.id) ?? [];
      list.push(item);
      bySite.set(item.site.id, list);
    }

    for (const siteItems of bySite.values()) {
      const site = siteItems[0].site;
      const missionIds = siteItems.map((i) => i.mission.id);

      // The whole site goes "running" for the duration of its single visit.
      await db
        .update(missionResults)
        .set({ status: "running", startedAt: new Date() })
        .where(
          and(
            eq(missionResults.collectionRunId, runId),
            eq(missionResults.siteId, site.id),
            inArray(missionResults.missionId, missionIds)
          )
        );

      const works: SiteMissionWork[] = siteItems.map((i) => ({
        mission: i.mission,
        siteMission: i.siteMission,
      }));

      try {
        const { anySuccess } = await collectSite(
          { collectionRunId: runId, site, works },
          async (missionId, result) => {
            await db
              .update(missionResults)
              .set({
                status: outcomeStatus(result),
                pagesCaptured: result.pagesCaptured,
                successfulUrl: result.successfulUrl ?? null,
                error: result.error ?? null,
                completedAt: new Date(),
              })
              .where(resultFilter(runId, { siteId: site.id, missionId }));
          }
        );
        if (anySuccess) {
          await db
            .update(sites)
            .set({ lastCollectedAt: new Date() })
            .where(eq(sites.id, site.id));
        }
      } catch (err) {
        // collectSite absorbs browser failures itself; this guards
        // infrastructure errors (R2/database) so the queue keeps moving —
        // settle whatever rows are still in flight for this site.
        await db
          .update(missionResults)
          .set({
            status: "failure",
            error: err instanceof Error ? err.message : String(err),
            completedAt: new Date(),
          })
          .where(
            and(
              eq(missionResults.collectionRunId, runId),
              eq(missionResults.siteId, site.id),
              inArray(missionResults.missionId, missionIds),
              inArray(missionResults.status, ["pending", "running"])
            )
          );
      }
    }

    await finalizeRunIfDone(runId);
  } finally {
    activeRuns.delete(runId);
  }
}

/** Collection finished: settle the run's terminal status. Failed when nothing
 *  captured, auto-published when enough sites succeeded (Phase 8), otherwise
 *  held in review for the operator. Only fires once every work item in the
 *  run's scope has a settled result — single-mission collects leave the run
 *  open. */
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

  // A site "succeeded" when at least one of its missions captured something.
  const sitesInScope = new Set(scope.map((i) => i.site.id));
  const succeededSites = new Set(
    results
      .filter((r) => r.status === "success" || r.status === "needs_review")
      .map((r) => r.siteId)
  );
  const total = sitesInScope.size;
  const ok = [...sitesInScope].filter((s) => succeededSites.has(s)).length;

  let status: RunStatus;
  if (ok === 0) {
    status = "failed";
  } else if (total > 0 && ok / total >= AUTO_PUBLISH_MIN_SITE_SUCCESS) {
    status = "published";
  } else {
    status = "review";
  }

  await db
    .update(collectionRuns)
    .set({ status, completedAt: new Date() })
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
