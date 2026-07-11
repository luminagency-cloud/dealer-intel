import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import {
  RUN_STATUS_LABELS,
  getDb,
  runGroups,
  sites,
} from "@/lib/db";
import {
  getCollectionRun,
  listComplianceGradesForRun,
  listOffersForRun,
  listResultsForRun,
  listSnapshotsForRun,
  listWorkItemsForRun,
  resolveRunGroups,
} from "@/lib/db/repository";
import { isRunExecuting, isPausedRun } from "@/lib/run-executor";
import { isAnalysisRunning, getAnalysisProgress, getPartialAnalysisKeys } from "@/lib/analysis";
import { RUN_TRANSITIONS } from "@/lib/run-lifecycle";
import { RunStatusBadge } from "@/components/run-status-badge";
import { RunLiveData } from "@/components/run-live-data";
import { RunOfferBreakdown } from "@/components/run-offer-breakdown";
import { SnapshotSection } from "@/components/snapshot-section";
import { ConfirmSubmitButton } from "@/components/confirm-submit-button";
import {
  deleteRun,
  deleteOffer,
  executeAllMissions,
  executeWorkItem,
  forceReCollect,
  passOffer,
  pauseRun,
  publishSnapshot,
  resumePausedRun,
  resumeRun,
  retryResult,
  runAnalysis,
  resumeAnalysis,
  runAnalysisForSiteMission,
  updateRunStatus,
} from "../actions";
import { fmtDateTime, fmtSnapshotLabel } from "@/lib/fmt-date";

export const dynamic = "force-dynamic";

