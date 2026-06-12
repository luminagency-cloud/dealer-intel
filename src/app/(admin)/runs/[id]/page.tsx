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
  listEvidenceForRun,
  listOffersForRun,
  listResultsForRun,
  listWorkItemsForRun,
} from "@/lib/db/repository";
import { isRunExecuting } from "@/lib/run-executor";
import { RUN_TRANSITIONS } from "@/lib/run-lifecycle";
import { RunStatusBadge } from "@/components/run-status-badge";
import { EvidenceSection } from "@/components/evidence-section";
import { MissionRunPanel } from "@/components/mission-run-panel";
import { AutoRefresh } from "@/components/auto-refresh";
import { ConfirmSubmitButton } from "@/components/confirm-submit-button";
import {
  deleteRun,
  deleteRunEvidence,
  executeAllMissions,
  executeWorkItem,
  retryResult,
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
    siteOptions,
    missionRows,
    runResults,
    [runGroup],
  ] = await Promise.all([
    listEvidenceForRun(run.id),
    listOffersForRun(run.id),
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
  const executing =
    isRunExecuting(run.id) ||
    runResults.some((r) => r.status === "pending" || r.status === "running");

  return (
    <div>
      <AutoRefresh active={executing} />
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
            executeItemAction={executeWorkItem.bind(null, run.id)}
            executeAllAction={executeAllMissions.bind(null, run.id)}
            retryAction={retryResult.bind(null, `/runs/${run.id}`)}
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

      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
          <h2 className="text-sm font-semibold text-zinc-900">Offers</h2>
          <p className="mt-1 text-2xl font-semibold text-zinc-900">
            {runOffers.length}
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            Normalized offer records. Offer discovery arrives in Phase 9.
          </p>
        </div>
      </div>
    </div>
  );
}
