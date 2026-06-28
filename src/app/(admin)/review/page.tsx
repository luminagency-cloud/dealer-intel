import Link from "next/link";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import {
  MISSION_TYPE_LABELS,
  MISSION_RESULT_STATUS_LABELS,
  getDb,
  collectionRuns,
  missionResults,
  missions,
  sites,
  type MissionResultStatus,
} from "@/lib/db";
import { MissionStatusBadge } from "@/components/mission-status-badge";
import { AutoRefresh } from "@/components/auto-refresh";
import { ConfirmSubmitButton } from "@/components/confirm-submit-button";
import { resolveContentRemoved, retryResult } from "../runs/actions";
import { deleteSelectedResults } from "./actions";

export const dynamic = "force-dynamic";

const OPEN_STATUSES: MissionResultStatus[] = [
  "needs_review",
  "failure",
  "not_found",
];

/** Phase 7 review queue + failure dashboard: every unresolved collection
 *  issue on unpublished runs, with the tools to fix it without code. */
export default async function ReviewPage() {
  const rows = await getDb()
    .select({
      result: missionResults,
      run: collectionRuns,
      site: sites,
      mission: missions,
    })
    .from(missionResults)
    .innerJoin(
      collectionRuns,
      eq(missionResults.collectionRunId, collectionRuns.id)
    )
    .innerJoin(sites, eq(missionResults.siteId, sites.id))
    .leftJoin(missions, eq(missionResults.missionId, missions.id))
    .where(
      and(
        inArray(missionResults.status, OPEN_STATUSES),
        ne(collectionRuns.status, "complete")
      )
    )
    .orderBy(desc(missionResults.completedAt));

  const counts = Object.fromEntries(
    OPEN_STATUSES.map((s) => [
      s,
      rows.filter((r) => r.result.status === s).length,
    ])
  ) as Record<MissionResultStatus, number>;

  // Queued/running retries on open runs — drives the "still working" banner and
  // live refresh. Retried items leave the queue above (they go back to pending)
  // and reappear here only if they fail again.
  const inProgress = await getDb()
    .select({ id: missionResults.id })
    .from(missionResults)
    .innerJoin(
      collectionRuns,
      eq(missionResults.collectionRunId, collectionRuns.id)
    )
    .where(
      and(
        inArray(missionResults.status, ["pending", "running"]),
        ne(collectionRuns.status, "complete")
      )
    );
  const inProgressCount = inProgress.length;

  return (
    <div>
      <AutoRefresh active={inProgressCount > 0} />
      {inProgressCount > 0 && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-blue-500" />
          Re-collecting {inProgressCount} queued item
          {inProgressCount === 1 ? "" : "s"}… this page refreshes as they finish.
        </div>
      )}
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-zinc-900">Review Queue</h1>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-3 text-sm text-zinc-600">
            {OPEN_STATUSES.map((status) => (
              <span key={status}>
                {MISSION_RESULT_STATUS_LABELS[status]}:{" "}
                <span className="font-semibold text-zinc-900">
                  {counts[status]}
                </span>
              </span>
            ))}
          </div>
          {rows.length > 0 && (
            <form id="bulk-delete" action={deleteSelectedResults}>
              <ConfirmSubmitButton
                confirmMessage="Delete the selected items? Their evidence files are also removed."
                className="rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50"
              >
                Delete Selected
              </ConfirmSubmitButton>
            </form>
          )}
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-300 bg-white p-8 text-center text-sm text-zinc-700">
          Nothing needs review — all collections on open runs succeeded.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-700">
              <tr>
                <th className="px-4 py-3 text-center">Del</th>
                <th className="px-4 py-3">Site</th>
                <th className="px-4 py-3">Mission</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Problem</th>
                <th className="px-4 py-3">Run</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {rows.map(({ result, run, site, mission }) => (
                <tr key={result.id}>
                  <td className="px-4 py-3 text-center">
                    <input
                      type="checkbox"
                      name="resultIds"
                      value={result.id}
                      form="bulk-delete"
                      aria-label={`Select ${site.name} for deletion`}
                      className="h-4 w-4 rounded border-zinc-300 text-red-600 focus:ring-red-500"
                    />
                  </td>
                  <td className="px-4 py-3 font-medium text-zinc-900">
                    {site.name}
                  </td>
                  <td className="px-4 py-3 text-zinc-900">
                    {mission?.name ?? MISSION_TYPE_LABELS[result.missionType]}
                  </td>
                  <td className="px-4 py-3">
                    <MissionStatusBadge status={result.status} />
                  </td>
                  <td className="max-w-sm truncate px-4 py-3 text-xs text-zinc-700">
                    {result.error ??
                      (result.status === "needs_review"
                        ? `Captured ${result.pagesCaptured} page(s); some configured pages failed`
                        : "—")}
                  </td>
                  <td className="px-4 py-3 text-zinc-600">
                    <Link
                      href={`/runs/${run.id}`}
                      className="hover:underline"
                      title={run.id}
                    >
                      {run.id.slice(0, 8)}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3 text-sm">
                      <form action={retryResult.bind(null, "/review", result.id)}>
                        <button
                          type="submit"
                          className="text-zinc-900 underline hover:text-zinc-600"
                        >
                          Retry
                        </button>
                      </form>
                      <Link
                        href={`/dealers/${site.id}/edit`}
                        className="text-zinc-600 hover:underline"
                      >
                        Fix URL
                      </Link>
                      <form
                        action={resolveContentRemoved.bind(
                          null,
                          "/review",
                          result.id
                        )}
                      >
                        <button
                          type="submit"
                          className="text-zinc-600 hover:underline"
                          title="The content is genuinely gone from the site"
                        >
                          Content Removed
                        </button>
                      </form>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-4 text-xs text-zinc-700">
        Retry re-collects the mission immediately. Fix URL opens the mission
        to update its target pages. Content Removed resolves the item when
        the page is genuinely gone.
      </p>
    </div>
  );
}
