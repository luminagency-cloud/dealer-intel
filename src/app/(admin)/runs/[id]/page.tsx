import Link from "next/link";
import { notFound } from "next/navigation";
import { RUN_STATUS_LABELS } from "@/lib/db";
import {
  getCollectionRun,
  listEvidenceForRun,
  listOffersForRun,
} from "@/lib/db/repository";
import { RUN_TRANSITIONS } from "@/lib/run-lifecycle";
import { RunStatusBadge } from "@/components/run-status-badge";
import { updateRunStatus } from "../actions";

export const dynamic = "force-dynamic";

function formatDate(date: Date | null) {
  return date ? date.toLocaleString() : "—";
}

export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const run = await getCollectionRun(id);
  if (!run) notFound();

  const [runEvidence, runOffers] = await Promise.all([
    listEvidenceForRun(run.id),
    listOffersForRun(run.id),
  ]);
  const nextStatuses = RUN_TRANSITIONS[run.status];

  return (
    <div>
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
          <RunStatusBadge status={run.status} />
        </div>
        {nextStatuses.length > 0 && (
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
          </div>
        )}
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

      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
          <h2 className="text-sm font-semibold text-zinc-900">Evidence</h2>
          <p className="mt-1 text-2xl font-semibold text-zinc-900">
            {runEvidence.length}
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            Captured screenshots and HTML snapshots. Evidence services arrive
            in Phase 4.
          </p>
        </div>
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
