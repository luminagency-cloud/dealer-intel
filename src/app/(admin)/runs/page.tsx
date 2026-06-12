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
import { createRun } from "./actions";

export const dynamic = "force-dynamic";

function formatDate(date: Date | null) {
  return date ? date.toLocaleString() : "—";
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
        <p className="rounded-lg border border-dashed border-zinc-300 bg-white p-8 text-center text-sm text-zinc-500">
          No runs yet. Create the first collection run.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-3">Run</th>
                <th className="px-4 py-3">Scope</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Created</th>
                <th className="px-4 py-3">Started</th>
                <th className="px-4 py-3">Completed</th>
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
                  <td className="max-w-56 truncate px-4 py-3 text-zinc-600">
                    {run.runGroupId
                      ? groupNames[run.runGroupId] ?? "(deleted group)"
                      : adHocNames.has(run.id)
                        ? adHocNames.get(run.id)!.join(", ")
                        : "All sites"}
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-4 text-xs text-zinc-400">
        Statuses: {Object.values(RUN_STATUS_LABELS).join(" · ")}. Pick a run
        group to collect just that group&apos;s sites.
      </p>
    </div>
  );
}
