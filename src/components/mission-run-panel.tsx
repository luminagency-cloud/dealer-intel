import Link from "next/link";
import { MISSION_TYPE_LABELS, type Mission, type Site } from "@/lib/db";

/** Mission-driven collection (Phase 6): execute one mission or all of them
 *  against this run. Each mission captures all of its configured URLs. */
export function MissionRunPanel({
  missionRows,
  executeMissionAction,
  executeAllAction,
  summary,
}: {
  missionRows: { mission: Mission; site: Site }[];
  executeMissionAction: (missionId: string) => Promise<void>;
  executeAllAction: () => Promise<void>;
  summary?: { ok?: string; failed?: string; pages?: string; error?: string };
}) {
  const hasSummary =
    summary && (summary.ok !== undefined || summary.error !== undefined);

  return (
    <div className="rounded-lg border border-zinc-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-zinc-900">Missions</h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            Executes each mission&apos;s configured URLs (or discovers one),
            explores carousels/tabs/accordions, and stores the evidence.
            Roughly a minute per page.
          </p>
        </div>
        {missionRows.length > 0 && (
          <form action={executeAllAction}>
            <button
              type="submit"
              className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700"
            >
              Run All Missions
            </button>
          </form>
        )}
      </div>

      {hasSummary && (
        <div className="mx-4 mt-3 space-y-2">
          {summary.ok !== undefined && (
            <p
              className={`rounded-md px-3 py-2 text-sm ${
                summary.failed !== "0"
                  ? "bg-amber-50 text-amber-800"
                  : "bg-green-50 text-green-700"
              }`}
            >
              {summary.ok} mission(s) succeeded, {summary.failed} failed —{" "}
              {summary.pages} page(s) captured.
            </p>
          )}
          {summary.error && (
            <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
              {summary.error}
            </p>
          )}
        </div>
      )}

      {missionRows.length === 0 ? (
        <p className="px-4 py-6 text-sm text-zinc-500">
          No active missions.{" "}
          <Link href="/missions/new" className="underline">
            Create one
          </Link>{" "}
          to start collecting.
        </p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-100 text-xs uppercase tracking-wide text-zinc-500">
              <th className="px-4 py-2 font-medium">Site</th>
              <th className="px-4 py-2 font-medium">Mission</th>
              <th className="px-4 py-2 font-medium">Pages</th>
              <th className="px-4 py-2 font-medium">Last Success</th>
              <th className="px-4 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {missionRows.map(({ mission, site }) => {
              const urlCount =
                (mission.lastKnownUrl ? 1 : 0) +
                (mission.alternateUrls?.length ?? 0);
              return (
                <tr key={mission.id}>
                  <td className="px-4 py-3 text-zinc-900">{site.name}</td>
                  <td className="px-4 py-3 text-zinc-900">
                    {MISSION_TYPE_LABELS[mission.missionType]}
                  </td>
                  <td className="px-4 py-3 text-zinc-600">
                    {urlCount > 0 ? urlCount : "discover"}
                  </td>
                  <td className="px-4 py-3 text-zinc-600">
                    {mission.lastSuccessAt
                      ? mission.lastSuccessAt.toLocaleString()
                      : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <form action={executeMissionAction.bind(null, mission.id)}>
                      <button
                        type="submit"
                        className="rounded-md border border-zinc-300 px-2.5 py-1 text-sm text-zinc-700 hover:bg-zinc-50"
                      >
                        Collect
                      </button>
                    </form>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
