import Link from "next/link";
import { isDatabaseConfigured } from "@/lib/db";
import { listReportSnapshots } from "@/lib/db/repository";
import { DbNotConfigured } from "@/components/db-not-configured";
import { fmtDateTime } from "@/lib/fmt-date";
import { rebuildReport } from "./actions";

export const dynamic = "force-dynamic";

function formatDate(date: Date | null) {
  return fmtDateTime(date);
}

/** Phase 11 reporting landing: every published snapshot is a report. Reports
 *  read ONLY frozen snapshot data — no collection, no analysis, no site
 *  access. */
export default async function ReportsPage() {
  if (!isDatabaseConfigured()) {
    return (
      <div>
        <h1 className="mb-6 text-xl font-semibold text-zinc-900">Reports</h1>
        <DbNotConfigured />
      </div>
    );
  }

  const snapshots = await listReportSnapshots();

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-zinc-900">Reports</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Competitive offer reports, each built from one published snapshot.
          Pure reads of frozen data — publish a snapshot from an analyzed run to
          create one.
        </p>
      </div>

      {snapshots.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-300 bg-white p-8 text-center text-sm text-zinc-500">
          No reports yet. Publish a snapshot from a run, then open it here as a
          report.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-3">Report</th>
                <th className="px-4 py-3">Scope</th>
                <th className="px-4 py-3 text-right">Offers</th>
                <th className="px-4 py-3 text-right">Sites</th>
                <th className="px-4 py-3">Published</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {snapshots.map((snap) => (
                <tr key={snap.id}>
                  <td className="px-4 py-3 font-medium text-zinc-900">
                    {snap.label || `Snapshot ${snap.id.slice(0, 8)}`}
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
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-4">
                      <form action={rebuildReport.bind(null, snap.id)}>
                        <button
                          type="submit"
                          className="text-sm text-zinc-400 hover:text-zinc-700"
                        >
                          Rebuild
                        </button>
                      </form>
                      <Link
                        href={`/reports/${snap.id}`}
                        className="font-medium text-blue-600 hover:underline"
                      >
                        Open report →
                      </Link>
                    </div>
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
