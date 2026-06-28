import Link from "next/link";
import { asc } from "drizzle-orm";
import { eq } from "drizzle-orm";
import {
  RUN_STATUS_LABELS,
  collectionRunSites,
  getDb,
  isDatabaseConfigured,
  missions,
  runGroups,
  sites,
} from "@/lib/db";
import { RunScopePicker } from "@/components/run-scope-picker";
import { listCollectionRuns } from "@/lib/db/repository";
import { DbNotConfigured } from "@/components/db-not-configured";
import { RunStatusBadge } from "@/components/run-status-badge";
import { ConfirmSubmitButton } from "@/components/confirm-submit-button";
import { createRun, deleteSelectedRuns } from "./actions";
import { fmtDateTime } from "@/lib/fmt-date";
import { getISOWeekLabel } from "@/lib/cycle";

export const dynamic = "force-dynamic";

function formatDate(date: Date | null) {
  return fmtDateTime(date);
}

export default async function RunsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  if (!isDatabaseConfigured()) {
    return (
      <div>
        <h1 className="mb-6 text-xl font-semibold text-zinc-900">Runs</h1>
        <DbNotConfigured />
      </div>
    );
  }

  const [runs, groups, allSites, adHocRows, activeMissions] =
    await Promise.all([
      listCollectionRuns(),
      getDb().select().from(runGroups).orderBy(asc(runGroups.name)),
      getDb()
        .select({ id: sites.id, name: sites.name, active: sites.active })
        .from(sites)
        .orderBy(asc(sites.name)),
      getDb()
        .select({
          runId: collectionRunSites.collectionRunId,
          siteId: collectionRunSites.siteId,
        })
        .from(collectionRunSites),
      getDb()
        .select({ id: missions.id, name: missions.name })
        .from(missions)
        .where(eq(missions.active, true))
        .orderBy(asc(missions.name)),
    ]);
  const groupNames = Object.fromEntries(groups.map((g) => [g.id, g.name]));
  const siteNames = Object.fromEntries(allSites.map((s) => [s.id, s.name]));
  const activeSites = allSites.filter((s) => s.active);
  const adHocNames = new Map<string, string[]>();
  for (const row of adHocRows) {
    const list = adHocNames.get(row.runId) ?? [];
    list.push(siteNames[row.siteId] ?? "?");
    adHocNames.set(row.runId, list);
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-zinc-900">Runs</h1>
        <form action={createRun} className="flex items-center gap-2">
          <RunScopePicker
            groups={groups.map((g) => ({ id: g.id, name: g.name }))}
            sites={activeSites.map((s) => ({ id: s.id, name: s.name }))}
            missions={activeMissions}
            defaultCycle={getISOWeekLabel()}
          />
          <button
            type="submit"
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700"
          >
            New Run
          </button>
        </form>
      </div>

      {error && (
        <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {runs.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-300 bg-white p-8 text-center text-sm text-zinc-700">
          No runs yet. Create the first collection run.
        </p>
      ) : (
        <form action={deleteSelectedRuns}>
          <div className="mb-3 flex justify-end">
            <ConfirmSubmitButton
              confirmMessage="Delete the selected runs? Their evidence (including files in R2), results, and offers are permanently removed."
              className="rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50"
            >
              Delete Selected
            </ConfirmSubmitButton>
          </div>
          <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-700">
                <tr>
                  <th className="px-4 py-3">Run</th>
                  <th className="px-4 py-3">Cycle</th>
                  <th className="px-4 py-3">Scope</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Created</th>
                  <th className="px-4 py-3">Started</th>
                  <th className="px-4 py-3">Completed</th>
                  <th className="px-4 py-3 text-center">Delete</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {runs.map((run) => (
                  <tr key={run.id}>
                    <td className="px-4 py-3 font-medium text-zinc-900">
                      <Link
                        href={`/runs/${run.id}`}
                        className="hover:underline"
                        title={run.id}
                      >
                        {run.id.slice(0, 8)}
                      </Link>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-zinc-700">
                      {run.cycle ?? "—"}
                    </td>
                    <td className="max-w-56 truncate px-4 py-3 text-zinc-600">
                      {run.runGroupId
                        ? groupNames[run.runGroupId] ?? "(deleted group)"
                        : adHocNames.has(run.id)
                          ? adHocNames.get(run.id)!.join(", ")
                          : "All groups"}
                    </td>
                    <td className="px-4 py-3">
                      <RunStatusBadge status={run.status} />
                    </td>
                    <td className="px-4 py-3 text-zinc-600">
                      {formatDate(run.createdAt)}
                    </td>
                    <td className="px-4 py-3 text-zinc-600">
                      {formatDate(run.startedAt)}
                    </td>
                    <td className="px-4 py-3 text-zinc-600">
                      {formatDate(run.completedAt)}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <input
                        type="checkbox"
                        name="runIds"
                        value={run.id}
                        aria-label={`Select run ${run.id.slice(0, 8)} for deletion`}
                        className="h-4 w-4 rounded border-zinc-300 text-red-600 focus:ring-red-500"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </form>
      )}
      <p className="mt-4 text-xs text-zinc-700">
        Statuses: {Object.values(RUN_STATUS_LABELS).join(" · ")}. Scope: all
        groups, one or more specific groups, or a custom dealer selection.
      </p>
    </div>
  );
}
