import { and, count, desc, eq, inArray } from "drizzle-orm";
import { getDb, inventoryResults, sites } from "@/lib/db";
import { getISOWeekLabel } from "@/lib/cycle";
import { normalizeModelRows } from "@/lib/inventory-model-names";

// ---------------------------------------------------------------------------
// Result types — visible-Chrome collection is the only inventory collector.
// ---------------------------------------------------------------------------

export type InventoryTotals = {
  inStock: number;
  inTransit: number | null;
  displayValue: string;
};

export type MakeSubtotal = {
  make: string;
  inStock: number;
  inTransit: number | null;
};

export type ModelRow = {
  make: string;
  model: string;
  inStock: number | null;
  inTransit: number | null;
  status: string;
};

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** Parse the brand field ("Chrysler, Dodge, Jeep, Ram") into a makeAllowList. */
export function brandsToMakeAllowList(brand: string | null): string[] {
  if (!brand) return [];
  return brand.split(",").map((b) => b.trim()).filter(Boolean);
}

export type InventoryRunSummary = {
  batchId: string;
  weekKey: string;
  startedAt: Date;
  total: number;
  ok: number;
  failed: number;
};

export type CollectAndStoreResult = {
  id: string;
  status: "ok" | "failed";
  totals?: InventoryTotals;
  makeSubtotals?: MakeSubtotal[];
  models?: ModelRow[];
  error?: { message: string; code: string; statusCode?: number; isRateLimited?: boolean };
};

export async function upsertInventoryBatchRow(
  values: Partial<typeof inventoryResults.$inferInsert> &
    Pick<typeof inventoryResults.$inferInsert, "siteId" | "batchId" | "weekKey" | "status">
) {
  const db = getDb();
  const where = and(
    eq(inventoryResults.siteId, values.siteId),
    eq(inventoryResults.batchId, values.batchId)
  );

  const [existing] = await db
    .select({ id: inventoryResults.id })
    .from(inventoryResults)
    .where(where);

  if (existing) {
    const [row] = await db
      .update(inventoryResults)
      .set({ collectedAt: new Date(), ...values })
      .where(eq(inventoryResults.id, existing.id))
      .returning({ id: inventoryResults.id });
    return row;
  }

  const [row] = await db
    .insert(inventoryResults)
    .values(values)
    .returning({ id: inventoryResults.id });
  return row;
}

export type ChromeInventoryResult = {
  sourceUrl: string;
  detectedPlatform: string;
  totals: InventoryTotals;
  makeSubtotals: MakeSubtotal[];
  models: ModelRow[];
  warnings?: string[];
};

/** Stores a visible-Chrome inventory result. */
export async function storeChromeInventoryResult(
  siteId: string,
  batchId: string,
  result: ChromeInventoryResult
): Promise<CollectAndStoreResult> {
  // Every platform writes through here, so this is the one place model names
  // have to agree across the six adapters.
  const models = normalizeModelRows(result.models);
  const row = await upsertInventoryBatchRow({
    siteId,
    batchId,
    weekKey: getISOWeekLabel(),
    status: "ok",
    detectedPlatform: result.detectedPlatform,
    accessRoute: "browser",
    attempts: 1,
    sourceUrl: result.sourceUrl,
    totals: result.totals,
    makeSubtotals: result.makeSubtotals,
    models,
    warnings: result.warnings ?? [],
    error: null,
  });
  return {
    id: row.id,
    status: "ok",
    totals: result.totals,
    makeSubtotals: result.makeSubtotals,
    models,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Latest inventory result per site (for the /inventory page listing). */
export async function getLatestInventoryBySite(
  siteIds?: string[]
): Promise<(typeof inventoryResults.$inferSelect & { siteName: string; siteUrl: string })[]> {
  const db = getDb();

  // Get latest result id per site via subquery
  const latestRows = await db
    .select()
    .from(inventoryResults)
    .leftJoin(sites, eq(inventoryResults.siteId, sites.id))
    .where(
      siteIds && siteIds.length > 0
        ? inArray(inventoryResults.siteId, siteIds)
        : undefined
    )
    .orderBy(desc(inventoryResults.collectedAt));

  // Deduplicate: keep only the most recent per site
  const seen = new Set<string>();
  return latestRows
    .filter(({ inventory_results }) => {
      if (seen.has(inventory_results.siteId)) return false;
      seen.add(inventory_results.siteId);
      return true;
    })
    .map(({ inventory_results, sites: site }) => ({
      ...inventory_results,
      siteName: site?.name ?? "(unknown)",
      siteUrl: site?.url ?? "",
    }));
}

// ---------------------------------------------------------------------------
// Home page freshness status
// ---------------------------------------------------------------------------

export type InventoryFreshnessStatus = {
  ranThisWeek: boolean;
  lastRunAt: Date | null;
  /** Active sites whose *latest* result this week was "ok" (a dealer
   *  retried after a failure counts by its latest outcome, not both). */
  okCount: number;
  /** Active sites whose latest result this week was "failed". */
  failedCount: number;
  /** Total active sites, for "N of totalActiveSites" coverage display. */
  totalActiveSites: number;
};

/** Returns freshness info for the home page nag — how many active dealers
 *  have inventory data this ISO week (out of all active dealers), split by
 *  ok/failed, and when it was last collected. */
export async function getInventoryFreshnessStatus(): Promise<InventoryFreshnessStatus> {
  const weekKey = getISOWeekLabel();
  const db = getDb();

  const [[{ n: totalActiveSites }], rows] = await Promise.all([
    db.select({ n: count() }).from(sites).where(eq(sites.active, true)),
    db
      .select({ siteId: inventoryResults.siteId, status: inventoryResults.status, collectedAt: inventoryResults.collectedAt })
      .from(inventoryResults)
      .where(eq(inventoryResults.weekKey, weekKey))
      .orderBy(desc(inventoryResults.collectedAt)),
  ]);

  // Rows are latest-first; keep only the first (latest) row seen per site.
  const latestBySite = new Map<string, { status: string; collectedAt: Date }>();
  for (const r of rows) {
    if (r.status !== "ok" && r.status !== "failed") continue;
    if (!latestBySite.has(r.siteId)) latestBySite.set(r.siteId, { status: r.status, collectedAt: r.collectedAt });
  }

  let okCount = 0, failedCount = 0, lastRunAt: Date | null = null;
  for (const { status, collectedAt } of latestBySite.values()) {
    if (status === "ok") okCount++;
    else if (status === "failed") failedCount++;
    else continue;
    if (!lastRunAt || collectedAt > lastRunAt) lastRunAt = collectedAt;
  }

  return {
    ranThisWeek: latestBySite.size > 0,
    lastRunAt,
    okCount,
    failedCount,
    totalActiveSites,
  };
}

/** All results for a specific batch run. */
export async function getBatchResults(batchId: string) {
  const db = getDb();
  return db
    .select()
    .from(inventoryResults)
    .leftJoin(sites, eq(inventoryResults.siteId, sites.id))
    .where(eq(inventoryResults.batchId, batchId))
    .orderBy(desc(inventoryResults.collectedAt));
}
