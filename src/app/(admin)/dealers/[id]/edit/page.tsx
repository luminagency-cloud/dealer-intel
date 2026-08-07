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
import { missionTargetsHomepage } from "@/lib/collector/mission-knowledge";
import { fmtDateTime } from "@/lib/fmt-date";
import { saveSiteMission, updateSite } from "../../actions";

export const dynamic = "force-dynamic";

export default async function EditDealerPage({
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
      <h1 className="mb-6 text-xl font-semibold text-zinc-900 dark:text-zinc-100">
        Edit Dealer
      </h1>
      <SiteForm
        action={updateSite.bind(null, site.id)}
        site={site}
        error={error}
        submitLabel="Save Changes"
      />

      <div className="mt-8 max-w-2xl rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-700 dark:bg-zinc-900">
        <div className="border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            Collection URLs per Mission
          </h2>
          <p className="mt-0.5 text-xs text-zinc-700 dark:text-zinc-200">
            Where on this dealer&apos;s site each mission collects. Homepage
            missions fall back to the site URL when blank — only set one to point
            at a different page. Other missions discover and remember a URL when
            blank. Every listed URL is captured on each run.
          </p>
        </div>
        <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {allMissions.map((mission) => {
            const config = configByMission.get(mission.id);
            return (
              <form
                key={mission.id}
                action={saveSiteMission.bind(null, site.id, mission.id)}
                className="px-4 py-4"
              >
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                    {mission.name}{" "}
                    <span className="text-xs font-normal text-zinc-700 dark:text-zinc-200">
                      ({MISSION_TYPE_LABELS[mission.missionType]}
                      {!mission.active && ", mission disabled"})
                    </span>
                  </h3>
                  <label className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-200">
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
                    placeholder={
                      missionTargetsHomepage(mission.missionType)
                        ? `Blank → uses site URL (${site.url})`
                        : "Blank → discover from site URL"
                    }
                    className="block w-full rounded-md border border-zinc-300 px-3 py-1.5 text-sm shadow-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-600 dark:focus:border-zinc-400"
                  />
                  <textarea
                    name="alternateUrls"
                    rows={2}
                    defaultValue={(config?.alternateUrls ?? []).join("\n")}
                    placeholder="Additional URLs, one per line (optional)"
                    className="block w-full rounded-md border border-zinc-300 px-3 py-1.5 text-sm shadow-sm focus:border-zinc-500 focus:outline-none dark:border-zinc-600 dark:focus:border-zinc-400"
                  />
                </div>
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-xs text-zinc-700 dark:text-zinc-200">
                    {config?.lastSuccessAt
                      ? `Last success: ${fmtDateTime(config.lastSuccessAt)}`
                      : "Never collected"}
                  </span>
                  <button
                    type="submit"
                    className="rounded-md border border-zinc-300 px-2.5 py-1 text-sm text-zinc-700 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
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
