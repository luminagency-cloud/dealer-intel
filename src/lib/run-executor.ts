import { and, eq, inArray } from "drizzle-orm";
import {
  getDb,
  collectionRuns,
  evidence,
  missionResults,
  missions,
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

/** Max sites collected in parallel within one run. Each site opens one
 *  Chromium browser; Playwright registers 3 process signal handlers per
 *  browser (SIGINT, SIGTERM, exit). Setting an accurate ceiling here lets us
 *  size process.setMaxListeners to the real architectural limit rather than
 *  an arbitrary large number. Tune with COLLECTOR_CONCURRENCY env var. */
const COLLECTOR_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.COLLECTOR_CONCURRENCY ?? "5", 10)
);

// Playwright: 3 handlers × COLLECTOR_CONCURRENCY browsers.
// Next.js + system: ~15 for everything else running in this process.
// This is a declared architectural limit, not a "hide the warning" bump.
process.setMaxListeners(COLLECTOR_CONCURRENCY * 3 + 15);

/**
 * Background run execution. Server actions enqueue work here and return
 * immediately; processing happens off-request in this Node process, writing
 * progress to mission_results so the UI can poll. Requires a persistent
 * server (which Playwright already demands — see CLAUDE.md).
 */

// Survives dev-server HMR module reloads; one active execution per run.
const globalState = globalThis as unknown as {
  __activeRunExecutions?: Set<string>;
  __pausedRunExecutions?: Set<string>;
};
const activeRuns = (globalState.__activeRunExecutions ??= new Set<string>());
const pausedRuns = (globalState.__pausedRunExecutions ??= new Set<string>());

export function isRunExecuting(runId: string): boolean {
  return activeRuns.has(runId);
}

export function isPausedRun(runId: string): boolean {
  return pausedRuns.has(runId);
}

/** Signal the executor to pause after the current site finishes. Updates the
 *  DB status immediately so the UI reflects the intent before the drainer exits. */
export async function pauseRunExecution(runId: string): Promise<void> {
  pausedRuns.add(runId);
  await getDb()
    .update(collectionRuns)
    .set({ status: "paused" })
    .where(and(eq(collectionRuns.id, runId), eq(collectionRuns.status, "running")));
}

