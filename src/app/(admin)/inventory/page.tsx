import { asc, desc, inArray } from "drizzle-orm";
import { getDb, isDatabaseConfigured, runGroupMembers, runGroups, sites } from "@/lib/db";
import { inventoryResults } from "@/lib/db/schema";
import { isInventoryConfigured, brandsToMakeAllowList, getInventoryFreshnessStatus, runningLocally } from "@/lib/inventory";
import { getActiveInventoryBatch } from "@/lib/inventory-batch";
import { checkLocalInventoryHealth } from "@/lib/local-inventory-process";
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
  const isLocal = runningLocally();
  const localApiUrl = process.env.INVENTORY_API_URL_LOCAL ?? "";
  const localApiHealthy = isLocal && localApiUrl ? await checkLocalInventoryHealth(localApiUrl) : false;
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
            totals: r.totals as { inStock: number; inTransit: number; displayValue: string } | null,
            makeSubtotals: r.makeSubtotals as { make: string; inStock: number; inTransit: number }[] | null,
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
              Collect live vehicle inventory counts via the inventory API.
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

      {!configured && (
        <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <strong>Not configured.</strong> Set <code>INVENTORY_API_URL</code> and{" "}
          <code>INVENTORY_API_KEY</code> in your <code>.env</code> to enable collection.
        </div>
      )}

      {isLocal && !localApiHealthy && (
        <div className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          <strong>Local inventory mode is on, but the API isn&apos;t responding</strong> at{" "}
          <code>{localApiUrl || "(INVENTORY_API_URL_LOCAL not set)"}</code>. Make sure it&apos;s
          running — <code>npm run start:local</code> in <code>dealer-inventory-api</code> — before
          running a collection, or it will fail.
        </div>
      )}

      {isLocal && localApiHealthy && (
        <div className="mb-6 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-200">
          <strong>Local inventory mode is on.</strong> Using <code>{localApiUrl}</code> instead of
          the deployed API.
        </div>
      )}

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
