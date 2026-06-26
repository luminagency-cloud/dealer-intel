import { asc, desc, eq, inArray } from "drizzle-orm";
import { getDb, isDatabaseConfigured, runGroupMembers, runGroups, sites } from "@/lib/db";
import { inventoryResults } from "@/lib/db/schema";
import { isInventoryConfigured, brandsToMakeAllowList } from "@/lib/inventory";
import { DbNotConfigured } from "@/components/db-not-configured";
import { InventoryGroupPicker } from "./inventory-group-picker";
import { InventoryTable, type InventorySiteRow } from "./inventory-table";

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

  // Filter sites by selected group, or show all active
  let groupSiteIds: string[] | undefined;
  if (groupId) {
    const members = await db
      .select({ siteId: runGroupMembers.siteId })
      .from(runGroupMembers)
      .where(eq(runGroupMembers.runGroupId, groupId));
    groupSiteIds = members.map((m) => m.siteId);
  }

  const displaySites = groupSiteIds
    ? allSites.filter((s) => groupSiteIds!.includes(s.id))
    : allSites.filter((s) => s.active);

  // Latest inventory result per displayed site
  const latestBySite = new Map<string, typeof inventoryResults.$inferSelect>();
  if (displaySites.length > 0) {
    const rows = await db
      .select()
      .from(inventoryResults)
      .where(inArray(inventoryResults.siteId, displaySites.map((s) => s.id)))
      .orderBy(desc(inventoryResults.collectedAt));
    for (const r of rows) {
      if (!latestBySite.has(r.siteId)) latestBySite.set(r.siteId, r);
    }
  }

  const tableRows: InventorySiteRow[] = displaySites.map((site) => {
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
            error: r.error as { message: string; code: string; statusCode?: number; isRateLimited?: boolean } | null,
          }
        : null,
    };
  });

  return (
    <div>
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900">Inventory</h1>
          <p className="mt-0.5 text-sm text-zinc-500">
            Collect live vehicle inventory counts via the inventory API.
          </p>
        </div>
        <InventoryGroupPicker
          groups={groups.map((g) => ({ id: g.id, name: g.name }))}
          selectedGroupId={groupId}
        />
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
        <InventoryTable
          sites={tableRows}
          configured={configured}
          groupSiteIds={groupSiteIds}
        />
      )}
    </div>
  );
}