/** Clear the pause signal and restart the drainer to pick up pending items. */
export async function resumeRunExecution(runId: string): Promise<void> {
  pausedRuns.delete(runId);
  ensureDrainer(runId);
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

/** Collects a batch of work items with up to COLLECTOR_CONCURRENCY sites
 *  running in parallel. Sites are dispatched one-by-one so the pause flag
 *  is honoured before each new site starts; sites already in flight complete
 *  normally. Pure processing — does not manage the activeRuns guard or finalize. */
async function processSites(runId: string, items: WorkItem[]): Promise<void> {
  const db = getDb();
  const bySite = new Map<string, WorkItem[]>();
  for (const item of items) {
    const list = bySite.get(item.site.id) ?? [];
    list.push(item);
    bySite.set(item.site.id, list);
  }

  async function runOneSite(siteItems: WorkItem[]): Promise<void> {
    const site = siteItems[0].site;
    const missionIds = siteItems.map((i) => i.mission.id);

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
      // infrastructure errors (R2/database) so the queue keeps moving.
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

  // Bounded concurrent pool: dispatch sites one-by-one, but let up to
  // COLLECTOR_CONCURRENCY run simultaneously. Pause is checked before each
  // new dispatch so an in-flight site finishes before the run actually stops.
  const inFlight = new Set<Promise<void>>();
  for (const siteItems of bySite.values()) {
    if (pausedRuns.has(runId)) break;

    // Wait for a slot to open when the pool is full.
    if (inFlight.size >= COLLECTOR_CONCURRENCY) {
      await Promise.race(inFlight);
    }
    if (pausedRuns.has(runId)) break;

    const task: Promise<void> = runOneSite(siteItems).finally(() => {
      inFlight.delete(task);
    });
    inFlight.add(task);
  }

  // Drain any sites still in flight.
  if (inFlight.size > 0) await Promise.all(inFlight);
}

async function processQueue(runId: string, items: WorkItem[]): Promise<void> {
  try {
    await processSites(runId, items);
    if (!pausedRuns.has(runId)) {
      await finalizeRunIfDone(runId);
    }
  } finally {
    activeRuns.delete(runId);
    if (!pausedRuns.has(runId)) {
      await rescuePending(runId);
    }
  }
}

/** Count of work still queued/in-flight for a run. */
async function countActiveResults(runId: string): Promise<number> {
  const rows = await getDb()
    .select({ id: missionResults.id })
    .from(missionResults)
    .where(
      and(
        eq(missionResults.collectionRunId, runId),
        inArray(missionResults.status, ["pending", "running"])
      )
    );
  return rows.length;
}

/** After an executor exits, pick up any retries that were queued right as it
 *  was finishing (closes the click-at-shutdown race). */
async function rescuePending(runId: string): Promise<void> {
  if (activeRuns.has(runId)) return;
  if ((await countActiveResults(runId)) > 0) ensureDrainer(runId);
}

/** Starts the per-run retry drainer if one isn't already running. Multiple
 *  retries clicked while it runs just get picked up on its next pass. */
function ensureDrainer(runId: string): void {
  if (activeRuns.has(runId)) return;
  activeRuns.add(runId);
  void drainRun(runId).catch((err) => {
    console.error(`retry drainer for run ${runId} crashed:`, err);
    activeRuns.delete(runId);
  });
}

/** Drains all `pending` (queued) mission results for a run, re-querying each
 *  pass so retries queued while it runs are processed in the same drain. */
async function drainRun(runId: string): Promise<void> {
  const db = getDb();
  try {
    const [run] = await db
      .select()
      .from(collectionRuns)
      .where(eq(collectionRuns.id, runId));
    if (!run) return;
    // Surface progress on the run page; finalize re-settles at the end.
    if (run.status === "pending" || run.status === "paused" || run.status === "review" || run.status === "failed" || run.status === "complete") {
      await db
        .update(collectionRuns)
        .set({ status: "running", startedAt: run.startedAt ?? new Date() })
        .where(eq(collectionRuns.id, runId));
    }

    const scope = await listWorkItemsForRun(run);
    const byKey = new Map(scope.map((i) => [`${i.site.id}:${i.mission.id}`, i]));

    while (true) {
      if (pausedRuns.has(runId)) break;
      const pendings = await db
        .select({
          siteId: missionResults.siteId,
          missionId: missionResults.missionId,
        })
        .from(missionResults)
        .where(
          and(
            eq(missionResults.collectionRunId, runId),
            eq(missionResults.status, "pending")
          )
        );
      if (pendings.length === 0) break;

      const items = pendings
        .map((p) => byKey.get(`${p.siteId}:${p.missionId}`))
        .filter((i): i is WorkItem => Boolean(i));
      // Pending rows no longer in scope (mission/site disabled) can't be built
      // — stop rather than spin forever; they keep their pending status.
      if (items.length === 0) break;

      await processSites(runId, items);
    }

    if (!pausedRuns.has(runId)) {
      await finalizeRunIfDone(runId);
    }
  } finally {
    activeRuns.delete(runId);
    if (!pausedRuns.has(runId)) {
      await rescuePending(runId);
    }
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
    status = "complete";
  } else {
    status = "review";
  }

  await db
    .update(collectionRuns)
    .set({ status, completedAt: new Date() })
    .where(eq(collectionRuns.id, runId));

  if (status !== "failed" && process.env.AUTO_ANALYZE_AFTER_SCRAPE === "true") {
    const { startAnalysis } = await import("@/lib/analysis");
    void startAnalysis(runId).catch((err) => {
      console.error(`AUTO_ANALYZE_AFTER_SCRAPE: analysis failed for run ${runId}:`, err);
    });
  }
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

/** Re-queues an existing result (review workflow's Retry). Enqueues rather than
 *  collecting synchronously: the row goes back to `pending` (queued) and the
 *  per-run drainer picks it up. Click Retry on many sites and they all queue —
 *  retries landing while the drainer runs are caught on its next pass. */
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
  await db
    .update(missionResults)
    .set({
      status: "pending",
      pagesCaptured: 0,
      successfulUrl: null,
      error: null,
      startedAt: null,
      completedAt: null,
    })
    .where(eq(missionResults.id, resultId));
  ensureDrainer(row.collectionRunId);
}

/** Resume a stalled run: re-queue rows left `pending`/`running` by an
 *  interrupted executor (e.g. a server restart mid-run) and kick the drainer.
 *  No-op while the run is genuinely executing — it only rescues orphans. */
export async function requeueStalledRun(runId: string): Promise<void> {
  if (activeRuns.has(runId)) return;
  await getDb()
    .update(missionResults)
    .set({
      status: "pending",
      pagesCaptured: 0,
      successfulUrl: null,
      error: null,
      startedAt: null,
      completedAt: null,
    })
    .where(
      and(
        eq(missionResults.collectionRunId, runId),
        inArray(missionResults.status, ["pending", "running"])
      )
    );
  ensureDrainer(runId);
}

/** Force-requeue a single site+mission result regardless of run status.
 *  Used by the operator to re-collect one dealer on an already-complete run
 *  without having to start a new run. The run transitions back to running
 *  while collection is in flight, then re-finalises when done. */
export async function forceReCollectSingle(
  runId: string,
  siteId: string,
  missionId: string
): Promise<void> {
  const db = getDb();
  const [mission] = await db
    .select()
    .from(missions)
    .where(eq(missions.id, missionId));
  if (!mission) throw new Error("Mission not found");

  // Purge stale evidence for this site+mission so re-analysis never sees a mix
  // of old and new captures. R2 objects are orphaned (acceptable — they expire
  // or are cleaned up with the run); the DB rows are what analysis reads.
  await db
    .delete(evidence)
    .where(
      and(
        eq(evidence.collectionRunId, runId),
        eq(evidence.siteId, siteId),
        eq(evidence.missionType, mission.missionType)
      )
    );

  await db
    .insert(missionResults)
    .values({
      collectionRunId: runId,
      missionId,
      siteId,
      missionType: mission.missionType,
      status: "pending",
      pagesCaptured: 0,
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

  ensureDrainer(runId);
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
