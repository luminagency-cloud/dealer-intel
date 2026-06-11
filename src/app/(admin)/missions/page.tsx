import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import {
  getDb,
  isDatabaseConfigured,
  MISSION_TYPE_LABELS,
  missions,
  sites,
} from "@/lib/db";
import { DbNotConfigured } from "@/components/db-not-configured";
import { setMissionActive } from "./actions";

export const dynamic = "force-dynamic";

export default async function MissionsPage() {
  if (!isDatabaseConfigured()) {
    return (
      <div>
        <h1 className="mb-6 text-xl font-semibold text-zinc-900">Missions</h1>
        <DbNotConfigured />
      </div>
    );
  }

  const rows = await getDb()
    .select({ mission: missions, siteName: sites.name })
    .from(missions)
    .innerJoin(sites, eq(missions.siteId, sites.id))
    .orderBy(asc(sites.name), asc(missions.missionType));

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-zinc-900">Missions</h1>
        <Link
          href="/missions/new"
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700"
        >
          Add Mission
        </Link>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-300 bg-white p-8 text-center text-sm text-zinc-500">
          No missions yet. A mission defines what to collect from a site, e.g.
          Homepage Offers.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-3">Site</th>
                <th className="px-4 py-3">Mission</th>
                <th className="px-4 py-3">Last Known URL</th>
                <th className="px-4 py-3">Success Rate</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {rows.map(({ mission, siteName }) => (
                <tr
                  key={mission.id}
                  className={mission.active ? "" : "opacity-60"}
                >
                  <td className="px-4 py-3 font-medium text-zinc-900">
                    {siteName}
                  </td>
                  <td className="px-4 py-3 text-zinc-600">
                    {MISSION_TYPE_LABELS[mission.missionType]}
                  </td>
                  <td className="max-w-xs truncate px-4 py-3 text-zinc-600">
                    {mission.lastKnownUrl ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-zinc-600">
                    {mission.successRate != null
                      ? `${Math.round(mission.successRate * 100)}%`
                      : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                        mission.active
                          ? "bg-green-100 text-green-800"
                          : "bg-zinc-100 text-zinc-600"
                      }`}
                    >
                      {mission.active ? "Active" : "Disabled"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-3">
                      <Link
                        href={`/missions/${mission.id}/edit`}
                        className="text-zinc-700 hover:underline"
                      >
                        Edit
                      </Link>
                      <form
                        action={setMissionActive.bind(
                          null,
                          mission.id,
                          !mission.active
                        )}
                      >
                        <button
                          type="submit"
                          className="text-zinc-700 hover:underline"
                        >
                          {mission.active ? "Disable" : "Enable"}
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
    </div>
  );
}
