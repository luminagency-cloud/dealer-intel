import { and, eq, inArray } from "drizzle-orm";
import {
  getDb,
  collectionRuns,
  missionResults,
  type RunStatus,
} from "@/lib/db";
import { listWorkItemsForRun } from "@/lib/db/repository";

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
 * Server-side run lifecycle. Collection itself runs in the operator's Chrome
 * (see `src/lib/chrome-collector.ts`); what is left here is settling a run once
 * its work items report in, plus the operator's manual resolutions.
 */

/** Collection finished: settle the run's terminal status. Failed when nothing
 *  captured, auto-published when enough sites succeeded (Phase 8), otherwise
 *  held in review for the operator. Only fires once every work item in the
 *  run's scope has a settled result — single-mission collects leave the run
 *  open. */
export async function finalizeRunIfDone(runId: string): Promise<void> {
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
      missionType: missionResults.missionType,
      completedAt: missionResults.completedAt,
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
    const { startAnalysis, startAnalysisForSiteMission } = await import(
      "@/lib/analysis"
    );
    const analyzedAt = run.analysisStartedAt;
    if (!analyzedAt) {
      void startAnalysis(runId).catch((err) => {
        console.error(`AUTO_ANALYZE_AFTER_SCRAPE: analysis failed for run ${runId}:`, err);
      });
    } else {
      // The run was already analyzed once, so this settle came from re-collecting
      // a subset. Re-analyzing the whole run here wipes every offer and rebuilds
      // all sites — which is why a single re-collect used to blank the table.
      // Only the items captured since the last analysis started need a pass.
      const fresh = results.filter(
        (r) =>
          (r.status === "success" || r.status === "needs_review") &&
          r.completedAt !== null &&
          r.completedAt > analyzedAt
      );
      for (const r of fresh) {
        void startAnalysisForSiteMission(runId, r.siteId, r.missionType).catch(
          (err) => {
            console.error(
              `AUTO_ANALYZE_AFTER_SCRAPE: partial analysis failed for run ${runId} site ${r.siteId} ${r.missionType}:`,
              err
            );
          }
        );
      }
    }
  }
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
