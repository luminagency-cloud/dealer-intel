import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { MISSION_TYPE_LABELS, getDb, missions, sites } from "@/lib/db";
import { SiteForm } from "@/components/site-form";
import { updateSite } from "../../actions";

export const dynamic = "force-dynamic";

export default async function EditSitePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const [{ id }, { error }] = await Promise.all([params, searchParams]);

  const [[site], siteMissions] = await Promise.all([
    getDb().select().from(sites).where(eq(sites.id, id)),
    getDb().select().from(missions).where(eq(missions.siteId, id)),
  ]);
  if (!site) notFound();

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

      <div className="mt-8 max-w-lg rounded-lg border border-zinc-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-zinc-900">
            Missions &amp; Collection URLs
          </h2>
          <Link
            href="/missions/new"
            className="text-sm text-zinc-600 hover:underline"
          >
            Add Mission
          </Link>
        </div>
        {siteMissions.length === 0 ? (
          <p className="px-4 py-6 text-sm text-zinc-500">
            No missions yet for this site.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-100">
            {siteMissions.map((mission) => (
              <li key={mission.id} className="px-4 py-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-zinc-900">
                    {MISSION_TYPE_LABELS[mission.missionType]}
                    {!mission.active && (
                      <span className="ml-2 text-xs font-normal text-zinc-400">
                        (disabled)
                      </span>
                    )}
                  </span>
                  <Link
                    href={`/missions/${mission.id}/edit`}
                    className="text-zinc-600 hover:underline"
                  >
                    Edit URLs
                  </Link>
                </div>
                <ul className="mt-1 space-y-0.5 text-xs text-zinc-500">
                  {mission.lastKnownUrl ? (
                    <li className="truncate">{mission.lastKnownUrl}</li>
                  ) : (
                    <li className="italic">
                      No URL set — collector will discover one
                    </li>
                  )}
                  {(mission.alternateUrls ?? []).map((url) => (
                    <li key={url} className="truncate">
                      {url}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
