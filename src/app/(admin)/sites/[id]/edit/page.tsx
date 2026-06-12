import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import {
  MISSION_TYPE_LABELS,
  getDb,
  missions,
  siteMissions,
  sites,
} from "@/lib/db";
import { SiteForm } from "@/components/site-form";
import { saveSiteMission, updateSite } from "../../actions";

export const dynamic = "force-dynamic";

export default async function EditSitePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const [{ id }, { error }] = await Promise.all([params, searchParams]);

  const db = getDb();
  const [[site], allMissions, configs] = await Promise.all([
    db.select().from(sites).where(eq(sites.id, id)),
    db.select().from(missions).orderBy(asc(missions.name)),
    db.select().from(siteMissions).where(eq(siteMissions.siteId, id)),
  ]);
  if (!site) notFound();
  const configByMission = new Map(configs.map((c) => [c.missionId, c]));

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold text-zinc-900">
        Edit Site
      </h1>
      <SiteForm
        action={updateSite.bind(null, site.id)}
        site={site}
        error={error}
        submitLabel="Save Changes"
      />

      <div className="mt-8 max-w-2xl rounded-lg border border-zinc-200 bg-white shadow-sm">
        <div className="border-b border-zinc-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-zinc-900">
            Collection URLs per Mission
          </h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            Where on this dealer&apos;s site each mission collects. Leave the
            URL blank and the collector will discover one and remember it.
            Every listed URL is captured on each run.
          </p>
        </div>
        <div className="divide-y divide-zinc-100">
          {allMissions.map((mission) => {
            const config = configByMission.get(mission.id);
            return (
              <form
                key={mission.id}
                action={saveSiteMission.bind(null, site.id, mission.id)}
                className="px-4 py-4"
              >
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium text-zinc-900">
                    {mission.name}{" "}
                    <span className="text-xs font-normal text-zinc-400">
                      ({MISSION_TYPE_LABELS[mission.missionType]}
                      {!mission.active && ", mission disabled"})
                    </span>
                  </h3>
                  <label className="flex items-center gap-1.5 text-xs text-zinc-600">
                    <input
                      type="checkbox"
                      name="active"
                      defaultChecked={config?.active ?? true}
                      className="h-3.5 w-3.5 rounded border-zinc-300"
                    />
                    collect on this dealer
                  </label>
                </div>
                <div className="mt-2 grid gap-2">
                  <input
                    type="url"
                    name="lastKnownUrl"
                    defaultValue={config?.lastKnownUrl ?? ""}
                    placeholder="Primary URL (blank = discover)"
                    className="block w-full rounded-md border border-zinc-300 px-3 py-1.5 text-sm shadow-sm focus:border-zinc-500 focus:outline-none"
                  />
                  <textarea
                    name="alternateUrls"
                    rows={2}
                    defaultValue={(config?.alternateUrls ?? []).join("\n")}
                    placeholder="Additional URLs, one per line (optional)"
                    className="block w-full rounded-md border border-zinc-300 px-3 py-1.5 text-sm shadow-sm focus:border-zinc-500 focus:outline-none"
                  />
                </div>
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-xs text-zinc-400">
                    {config?.lastSuccessAt
                      ? `Last success: ${config.lastSuccessAt.toLocaleString()}`
                      : "Never collected"}
                  </span>
                  <button
                    type="submit"
                    className="rounded-md border border-zinc-300 px-2.5 py-1 text-sm text-zinc-700 hover:bg-zinc-50"
                  >
                    Save
                  </button>
                </div>
              </form>
            );
          })}
        </div>
      </div>
    </div>
  );
}
