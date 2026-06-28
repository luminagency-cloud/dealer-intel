import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getReportSnapshot,
  listSnapshotOffers,
  resolveRunGroups,
} from "@/lib/db/repository";
import { SnapshotOffersTable } from "@/components/snapshot-offers-table";
import { ConfirmSubmitButton } from "@/components/confirm-submit-button";
import { deleteSnapshot } from "../actions";
import { fmtDateTime } from "@/lib/fmt-date";

export const dynamic = "force-dynamic";

function formatDate(date: Date | null) {
  return fmtDateTime(date);
}

export default async function SnapshotDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const snapshot = await getReportSnapshot(id);
  if (!snapshot) notFound();

  // runGroupName is stamped at publish time for new snapshots. For older
  // snapshots published before per-group splitting, fall back to resolving
  // group names from the source run's site set.
  let scopeLabel = snapshot.runGroupName;
  if (!scopeLabel) {
    const groups = await resolveRunGroups(snapshot.collectionRunId);
    scopeLabel =
      groups.length > 0 ? groups.map((g) => g.name).join(" + ") : "All sites";
  }

  const offers = await listSnapshotOffers(snapshot.id);
  const gradeCounts = offers.reduce<Record<string, number>>((acc, o) => {
    if (o.complianceGrade) acc[o.complianceGrade] = (acc[o.complianceGrade] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div>
      <div className="mb-6">
        <Link
          href="/snapshots"
          className="text-sm text-zinc-700 hover:underline"
        >
          ← Snapshots
        </Link>
      </div>

      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-zinc-900">
            {scopeLabel}
          </h1>
          <span className="rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-medium text-blue-700">
            Frozen
          </span>
        </div>
        <form action={deleteSnapshot.bind(null, snapshot.id)}>
          <ConfirmSubmitButton
            confirmMessage="Delete this snapshot? Its frozen reporting data is permanently removed. The underlying run and evidence are not touched."
            className="rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50"
          >
            Delete Snapshot
          </ConfirmSubmitButton>
        </form>
      </div>

      <div className="mb-8 overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm">
        <dl className="divide-y divide-zinc-100 text-sm">
          <div className="flex justify-between px-4 py-3">
            <dt className="text-zinc-700">Snapshot ID</dt>
            <dd className="font-mono text-zinc-900">{snapshot.id}</dd>
          </div>
          <div className="flex justify-between px-4 py-3">
            <dt className="text-zinc-700">Source run</dt>
            <dd>
              <Link
                href={`/runs/${snapshot.collectionRunId}`}
                className="font-mono text-zinc-900 hover:underline"
              >
                {snapshot.collectionRunId}
              </Link>
            </dd>
          </div>
          <div className="flex justify-between px-4 py-3">
            <dt className="text-zinc-700">Offers · Sites</dt>
            <dd className="text-zinc-900">
              {snapshot.offerCount} · {snapshot.siteCount}
            </dd>
          </div>
          <div className="flex justify-between px-4 py-3">
            <dt className="text-zinc-700">Approved</dt>
            <dd className="text-zinc-900">{formatDate(snapshot.approvedAt)}</dd>
          </div>
          <div className="flex justify-between px-4 py-3">
            <dt className="text-zinc-700">Approved by</dt>
            <dd className="text-zinc-900">{snapshot.approvedBy}</dd>
          </div>
        </dl>
      </div>

      <div className="rounded-lg border border-zinc-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-zinc-900">
              Frozen Offers{" "}
              <span className="font-normal text-zinc-700">
                — {offers.length}
              </span>
            </h2>
            <p className="mt-0.5 text-xs text-zinc-700">
              A snapshot in time. Re-running analysis on the source run will not
              change these rows.
            </p>
          </div>
          {Object.keys(gradeCounts).length > 0 && (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-zinc-700">Compliance:</span>
              {Object.entries(gradeCounts).map(([grade, count]) => (
                <span
                  key={grade}
                  className="inline-flex rounded-full bg-zinc-100 px-2 py-0.5 font-medium text-zinc-700"
                >
                  {count} {grade}
                </span>
              ))}
            </div>
          )}
        </div>
        <SnapshotOffersTable offers={offers} />
      </div>
    </div>
  );
}
