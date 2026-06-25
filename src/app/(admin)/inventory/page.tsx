import { asc, desc, eq, inArray } from "drizzle-orm";
import { getDb, isDatabaseConfigured, runGroupMembers, runGroups, sites } from "@/lib/db";
import { inventoryResults } from "@/lib/db/schema";
import { isInventoryConfigured, brandsToMakeAllowList } from "@/lib/inventory";
import { DbNotConfigured } from "@/components/db-not-configured";
import { fmtDateTime } from "@/lib/fmt-date";
import { runInventoryForSite, runInventoryForGroup } from "./actions";
import { InventoryGroupPicker } from "./inventory-group-picker";

export const dynamic = "force-dynamic";

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ group?: string }>;
}) {
  if (!isDatabaseConfigured()) {
    return (
      <div>
        <h1 className="mb-6 text-xl font-semibold text-zinc-900">Inventory</h1>
        <DbNotConfigured />
      </div>
    );
  }

  const { group: groupId } = await searchParams;
  const configured = isInventoryConfigured();

  const db = getDb();
  const [groups, allSites] = await Promise.all([
    db.select().from(runGroups).orderBy(asc(runGroups.name)),
    db.select().from(sites).orderBy(asc(sites.name)),
  ]);

  // Which sites to show: filtered by selected group, or all active
  let displaySiteIds: string[] | null = null;
  if (groupId) {
    const members = await db
      .select({ siteId: runGroupMembers.siteId })
      .from(runGroupMembers)
      .where(eq(runGroupMembers.runGroupId, groupId));
    displaySiteIds = members.map((m) => m.siteId);
  }

  const displaySites = displaySiteIds
    ? allSites.filter((s) => displaySiteIds!.includes(s.id))
    : allSites.filter((s) => s.active);

  // Latest inventory result per displayed site
  const latestResults =
    displaySites.length > 0
      ? await db
          .select()
          .from(inventoryResults)
          .where(inArray(inventoryResults.siteId, displaySites.map((s) => s.id)))
          .orderBy(desc(inventoryResults.collectedAt))
          .then((rows) => {
            const seen = new Set<string>();
            const out = new Map<string, typeof rows[0]>();
            for (const r of rows) {
              if (!seen.has(r.siteId)) {
                seen.add(r.siteId);
                out.set(r.siteId, r);
              }
            }
            return out;
          })
      : new Map();

  const selectedGroup = groups.find((g) => g.id === groupId);

  return (
    <div>
      {/* Header */}
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900">Inventory</h1>
          <p className="mt-0.5 text-sm text-zinc-500">
            Collect live vehicle inventory counts via the inventory API.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <InventoryGroupPicker
            groups={groups.map((g) => ({ id: g.id, name: g.name }))}
            selectedGroupId={groupId}
          />

          {groupId && configured && (
            <form action={runInventoryForGroup.bind(null, groupId)}>
              <button
                type="submit"
                className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50"
              >
                Run Group
              </button>
            </form>
          )}
        </div>
      </div>

      {!configured && (
        <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <strong>Not configured.</strong> Set <code>INVENTORY_API_URL</code> and{" "}
          <code>INVENTORY_API_KEY</code> in your <code>.env</code> to enable collection.
        </div>
      )}

      {displaySites.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-300 bg-white p-8 text-center text-sm text-zinc-500">
          {groupId ? "No sites in this group." : "No active dealers found."}
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-3">Dealer</th>
                <th className="px-4 py-3">Brand / Make Filter</th>
                <th className="px-4 py-3">Platform</th>
                <th className="px-4 py-3">Last Run</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Totals</th>
                <th className="px-4 py-3 text-right">Collect</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {displaySites.map((site) => {
                const result = latestResults.get(site.id);
                const makes = brandsToMakeAllowList(site.brand);
                const totals = result?.totals as
                  | { inStock: number; inTransit: number; displayValue: string }
                  | null
                  | undefined;

                return (
                  <tr key={site.id} className={site.active ? "" : "opacity-50"}>
                    <td className="px-4 py-3 font-medium text-zinc-900">
                      {site.name}
                      <div className="text-xs font-normal text-zinc-400">{site.url}</div>
                    </td>
                    <td className="px-4 py-3 text-zinc-600">
                      {makes.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {makes.map((m) => (
                            <span
                              key={m}
                              className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-700"
                            >
                              {m}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-zinc-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-zinc-500">
                      {site.platform ?? <span className="text-zinc-300">—</span>}
                    </td>
                    <td className="px-4 py-3 text-zinc-500 text-xs">
                      {result ? fmtDateTime(result.collectedAt) : <span className="text-zinc-300">never</span>}
                    </td>
                    <td className="px-4 py-3">
                      {result ? (
                        result.status === "ok" ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                            ok
                          </span>
                        ) : (
                          <span
                            className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700"
                            title={(result.error as { message?: string } | null)?.message ?? ""}
                          >
                            failed
                          </span>
                        )
                      ) : (
                        <span className="text-zinc-300 text-xs">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-zinc-700">
                      {totals ? (
                        <span className="font-mono text-xs">
                          {totals.displayValue ?? `${totals.inStock} / ${totals.inTransit}*`}
                        </span>
                      ) : (
                        <span className="text-zinc-300 text-xs">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {configured ? (
                        <form action={runInventoryForSite.bind(null, site.id)}>
                          <button
                            type="submit"
                            className="rounded border border-zinc-300 px-3 py-1 text-xs text-zinc-700 hover:bg-zinc-50"
                          >
                            Run
                          </button>
                        </form>
                      ) : (
                        <span className="text-zinc-300 text-xs">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
