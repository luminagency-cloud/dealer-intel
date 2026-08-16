import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ensureShareToken,
  getReportSnapshot,
  listSnapshotsForGroup,
  setSnapshotClientVisible,
} from "@/lib/db/repository";
import { CopyLinkButton } from "@/components/copy-link-button";
import { fmtDateTime } from "@/lib/fmt-date";

export const dynamic = "force-dynamic";

function getPublicViewerOrigin(): {
  origin?: string;
  unavailableLabel?: string;
} {
  const raw = process.env.VIEWER_PUBLIC_URL;
  if (!raw) return { unavailableLabel: "Set public report URL" };

  const trimmed = raw.trim().replace(/\s+#.*$/, "").replace(/\/+$/, "");
  if (!trimmed) return { unavailableLabel: "Set public report URL" };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { unavailableLabel: "Fix public report URL" };
  }

  if (["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
    return { unavailableLabel: "Use non-local report URL" };
  }

  return { origin: url.origin };
}

/**
 * Admin's own view of a report is management-only now — the offer grids,
 * KPIs, and narrative live in the viewer app (the same rendering customers
 * see), reached via "View Report ↗". Admin used to render its own copy of
 * that content, which had already drifted from viewer's (see
 * Docs/Analysis Pipeline Redesign.md's architecture-review candidate B).
 */
export default async function AdminReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const snapshot = await getReportSnapshot(id);
  if (!snapshot) notFound();
  const snapshotId = snapshot.id;

  const groupSnapshots = snapshot.runGroupId
    ? await listSnapshotsForGroup(snapshot.runGroupId)
    : [snapshot];

  // Build the public shareable link from the snapshot's token. Do not fall
  // back to the admin request origin: locally that would copy localhost, which
  // is not shareable.
  const viewerOrigin = getPublicViewerOrigin();
  let shareToken = snapshot.shareToken;
  if (!snapshot.clientVisible) {
    await setSnapshotClientVisible(snapshotId, true);
  }
  if (!shareToken) {
    shareToken = await ensureShareToken(snapshotId);
  }

  const shareUrl = shareToken && viewerOrigin.origin
    ? `${viewerOrigin.origin}/r/${shareToken}`
    : undefined;
  const shareUrlUnavailableLabel = shareToken
    ? viewerOrigin.unavailableLabel
    : "Share link unavailable";

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4">
        <Link href="/reports" className="text-sm text-zinc-700 hover:underline dark:text-zinc-200">
          ← Reports
        </Link>
      </div>

      <div className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
          {snapshot.label || `Snapshot ${snapshot.id.slice(0, 8)}`}
        </h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Published {fmtDateTime(snapshot.approvedAt)} · {snapshot.offerCount} offers ·{" "}
          {snapshot.siteCount} sites
        </p>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <a
            href={shareUrl}
            target="_blank"
            rel="noreferrer"
            aria-disabled={!shareUrl}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-500 aria-disabled:pointer-events-none aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
          >
            View Report ↗
          </a>
          <CopyLinkButton shareUrl={shareUrl} unavailableLabel={shareUrlUnavailableLabel} />
          <a
            href={`/reports/${snapshot.id}/export`}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
          >
            Export CSV
          </a>
        </div>
      </div>

      {groupSnapshots.length > 1 && (
        <section className="mt-8">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Snapshot History
          </h2>
          <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-xs font-medium uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                  <th className="px-4 py-2">Published</th>
                  <th className="px-4 py-2">Report</th>
                  <th className="px-4 py-2 text-right">Offers</th>
                  <th className="px-4 py-2 text-right">Sites</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                {groupSnapshots.map((s) => (
                  <tr key={s.id} className={s.id === snapshot.id ? "bg-blue-50/50 dark:bg-blue-950/30" : ""}>
                    <td className="px-4 py-2.5 font-medium text-zinc-900 dark:text-zinc-50">
                      {fmtDateTime(s.approvedAt)}
                    </td>
                    <td className="px-4 py-2.5">
                      {s.id === snapshot.id ? (
                        <span className="font-medium text-zinc-900 dark:text-zinc-50">
                          {s.label || "This report"} (current)
                        </span>
                      ) : (
                        <Link href={`/reports/${s.id}`} className="text-blue-600 hover:underline dark:text-blue-400">
                          {s.label || `Snapshot ${s.id.slice(0, 8)}`}
                        </Link>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right text-zinc-900 dark:text-zinc-50">{s.offerCount}</td>
                    <td className="px-4 py-2.5 text-right text-zinc-900 dark:text-zinc-50">{s.siteCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
