import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import {
  RUN_STATUS_LABELS,
  collectionRunSites,
  getDb,
  runGroups,
  sites,
} from "@/lib/db";
import {
  getCollectionRun,
  listComplianceGradesForRun,
  listEvidenceForRun,
  listOffersForRun,
  listResultsForRun,
  listSnapshotsForRun,
  listWorkItemsForRun,
} from "@/lib/db/repository";
import { isRunExecuting } from "@/lib/run-executor";
import { isAnalysisRunning } from "@/lib/analysis";
import { RUN_TRANSITIONS } from "@/lib/run-lifecycle";
import { RunStatusBadge } from "@/components/run-status-badge";
import { EvidenceSection } from "@/components/evidence-section";
import { MissionRunPanel } from "@/components/mission-run-panel";
import { AnalysisSection } from "@/components/analysis-section";
import { SnapshotSection } from "@/components/snapshot-section";
import { AutoRefresh } from "@/components/auto-refresh";
import { ConfirmSubmitButton } from "@/components/confirm-submit-button";
import {
  deleteRun,
  deleteRunEvidence,
  executeAllMissions,
  executeWorkItem,
  publishSnapshot,
  resumeRun,
  retryResult,
  runAnalysis,
  updateRunStatus,
  uploadRunEvidence,
} from "../actions";

export const dynamic = "force-dynamic";

function formatDate(date: Date | null) {
  return date ? date.toLocaleString() : "—";
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
    runEvidence,
    runOffers,
    runGrades,
    runSnapshots,
    siteOptions,
    missionRows,
    runResults,
    [runGroup],
  ] = await Promise.all([
    listEvidenceForRun(run.id),
    listOffersForRun(run.id),
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
  const adHocSiteIds = run.runGroupId
    ? []
    : (
        await getDb()
          .select({ siteId: collectionRunSites.siteId })
          .from(collectionRunSites)
          .where(eq(collectionRunSites.collectionRunId, run.id))
      ).map((r) => r.siteId);
  const scopeLabel = runGroup
    ? runGroup.name
    : adHocSiteIds.length > 0
      ? adHocSiteIds
          .map((id) => siteOptions.find((s) => s.id === id)?.name ?? "?")
          .join(", ")
      : null;
  const siteNames = Object.fromEntries(siteOptions.map((s) => [s.id, s.name]));
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
  const executing = isRunExecuting(run.id);
  const stalled =
    !executing &&
    runResults.some((r) => r.status === "pending" || r.status === "running");
  const analyzing = isAnalysisRunning(run.id);
  // Analysis needs captured HTML evidence; offer it once anything's collected.
  const canAnalyze =
    run.status !== "failed" &&
    runEvidence.some((e) => e.evidenceType === "html_snapshot");

  return (
    <div>
      <AutoRefresh active={executing || analyzing} />
      <div className="mb-6">
        <Link href="/runs" className="text-sm text-zinc-500 hover:underline">
          ← Runs
        </Link>
      </div>

      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-zinc-900">
            Run {run.id.slice(0, 8)}
          </h1>
          {scopeLabel && (
            <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-700">
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
                {status === "failed"
                  ? "Mark Failed"
                  : `Move to ${RUN_STATUS_LABELS[status]}`}
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

      <div className="mb-8 overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm">
        <dl className="divide-y divide-zinc-100 text-sm">
          <div className="flex justify-between px-4 py-3">
            <dt className="text-zinc-500">Run ID</dt>
            <dd className="font-mono text-zinc-900">{run.id}</dd>
          </div>
          <div className="flex justify-between px-4 py-3">
            <dt className="text-zinc-500">Created</dt>
            <dd className="text-zinc-900">{formatDate(run.createdAt)}</dd>
          </div>
          <div className="flex justify-between px-4 py-3">
            <dt className="text-zinc-500">Started</dt>
            <dd className="text-zinc-900">{formatDate(run.startedAt)}</dd>
          </div>
          <div className="flex justify-between px-4 py-3">
            <dt className="text-zinc-500">Completed</dt>
            <dd className="text-zinc-900">{formatDate(run.completedAt)}</dd>
          </div>
        </dl>
      </div>

      {run.status !== "published" && run.status !== "failed" && (
        <div className="mb-8">
          <MissionRunPanel
            items={missionRows}
            results={results}
            executing={executing}
            stalled={stalled}
            executeItemAction={executeWorkItem.bind(null, run.id)}
            executeAllAction={executeAllMissions.bind(null, run.id)}
            retryAction={retryResult.bind(null, `/runs/${run.id}`)}
            resumeAction={resumeRun.bind(null, run.id)}
            error={error}
          />
        </div>
      )}

      <div className="mb-8">
        <EvidenceSection
          evidence={runEvidence}
          siteOptions={siteOptions}
          siteNames={siteNames}
          uploadAction={uploadRunEvidence.bind(null, run.id)}
          deleteAction={deleteRunEvidence.bind(null, run.id)}
          canUpload={run.status !== "published"}
        />
      </div>

      <div className="mb-8">
        <AnalysisSection
          offers={runOffers}
          grades={runGrades}
          siteNames={siteNames}
          analyzing={analyzing}
          runAnalysisAction={runAnalysis.bind(null, run.id)}
          canAnalyze={canAnalyze}
        />
      </div>

      <div className="mb-8">
        <SnapshotSection
          snapshots={runSnapshots}
          canPublish={run.status !== "failed"}
          hasOffers={runOffers.length > 0}
          publishAction={publishSnapshot.bind(null, run.id)}
          defaultLabel={
            scopeLabel
              ? `${scopeLabel} · ${new Date().toLocaleString("en-US", { month: "short", year: "numeric" })}`
              : undefined
          }
        />
      </div>
    </div>
  );
}
