import Link from "next/link";
import type { ReportSnapshot } from "@/lib/db";

function formatDate(date: Date | null) {
  return date ? date.toLocaleString() : "—";
}

/** Phase 10 run-page panel: publish the run's current analysis output as a
 *  frozen reporting snapshot, and list the snapshots already cut from it. */
export function SnapshotSection({
  snapshots,
  canPublish,
  hasOffers,
  publishAction,
}: {
  snapshots: ReportSnapshot[];
  canPublish: boolean;
  hasOffers: boolean;
  publishAction: (formData: FormData) => Promise<void>;
}) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white shadow-sm">
      <div className="border-b border-zinc-100 px-4 py-3">
        <h2 className="text-sm font-semibold text-zinc-900">
          Snapshots{" "}
          {snapshots.length > 0 && (
            <span className="font-normal text-zinc-500">
              — {snapshots.length}
            </span>
          )}
        </h2>
        <p className="mt-0.5 text-xs text-zinc-500">
          Freeze this run&apos;s analyzed offers into an immutable reporting
          input. Reports read snapshots only, never the live run.
        </p>
      </div>

      {canPublish && (
        <form
          action={publishAction}
          className="flex items-center gap-2 border-b border-zinc-100 px-4 py-3"
        >
          <input
            type="text"
            name="label"
            placeholder="Optional label (e.g. Week of Jun 9)"
            className="flex-1 rounded-md border border-zinc-300 px-3 py-1.5 text-sm focus:border-zinc-400 focus:outline-none"
          />
          <button
            type="submit"
            disabled={!hasOffers}
            title={
              hasOffers ? undefined : "Run analysis first — no offers to publish"
            }
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Publish Snapshot
          </button>
        </form>
      )}

      {snapshots.length === 0 ? (
        <p className="px-4 py-6 text-sm text-zinc-500">
          No snapshots published from this run yet.
        </p>
      ) : (
        <ul className="divide-y divide-zinc-100">
          {snapshots.map((snap) => (
            <li
              key={snap.id}
              className="flex items-center justify-between px-4 py-3 text-sm"
            >
              <Link
                href={`/snapshots/${snap.id}`}
                className="font-medium text-zinc-900 hover:underline"
              >
                {snap.label || `Snapshot ${snap.id.slice(0, 8)}`}
              </Link>
              <span className="text-xs text-zinc-500">
                {snap.offerCount} offers · {snap.siteCount} sites ·{" "}
                {formatDate(snap.approvedAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
