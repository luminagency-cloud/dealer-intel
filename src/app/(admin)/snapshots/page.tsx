import Link from "next/link";
import { isDatabaseConfigured } from "@/lib/db";
import { listReportSnapshots } from "@/lib/db/repository";
import { DbNotConfigured } from "@/components/db-not-configured";

export const dynamic = "force-dynamic";

function formatDate(date: Date | null) {
  return date ? date.toLocaleString() : "—";
}

export default async function SnapshotsPage() {
  if (!isDatabaseConfigured()) {
    return (
      <div>
        <h1 className="mb-6 text-xl font-semibold text-zinc-900">Snapshots</h1>
        <DbNotConfigured />
      </div>
    );
  }

  const snapshots = await listReportSnapshots();

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-zinc-900">Snapshots</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Published, frozen analysis datasets — the only inputs reporting reads.
          Create one with <span className="font-medium">Publish Snapshot</span>{" "}
          on an analyzed run.
        </p>
      </div>

      {snapshots.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-300 bg-white p-8 text-center text-sm text-zinc-500">
          No snapshots yet. Run analysis on a run, then publish a snapshot from
          its page.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-3">Snapshot</th>
                <th className="px-4 py-3">Scope</th>
                <th className="px-4 py-3 text-right">Offers</th>
                <th className="px-4 py-3 text-right">Sites</th>
                <th className="px-4 py-3">Approved</th>
                <th className="px-4 py-3">By</th>
                <th className="px-4 py-3">Run</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {snapshots.map((snap) => (
                <tr key={snap.id}>
                  <td className="px-4 py-3 font-medium text-zinc-900">
                    <Link
                      href={`/snapshots/${snap.id}`}
                      className="hover:underline"
                      title={snap.id}
                    >
                      {snap.label || snap.id.slice(0, 8)}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-zinc-600">
                    {snap.runGroupName || "All sites"}
                  </td>
                  <td className="px-4 py-3 text-right text-zinc-700">
                    {snap.offerCount}
                  </td>
                  <td className="px-4 py-3 text-right text-zinc-700">
                    {snap.siteCount}
                  </td>
                  <td className="px-4 py-3 text-zinc-600">
                    {formatDate(snap.approvedAt)}
                  </td>
                  <td className="px-4 py-3 text-zinc-600">{snap.approvedBy}</td>
                  <td className="px-4 py-3 text-zinc-600">
                    <Link
                      href={`/runs/${snap.collectionRunId}`}
                      className="font-mono text-xs hover:underline"
                    >
                      {snap.collectionRunId.slice(0, 8)}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
