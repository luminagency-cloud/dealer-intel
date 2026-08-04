import { asc, desc, inArray } from "drizzle-orm";
import { getDb, isDatabaseConfigured, runGroupMembers, runGroups, sites } from "@/lib/db";
import { inventoryResults } from "@/lib/db/schema";
import { isInventoryConfigured, brandsToMakeAllowList, getInventoryFreshnessStatus } from "@/lib/inventory";
import { getActiveInventoryBatch } from "@/lib/inventory-batch";
import { formatInventoryDetail } from "@/lib/coverage";
import { DbNotConfigured } from "@/components/db-not-configured";
import { InventoryTable, type InventorySiteRow } from "./inventory-table";

export const dynamic = "force-dynamic";

export default async function InventoryPage() {
  if (!isDatabaseConfigured()) {
    return (
      <div>
        <h1 className="mb-6 text-xl font-semibold text-zinc-900">Inventory</h1>
        <DbNotConfigured />
      </div>
    );
  }

  const configured = isInventoryConfigured();
  const db = getDb();

  const [allGroups, allSites, allMembers, freshness] = await Promise.all([
    db.select().from(runGroups).orderBy(asc(runGroups.name)),
    db.select().from(sites).orderBy(asc(sites.name)),
    db.select({ groupId: runGroupMembers.runGroupId, siteId: runGroupMembers.siteId }).from(runGroupMembers),
    configured ? getInventoryFreshnessStatus() : Promise.resolve(null),
  ]);

  const activeSites = allSites.filter((s) => s.active);

  // Build group -> siteIds map.
  const groupSiteMap = new Map<string, string[]>();
  for (const m of allMembers) {
    const list = groupSiteMap.get(m.groupId) ?? [];
    list.push(m.siteId);
    groupSiteMap.set(m.groupId, list);
  }
  const groups = allGroups.map((g) => ({
    id: g.id,
    name: g.name,
    siteIds: (groupSiteMap.get(g.id) ?? []).filter((id) => activeSites.some((s) => s.id === id)),
  }));

  // Latest inventory result per active site.
  const latestBySite = new Map<string, typeof inventoryResults.$inferSelect>();
  if (activeSites.length > 0) {
    const rows = await db
      .select()
      .from(inventoryResults)
      .where(inArray(inventoryResults.siteId, activeSites.map((s) => s.id)))
      .orderBy(desc(inventoryResults.collectedAt));
    for (const r of rows) {
      if (r.status === "cancelled") continue;
      if (!latestBySite.has(r.siteId)) latestBySite.set(r.siteId, r);
    }
  }

  const tableRows: InventorySiteRow[] = activeSites.map((site) => {
    const r = latestBySite.get(site.id) ?? null;
    return {
      id: site.id,
      name: site.name,
      url: site.url,
      brand: site.brand,
      platform: site.platform,
      active: site.active,
      makes: brandsToMakeAllowList(site.brand),
      lastResult: r
        ? {
            status: r.status,
            collectedAt: r.collectedAt,
            totals: r.totals as { inStock: number; inTransit: number | null; displayValue: string } | null,
            makeSubtotals: r.makeSubtotals as { make: string; inStock: number; inTransit: number | null }[] | null,
            models: r.models as { make: string; model: string; inStock: number | null; inTransit: number | null; status: string }[] | null,
            error: r.error as { message: string; code: string; statusCode?: number; isRateLimited?: boolean } | null,
          }
        : null,
    };
  });

  return (
    <div>
      <div className="mb-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Inventory</h1>
            <p className="mt-0.5 text-sm text-zinc-700 dark:text-zinc-200">
              Navigate dealer menus and collect live vehicle counts in visible Chrome.
            </p>
            {configured && (
              <p className="mt-1 text-sm font-medium text-zinc-800 dark:text-zinc-200">
                This week: {formatInventoryDetail(freshness)}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs text-zinc-700 mr-1">Age:</span>
            <span className="inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium bg-green-500 text-white">&lt; 1 day</span>
            <span className="inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium bg-yellow-400 text-yellow-950">&lt; 4 days</span>
            <span className="inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium bg-orange-500 text-white">4+ days</span>
            <span className="inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium bg-red-600 text-white">Failed</span>
            <span className="inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium bg-blue-500 text-white">Running</span>
          </div>
        </div>
      </div>

      {activeSites.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-300 bg-white p-8 text-center text-sm text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
          No active dealers found.
        </p>
      ) : (
        <InventoryTable
          sites={tableRows}
          groups={groups}
          configured={configured}
          initialActiveBatch={await getActiveInventoryBatch()}
        />
      )}
    </div>
  );
}