export default async function RunDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;

  const run = await getCollectionRun(id);
  if (!run) notFound();

  const [
    runOffers,
    runGrades,
    runSnapshots,
    siteOptions,
    missionRows,
    runResults,
    [runGroup],
  ] = await Promise.all([
    listOffersForRun(run.id),
    listComplianceGradesForRun(run.id),
    listSnapshotsForRun(run.id),
    getDb()
      .select({ id: sites.id, name: sites.name, platform: sites.platform })
      .from(sites)
      .orderBy(asc(sites.name)),
    listWorkItemsForRun(run),
    listResultsForRun(run.id),
    run.runGroupId
      ? getDb()
          .select()
          .from(runGroups)
          .where(eq(runGroups.id, run.runGroupId))
      : Promise.resolve([undefined]),
  ]);

  const resolvedGroups = run.runGroupId ? [] : await resolveRunGroups(run.id);
  const scopeLabel = runGroup
    ? runGroup.name
    : resolvedGroups.length > 0
      ? resolvedGroups.map((g) => g.name).join(" + ")
      : null;
  const siteNames = Object.fromEntries(siteOptions.map((s) => [s.id, s.name]));
  const siteMeta = Object.fromEntries(
    siteOptions.map((s) => [s.id, { name: s.name, platform: s.platform ?? null }])
  );
  const nextStatuses = RUN_TRANSITIONS[run.status].filter(
    (s) => !(run.status === "pending" && s === "running")
  );

  const canCollect = run.status === "pending" || run.status === "running" || run.status === "paused";
  const executing = isRunExecuting(run.id);
  const paused = isPausedRun(run.id);
  const evidencePageCount = runResults.reduce(
    (sum, r) => sum + (r.pagesCaptured ?? 0),
    0
  );
  const stalled =
    !executing &&
    runResults.some((r) => r.status === "pending" || r.status === "running");
  const analyzing = isAnalysisRunning(run.id);
  const analysisProgressData = getAnalysisProgress(run.id);
  const partialAnalysisKeys = getPartialAnalysisKeys(run.id);
  const canAnalyze =
    run.status !== "failed" &&
    runResults.some((r) => r.pagesCaptured > 0);

  return (
    <div>
      {/* Title row */}
      <div className="mb-2 flex items-center justify-between py-2">
        <div className="flex items-center gap-2 text-sm">
          <Link href="/runs" className="text-zinc-700 hover:text-zinc-700 dark:text-zinc-200 dark:hover:text-zinc-200">
            ← Runs
          </Link>
          <span className="text-zinc-600 dark:text-zinc-200">/</span>
          <span className="font-semibold text-zinc-900 dark:text-zinc-100">
            Run {run.id.slice(0, 8)}
          </span>
          {scopeLabel && (
            <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-200">
              {scopeLabel}
            </span>
          )}
          <RunStatusBadge status={run.status} />
        </div>
        <div className="flex items-center gap-2">
          {nextStatuses.map((status) => (
            <form key={status} action={updateRunStatus.bind(null, run.id, status)}>
              <button
                type="submit"
                className={
                  status === "failed"
                    ? "rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50"
                    : "rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
                }
              >
                {status === "failed" ? "Mark Failed" : `Move to ${RUN_STATUS_LABELS[status]}`}
              </button>
            </form>
          ))}
          <form action={deleteRun.bind(null, run.id)}>
            <ConfirmSubmitButton
              confirmMessage="Delete this run? All of its evidence (including files in R2), results, and offers are permanently removed."
              className="rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50"
            >
              Delete Run
            </ConfirmSubmitButton>
          </form>
        </div>
      </div>

      {/* Live section: workflow strip + metadata bar + collection + analysis */}
      <RunLiveData
        runId={run.id}
        initialExecuting={executing}
        initialAnalyzing={analyzing}
        initialPaused={paused}
        initialStalled={stalled}
        initialProgress={analysisProgressData}
        initialPartialAnalysisKeys={[...partialAnalysisKeys]}
        items={missionRows}
        initialResults={runResults}
        snapshots={runSnapshots}
        offers={runOffers}
        grades={runGrades}
        siteNames={siteNames}
        siteOptions={siteOptions}
        canCollect={canCollect}
        canAnalyze={canAnalyze}
        canPublish={run.status !== "failed"}
        analysisStartedAt={run.analysisStartedAt}
        analysisCompletedAt={run.analysisCompletedAt}
        evidencePageCount={analysisProgressData?.total ?? evidencePageCount}
        executeItemAction={executeWorkItem.bind(null, run.id)}
        executeAllAction={executeAllMissions.bind(null, run.id)}
        retryAction={retryResult.bind(null, `/runs/${run.id}`)}
        forceReCollectAction={forceReCollect.bind(null, run.id)}
        reAnalyzeSiteMissionAction={runAnalysisForSiteMission.bind(null, run.id)}
        pauseAction={pauseRun.bind(null, run.id)}
        resumePausedRunAction={resumePausedRun.bind(null, run.id)}
        resumeAction={resumeRun.bind(null, run.id)}
        runAnalysisAction={runAnalysis.bind(null, run.id)}
        resumeAnalysisAction={resumeAnalysis.bind(null, run.id)}
        passOfferAction={passOffer.bind(null, run.id)}
        deleteOfferAction={deleteOffer.bind(null, run.id)}
        publishSnapshotAction={publishSnapshot.bind(null, run.id)}
        defaultSnapshotLabel={fmtSnapshotLabel(
          new Date(),
          resolvedGroups.length > 0 ? resolvedGroups.length : 1,
          evidencePageCount
        )}
        collectionStartedAt={run.startedAt}
        collectionCompletedAt={run.completedAt}
        runIdShort={run.id}
        createdLabel={fmtDateTime(run.createdAt)}
        error={error}
      />

      {/* Offer breakdown — pre-publish gut check, same view as verify-offers.ts */}
      {runOffers.length > 0 && (
        <div className="mb-8">
          <h2 className="mb-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            Offer breakdown
          </h2>
          <RunOfferBreakdown offers={runOffers} siteMeta={siteMeta} />
        </div>
      )}

      {/* Snapshot section — static, only changes after a publish action */}
      <div id="snapshot" className="mb-8">
        <SnapshotSection
          snapshots={runSnapshots}
          canPublish={run.status !== "failed"}
          hasOffers={runOffers.length > 0}
          publishAction={publishSnapshot.bind(null, run.id)}
          runGroups={resolvedGroups.length > 1 ? resolvedGroups : undefined}
          defaultLabel={fmtSnapshotLabel(
            new Date(),
            resolvedGroups.length > 0 ? resolvedGroups.length : 1,
            evidencePageCount
          )}
        />
      </div>
    </div>
  );
}
