import Link from "next/link";
import { asc } from "drizzle-orm";
import { getDb, isDatabaseConfigured, sites } from "@/lib/db";
import { DbNotConfigured } from "@/components/db-not-configured";
import { setSiteActive } from "./actions";

export const dynamic = "force-dynamic";

export default async function SitesPage() {
  if (!isDatabaseConfigured()) {
    return (
      <div>
        <h1 className="mb-6 text-xl font-semibold text-zinc-900">Sites</h1>
        <DbNotConfigured />
      </div>
    );
  }

  const allSites = await getDb().select().from(sites).orderBy(asc(sites.name));

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-zinc-900">Sites</h1>
        <Link
          href="/sites/new"
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700"
        >
          Add Site
        </Link>
      </div>

      {allSites.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-300 bg-white p-8 text-center text-sm text-zinc-500">
          No sites yet. Add the first dealer or competitor website.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">URL</th>
                <th className="px-4 py-3">Platform</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {allSites.map((site) => (
                <tr key={site.id} className={site.active ? "" : "opacity-60"}>
                  <td className="px-4 py-3 font-medium text-zinc-900">
                    {site.name}
                  </td>
                  <td className="px-4 py-3 text-zinc-600">
                    <a
                      href={site.url}
                      target="_blank"
                      rel="noreferrer"
                      className="hover:underline"
                    >
                      {site.url}
                    </a>
                  </td>
                  <td className="px-4 py-3 text-zinc-600">
                    {site.platform ?? "—"}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                        site.active
                          ? "bg-green-100 text-green-800"
                          : "bg-zinc-100 text-zinc-600"
                      }`}
                    >
                      {site.active ? "Active" : "Disabled"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-3">
                      <Link
                        href={`/sites/${site.id}/edit`}
                        className="text-zinc-700 hover:underline"
                      >
                        Edit
                      </Link>
                      <form
                        action={setSiteActive.bind(null, site.id, !site.active)}
                      >
                        <button
                          type="submit"
                          className="text-zinc-700 hover:underline"
                        >
                          {site.active ? "Disable" : "Enable"}
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
