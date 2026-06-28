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
  listOfferCountsByMissionForRun,
  listOffersForRun,
  listResultsForRun,
  listSnapshotsForRun,
  listWorkItemsForRun,
  resolveRunGroups,
} from "@/lib/db/repository";
import { isRunExecuting } from "@/lib/run-executor";
import { isAnalysisRunning, getAnalysisProgress, getPartialAnalysisKeys } from "@/lib/analysis";
import { RUN_TRANSITIONS } from "@/lib/run-lifecycle";
import { RunStatusBadge } from "@/components/run-status-badge";
import { MissionRunPanel } from "@/components/mission-run-panel";
import { AnalysisSection } from "@/components/analysis-section";
import { SnapshotSection } from "@/components/snapshot-section";
import { AutoRefresh } from "@/components/auto-refresh";
import { ConfirmSubmitButton } from "@/components/confirm-submit-button";
import { RunWorkflowStrip } from "@/components/run-workflow-strip";
import {
  deleteRun,
  executeAllMissions,
  executeWorkItem,
  forceReCollect,
  publishSnapshot,
  resumeRun,
  retryResult,
  runAnalysis,
  resumeAnalysis,
  runAnalysisForSiteMission,
  updateRunStatus,
} from "../actions";

export const dynamic = "force-dynamic";

import { fmtDateTime, fmtSnapshotLabel } from "@/lib/fmt-date";

function formatDate(date: Date | null) {
  return fmtDateTime(date);
}

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
    offerCountRows,
    runGrades,
    runSnapshots,
    siteOptions,
    missionRows,
    runResults,
    [runGroup],
  ] = await Promise.all([
    listOffersForRun(run.id),
    listOfferCountsByMissionForRun(run.id),
    listComplianceGradesForRun(run.id),
    listSnapshotsForRun(run.id),
    getDb()
      .select({ id: sites.id, name: sites.name })
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
  // For multi-group runs (no runGroupId), resolve which groups were combined.
  const resolvedGroups = run.runGroupId ? [] : await resolveRunGroups(run.id);
  const scopeLabel = runGroup
    ? runGroup.name
    : resolvedGroups.length > 0
      ? resolvedGroups.map((g) => g.name).join(" + ")
      : null;
  const siteNames = Object.fromEntries(siteOptions.map((s) => [s.id, s.name]));
  const offerCountsBySiteMission = new Map<string, number>(
    offerCountRows.map((r) => [`${r.siteId}:${r.missionType}`, r.count])
  );
  const nextStatuses = RUN_TRANSITIONS[run.status].filter(
    (s) => !(run.status === "pending" && s === "running")
  );
  const results = new Map(
    runResults.map((r) => [`${r.siteId}:${r.missionId}`, r])
  );
  // "Executing" is the in-memory truth — is a collector actually running for
  // this run right now. Pending/running ROWS with no live executor mean the run
  // was interrupted (e.g. a server restart) and those rows are orphaned; that's
  // "stalled", recoverable via Resume — not "executing" (which would freeze the
  // whole UI behind disabled buttons with nothing to un-freeze it).
  const canCollect = run.status === "pending" || run.status === "running";
  const executing = isRunExecuting(run.id);
  // Total HTML pages captured = total evidence rows the analysis pass will read.
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
  // Any captured pages means HTML snapshots exist — safe proxy without loading evidence.
  const canAnalyze =
    run.status !== "failed" &&
    runResults.some((r) => r.pagesCaptured > 0);

  return (
    <div>
      <AutoRefresh active={executing || analyzing || partialAnalysisKeys.size > 0} />

      {/* Compact title row — stays above the sticky workflow bar */}
      <div className="mb-2 flex items-center justify-between py-2">
        <div className="flex items-center gap-2 text-sm">
          <Link href="/runs" className="text-zinc-700 hover:text-zinc-700">
            ← Runs
          </Link>
          <span className="text-zinc-600">/</span>
          <span className="font-semibold text-zinc-900">
            Run {run.id.slice(0, 8)}
          </span>
          {scopeLabel && (
            <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600">
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
                    : "rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700"
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

      {/* Sticky workflow bar — locks at top immediately on scroll */}
      <RunWorkflowStrip
        runResults={runResults}
        totalWorkItems={missionRows.length}
        offerCount={runOffers.length}
        snapshots={runSnapshots}
        executing={executing}
        stalled={stalled}
        canCollect={canCollect}
        analyzing={analyzing}
        canAnalyze={canAnalyze}
        canPublish={run.status !== "failed"}
        runAnalysisAction={runAnalysis.bind(null, run.id)}
        publishSnapshotAction={publishSnapshot.bind(null, run.id)}
        executeAllAction={executeAllMissions.bind(null, run.id)}
        resumeAction={resumeRun.bind(null, run.id)}
        defaultSnapshotLabel={fmtSnapshotLabel(
          new Date(),
          resolvedGroups.length > 0 ? resolvedGroups.length : 1,
          evidencePageCount
        )}
      />

      {/* One-line metadata — sits below sticky bar, scrolls away */}
      <div className="mb-6 flex items-center gap-4 border-b border-zinc-100 py-2 text-xs text-zinc-700">
        <span className="font-mono">{run.id}</span>
        <span>Created {formatDate(run.createdAt)}</span>
        {run.startedAt && <span>Started {formatDate(run.startedAt)}</span>}
        {run.completedAt && <span>Completed {formatDate(run.completedAt)}</span>}
      </div>

      <div id="collection" className="mb-8">
          <MissionRunPanel
            runId={run.id}
            items={missionRows}
            results={results}
            offerCountsBySiteMission={offerCountsBySiteMission}
            executing={executing}
            canCollect={canCollect}
            stalled={stalled}
            collectionStartedAt={run.startedAt}
            collectionCompletedAt={run.completedAt}
            executeItemAction={executeWorkItem.bind(null, run.id)}
            executeAllAction={executeAllMissions.bind(null, run.id)}
            retryAction={retryResult.bind(null, `/runs/${run.id}`)}
            forceReCollectAction={forceReCollect.bind(null, run.id)}
            reAnalyzeSiteMissionAction={runAnalysisForSiteMission.bind(null, run.id)}
            partialAnalysisKeys={partialAnalysisKeys}
            resumeAction={resumeRun.bind(null, run.id)}
            error={error}
          />
        </div>

      <div id="analysis" className="mb-8">
        <AnalysisSection
          offers={runOffers}
          grades={runGrades}
          siteNames={siteNames}
          siteOptions={siteOptions}
          analyzing={analyzing}
          analysisStartedAt={run.analysisStartedAt}
          analysisCompletedAt={run.analysisCompletedAt}
          evidencePageCount={analysisProgressData?.total ?? evidencePageCount}
          pagesProcessed={analysisProgressData?.processed ?? null}
          runAnalysisAction={runAnalysis.bind(null, run.id)}
          resumeAnalysisAction={resumeAnalysis.bind(null, run.id)}
          canAnalyze={canAnalyze}
        />
      </div>

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
