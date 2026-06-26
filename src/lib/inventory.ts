import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb, inventoryResults, sites } from "@/lib/db";
import { getISOWeekLabel } from "@/lib/cycle";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const isInventoryConfigured = (): boolean =>
  Boolean(process.env.INVENTORY_API_URL && process.env.INVENTORY_API_KEY);

function apiBase(): string {
  return process.env.INVENTORY_API_URL ?? "";
}

function apiHeaders(): HeadersInit {
  return { "x-api-key": process.env.INVENTORY_API_KEY ?? "", "Content-Type": "application/json" };
}

// ---------------------------------------------------------------------------
// API types
// ---------------------------------------------------------------------------

export type InventoryTotals = {
  inStock: number;
  inTransit: number;
  displayValue: string;
};

export type MakeSubtotal = {
  make: string;
  inStock: number;
  inTransit: number;
};

export type ModelRow = {
  make: string;
  model: string;
  inStock: number | null;
  inTransit: number | null;
  status: string;
};

export type InventoryApiSuccess = {
  ok: true;
  dealerId?: string;
  url: string;
  sourceUrl: string;
  detectedPlatform: string;
  accessRoute: "direct" | "browser";
  attempts: number;
  totals: InventoryTotals;
  makeSubtotals: MakeSubtotal[];
  models: ModelRow[];
  warnings?: string[];
};

export type InventoryApiError = {
  ok: false;
  dealerId?: string;
  url: string;
  error: { message: string; code: string; statusCode?: number; isRateLimited?: boolean };
};

export type InventoryApiResult = InventoryApiSuccess | InventoryApiError;

// ---------------------------------------------------------------------------
// API call — one dealer
// ---------------------------------------------------------------------------

export type CollectInventoryInput = {
  url: string;
  makeAllowList: string[];
  platform?: string;
  dealerId?: string;
  name?: string;
};

export async function collectInventoryForDealer(
  input: CollectInventoryInput
): Promise<InventoryApiResult | null> {
  const base = apiBase();
  if (!base) return null;
  const endpoint = `${base}/v1/inventory`;
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify(input),
      cache: "no-store",
    });
    console.log(`[inventory] POST ${endpoint} (${input.name ?? input.url}) → ${res.status}`);
    const json = await res.json();
    return json as InventoryApiResult;
  } catch (err) {
    console.error(`[inventory] fetch error for ${input.url}:`, err);
    return null;
  }
}

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
  error?: { message: string; code: string; statusCode?: number; isRateLimited?: boolean };
};

/** Collect inventory for a site and store the result. */
export async function collectAndStore(
  site: { id: string; url: string; brand: string | null; platform: string | null; name: string },
  batchId: string
): Promise<CollectAndStoreResult> {
  const weekKey = getISOWeekLabel();
  const makeAllowList = brandsToMakeAllowList(site.brand);

  const apiResult = await collectInventoryForDealer({
    url: site.url,
    makeAllowList,
    platform: site.platform ?? undefined,
    dealerId: site.id,
    name: site.name,
  });

  const db = getDb();

  if (!apiResult) {
    const err = { message: "Network error — no response from inventory API", code: "network_error" };
    const [row] = await db
      .insert(inventoryResults)
      .values({ siteId: site.id, batchId, weekKey, status: "failed", error: err })
      .returning({ id: inventoryResults.id });
    return { id: row.id, status: "failed", error: err };
  }

  if (!apiResult.ok) {
    const [row] = await db
      .insert(inventoryResults)
      .values({ siteId: site.id, batchId, weekKey, status: "failed", error: apiResult.error })
      .returning({ id: inventoryResults.id });
    return { id: row.id, status: "failed", error: apiResult.error };
  }

  const [row] = await db
    .insert(inventoryResults)
    .values({
      siteId: site.id,
      batchId,
      weekKey,
      status: "ok",
      detectedPlatform: apiResult.detectedPlatform,
      accessRoute: apiResult.accessRoute,
      attempts: apiResult.attempts,
      sourceUrl: apiResult.sourceUrl,
      totals: apiResult.totals,
      makeSubtotals: apiResult.makeSubtotals,
      models: apiResult.models,
      warnings: apiResult.warnings ?? [],
    })
    .returning({ id: inventoryResults.id });
  return { id: row.id, status: "ok", totals: apiResult.totals };
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
