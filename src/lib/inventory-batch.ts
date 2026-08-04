import { getDb, inventoryResults, sites } from "@/lib/db";
import { getISOWeekLabel } from "@/lib/cycle";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import {
  brandsToMakeAllowList,
  collectAndStore,
  storeChromeInventoryResult,
  type ChromeInventoryResult,
  type CollectAndStoreResult,
} from "@/lib/inventory";
import { supportsChromeInventory } from "@/lib/inventory-platforms";

/**
 * Background inventory batch execution. The "Run" server action seeds/extends
 * a batch here and returns immediately; processing happens off-request in
 * this Node process so it keeps going regardless of what the browser tab
 * does afterward (navigates away, closes, whatever) — mirroring the pattern
 * `run-executor.ts` uses for collection runs, for the same reason: a
 * client-side loop that awaits one server action per work item can get
 * permanently stranded mid-navigation (Next's router discards the in-flight
 * action's promise without ever resolving it), silently killing the rest of
 * the queue.
 *
 * Progress is also persisted to `inventory_results` as queued/running rows so
 * the UI can poll reliably even if status requests land on a different worker.
 */

interface ActiveBatch {
  collectorMode: "inventory_api" | "chrome_extension";
  /** Every site ever added to this batch, in the order added — for display. */
  siteIds: string[];
  /** Mutable work queue; shift() one at a time. Clicking "Run" again while a
   *  batch is active appends here instead of starting a second batch. */
  remaining: string[];
  /** Site currently being collected, if any. */
  current: string | null;
  startedAt: Date;
}

type PersistedBatchRow =
  | { id: string; status: "queued" | "running" }
  | {
      id: string;
      status: "cancelled";
      error: { message: string; code: string } | null;
    }
  | CollectAndStoreResult;

// Survives dev-server HMR module reloads; one active batch at a time.
const globalState = globalThis as unknown as {
  __activeInventoryBatch?: { id: string; batch: ActiveBatch } | null;
  __cancelledInventoryBatchIds?: Set<string>;
};
if (globalState.__activeInventoryBatch === undefined) {
  globalState.__activeInventoryBatch = null;
}
if (!globalState.__cancelledInventoryBatchIds) {
  globalState.__cancelledInventoryBatchIds = new Set<string>();
}

async function clearStaleActiveBatch() {
  const active = globalState.__activeInventoryBatch;
  if (!active) return;
  const [pending] = await getDb()
    .select({ id: inventoryResults.id })
    .from(inventoryResults)
    .where(
      and(
        eq(inventoryResults.batchId, active.id),
        inArray(inventoryResults.status, ["queued", "running"])
      )
    )
    .limit(1);
  if (!pending && globalState.__activeInventoryBatch?.id === active.id) {
    globalState.__activeInventoryBatch = null;
  }
}

async function seedBatchRows(
  batchId: string,
  siteIds: string[],
  collectorMode: ActiveBatch["collectorMode"]
) {
  if (siteIds.length === 0) return;
  const weekKey = getISOWeekLabel();
  await getDb().insert(inventoryResults).values(
    siteIds.map((siteId) => ({
      siteId,
      batchId,
      weekKey,
      status: "queued",
      accessRoute: collectorMode === "chrome_extension" ? "chrome" : null,
    }))
  );
}

export async function getActiveInventoryBatch(): Promise<{
  batchId: string;
  siteIds: string[];
  startedAt: Date;
  collectorMode: ActiveBatch["collectorMode"];
} | null> {
  await clearStaleActiveBatch();
  const active = globalState.__activeInventoryBatch;
  if (active) {
    return {
      batchId: active.id,
      siteIds: active.batch.siteIds,
      startedAt: active.batch.startedAt,
      collectorMode: active.batch.collectorMode,
    };
  }

  const rows = await getDb()
    .select({
      batchId: inventoryResults.batchId,
      siteId: inventoryResults.siteId,
      collectedAt: inventoryResults.collectedAt,
      accessRoute: inventoryResults.accessRoute,
    })
    .from(inventoryResults)
    .where(inArray(inventoryResults.status, ["queued", "running"]))
    .orderBy(desc(inventoryResults.collectedAt), asc(inventoryResults.siteId));

  if (rows.length === 0) return null;

  const batchId = rows[0].batchId;
  const batchRows = rows.filter((row) => row.batchId === batchId).reverse();
  return {
    batchId,
    siteIds: [...new Set(batchRows.map((row) => row.siteId))],
    startedAt: batchRows[0]?.collectedAt ?? new Date(),
    collectorMode: batchRows.some((row) => row.accessRoute === "chrome")
      ? "chrome_extension"
      : "inventory_api",
  };
}

export interface InventoryBatchStatus {
  active: boolean;
  siteIds: string[];
  current: string | null;
  startedAt: Date | null;
  results: Record<string, PersistedBatchRow>;
  collectorMode: ActiveBatch["collectorMode"];
}

/** Latest result per site within one batch (one row per site, updated
 *  queued -> running -> ok/failed as work progresses). */
export async function getInventoryBatchStatus(batchId: string): Promise<InventoryBatchStatus> {
  const active = globalState.__activeInventoryBatch;
  const isThisBatch = active?.id === batchId;

  const rows = await getDb()
    .select({
      id: inventoryResults.id,
      siteId: inventoryResults.siteId,
      collectedAt: inventoryResults.collectedAt,
      status: inventoryResults.status,
      accessRoute: inventoryResults.accessRoute,
      totals: inventoryResults.totals,
      makeSubtotals: inventoryResults.makeSubtotals,
      models: inventoryResults.models,
      error: inventoryResults.error,
    })
    .from(inventoryResults)
    .where(eq(inventoryResults.batchId, batchId))
    .orderBy(asc(inventoryResults.collectedAt), asc(inventoryResults.siteId));

  const results: Record<string, PersistedBatchRow> = {};
  for (const r of rows) {
    if (r.status === "queued" || r.status === "running") {
      results[r.siteId] = { id: r.id, status: r.status };
    } else if (r.status === "cancelled") {
      results[r.siteId] = {
        id: r.id,
        status: "cancelled",
        error: r.error as { message: string; code: string } | null,
      };
    } else {
      results[r.siteId] = {
        id: r.id,
        status: r.status as "ok" | "failed",
        totals: r.totals as CollectAndStoreResult["totals"],
        makeSubtotals: r.makeSubtotals as CollectAndStoreResult["makeSubtotals"],
        models: r.models as CollectAndStoreResult["models"],
        error: r.error as CollectAndStoreResult["error"],
      };
    }
  }

  const persistedActive = rows.some((r) => r.status === "queued" || r.status === "running");
  const persistedCurrent = rows.find((r) => r.status === "running")?.siteId ?? null;

  return {
    active: isThisBatch || persistedActive,
    siteIds: isThisBatch ? active.batch.siteIds : [...new Set(rows.map((row) => row.siteId))],
    current: isThisBatch ? active.batch.current : persistedCurrent,
    startedAt: isThisBatch ? active.batch.startedAt : rows[0]?.collectedAt ?? null,
    results,
    collectorMode: isThisBatch
      ? active.batch.collectorMode
      : rows.some((row) => row.accessRoute === "chrome")
        ? "chrome_extension"
        : "inventory_api",
  };
}

async function markBatchRow(
  siteId: string,
  batchId: string,
  status: "running" | "failed" | "cancelled",
  error?: { message: string; code: string }
) {
  await getDb()
    .update(inventoryResults)
    .set({
      status,
      collectedAt: new Date(),
      ...(status === "failed" || status === "cancelled"
        ? {
            error:
              error ??
              (status === "cancelled"
                ? { message: "Inventory run cancelled by operator", code: "cancelled" }
                : { message: "Unexpected inventory batch error", code: "unexpected_error" }),
          }
        : {}),
    })
    .where(
      and(
        eq(inventoryResults.batchId, batchId),
        eq(inventoryResults.siteId, siteId)
      )
    );
}

async function runBatch(batchId: string): Promise<void> {
  try {
    while (true) {
      if (globalState.__cancelledInventoryBatchIds?.has(batchId)) return;
      const active = globalState.__activeInventoryBatch;
      if (!active || active.id !== batchId) return;
      const siteId = active.batch.remaining.shift();
      if (!siteId) return;
      active.batch.current = siteId;
      await markBatchRow(siteId, batchId, "running");

      const [site] = await getDb().select().from(sites).where(eq(sites.id, siteId));
      if (!site) {
        await markBatchRow(siteId, batchId, "failed", {
          message: "Dealer record not found",
          code: "missing_site",
        });
        continue;
      }

      try {
        await collectAndStore(site, batchId);
        if (globalState.__cancelledInventoryBatchIds?.has(batchId)) {
          await markBatchRow(siteId, batchId, "cancelled");
          return;
        }
      } catch (err) {
        if (globalState.__cancelledInventoryBatchIds?.has(batchId)) {
          await markBatchRow(siteId, batchId, "cancelled");
          return;
        }
        console.error(`[inventory-batch] ${batchId} failed for site ${siteId}:`, err);
        await markBatchRow(siteId, batchId, "failed", {
          message: err instanceof Error ? err.message : "Unexpected inventory batch error",
          code: "unexpected_error",
        });
      }
    }
  } finally {
    if (globalState.__activeInventoryBatch?.id === batchId) {
      globalState.__activeInventoryBatch = null;
    }
    globalState.__cancelledInventoryBatchIds?.delete(batchId);
    revalidatePath("/inventory");
  }
}

/** Starts a new inventory batch, or appends to the currently active one.
 *  Returns immediately — the actual collection runs in the background. */
export async function startInventoryBatch(siteIds: string[]): Promise<{ batchId: string }> {
  const ids = [...new Set(siteIds)];
  await clearStaleActiveBatch();
  const active = globalState.__activeInventoryBatch;

  if (active) {
    if (active.batch.collectorMode !== "inventory_api") {
      throw new Error("A Chrome inventory batch is already active");
    }
    const fresh = ids.filter((id) => !active.batch.siteIds.includes(id));
    active.batch.siteIds.push(...fresh);
    active.batch.remaining.push(...fresh);
    await seedBatchRows(active.id, fresh, "inventory_api");
    return { batchId: active.id };
  }

  const batchId = crypto.randomUUID();
  const startedAt = new Date();
  await seedBatchRows(batchId, ids, "inventory_api");
  globalState.__activeInventoryBatch = {
    id: batchId,
    batch: {
      collectorMode: "inventory_api",
      siteIds: [...ids],
      remaining: [...ids],
      current: null,
      startedAt,
    },
  };
  void runBatch(batchId);
  return { batchId };
}

export interface ChromeInventoryJobItem {
  siteId: string;
  siteName: string;
  url: string;
  platform: string | null;
  makeAllowList: string[];
  inventoryPath: string | null;
}

async function requireChromeInventorySites(siteIds: string[]) {
  const rows = await getDb()
    .select({ id: sites.id, name: sites.name, platform: sites.platform })
    .from(sites)
    .where(inArray(sites.id, siteIds));
  const found = new Set(rows.map((row) => row.id));
  const missing = siteIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new Error("One or more selected dealers no longer exist");
  }
  const unsupported = rows.filter((row) => !supportsChromeInventory(row.platform));
  if (unsupported.length > 0) {
    throw new Error(
      `Visible-inventory collection has no adapter for these dealers' platforms. Remove: ${unsupported
        .map((row) => `${row.name} (${row.platform?.trim() || "no platform set"})`)
        .join(", ")}`
    );
  }
}

export async function startChromeInventoryBatch(
  siteIds: string[]
): Promise<{ batchId: string }> {
  const ids = [...new Set(siteIds)];
  await requireChromeInventorySites(ids);
  await clearStaleActiveBatch();
  const active = globalState.__activeInventoryBatch;

  if (active) {
    if (active.batch.collectorMode !== "chrome_extension") {
      throw new Error("An inventory API batch is already active");
    }
    const fresh = ids.filter((id) => !active.batch.siteIds.includes(id));
    active.batch.siteIds.push(...fresh);
    active.batch.remaining.push(...fresh);
    await seedBatchRows(active.id, fresh, "chrome_extension");
    return { batchId: active.id };
  }

  const batchId = crypto.randomUUID();
  const startedAt = new Date();
  await seedBatchRows(batchId, ids, "chrome_extension");
  globalState.__activeInventoryBatch = {
    id: batchId,
    batch: {
      collectorMode: "chrome_extension",
      siteIds: [...ids],
      remaining: [...ids],
      current: null,
      startedAt,
    },
  };
  return { batchId };
}

export async function getChromeInventoryJob(
  batchId: string
): Promise<{ batchId: string; items: ChromeInventoryJobItem[] }> {
  const rows = await getDb()
    .select({
      siteId: inventoryResults.siteId,
      status: inventoryResults.status,
      accessRoute: inventoryResults.accessRoute,
      siteName: sites.name,
      url: sites.url,
      platform: sites.platform,
      brand: sites.brand,
      inventoryPath: sites.inventoryPath,
    })
    .from(inventoryResults)
    .innerJoin(sites, eq(inventoryResults.siteId, sites.id))
    .where(
      and(
        eq(inventoryResults.batchId, batchId),
        inArray(inventoryResults.status, ["queued", "running"])
      )
    )
    .orderBy(asc(inventoryResults.collectedAt), asc(sites.name));

  if (rows.some((row) => row.accessRoute !== "chrome")) {
    throw new Error("This batch is not assigned to visible Chrome");
  }

  return {
    batchId,
    items: rows.map((row) => ({
      siteId: row.siteId,
      siteName: row.siteName,
      url: row.url,
      platform: row.platform,
      makeAllowList: brandsToMakeAllowList(row.brand),
      inventoryPath: row.inventoryPath,
    })),
  };
}

async function requireChromeBatchItem(batchId: string, siteId: string) {
  const [row] = await getDb()
    .select({
      id: inventoryResults.id,
      status: inventoryResults.status,
      accessRoute: inventoryResults.accessRoute,
    })
    .from(inventoryResults)
    .where(
      and(
        eq(inventoryResults.batchId, batchId),
        eq(inventoryResults.siteId, siteId)
      )
    );
  if (!row || row.accessRoute !== "chrome") {
    throw new Error("Inventory item is outside this Chrome batch");
  }
  if (row.status !== "queued" && row.status !== "running") {
    throw new Error("Inventory batch is no longer active");
  }
  return row;
}

export async function markChromeInventoryItemRunning(
  batchId: string,
  siteId: string
) {
  await requireChromeBatchItem(batchId, siteId);
  const active = globalState.__activeInventoryBatch;
  if (active?.id === batchId) active.batch.current = siteId;
  await markBatchRow(siteId, batchId, "running");
}

async function settleChromeBatch(batchId: string, siteId: string) {
  const active = globalState.__activeInventoryBatch;
  if (active?.id === batchId) {
    active.batch.remaining = active.batch.remaining.filter((id) => id !== siteId);
    active.batch.current = null;
  }
  const [pending] = await getDb()
    .select({ id: inventoryResults.id })
    .from(inventoryResults)
    .where(
      and(
        eq(inventoryResults.batchId, batchId),
        inArray(inventoryResults.status, ["queued", "running"])
      )
    )
    .limit(1);
  if (!pending && globalState.__activeInventoryBatch?.id === batchId) {
    globalState.__activeInventoryBatch = null;
  }
  revalidatePath("/inventory");
}

export async function completeChromeInventoryItem(
  batchId: string,
  siteId: string,
  result: ChromeInventoryResult
) {
  await requireChromeBatchItem(batchId, siteId);
  await storeChromeInventoryResult(siteId, batchId, result);
  await settleChromeBatch(batchId, siteId);
}

export async function failChromeInventoryItem(
  batchId: string,
  siteId: string,
  error: { message: string; code: string }
) {
  await requireChromeBatchItem(batchId, siteId);
  await markBatchRow(siteId, batchId, "failed", error);
  await settleChromeBatch(batchId, siteId);
}

/** Cancels queued work immediately. The API collector finishes unwinding its
 * current request, while the Chrome client separately aborts and closes its
 * visible collection window. */
export async function cancelInventoryBatch(batchId: string): Promise<void> {
  const active = globalState.__activeInventoryBatch;
  const apiIsRunning =
    active?.id === batchId && active.batch.collectorMode === "inventory_api";
  if (apiIsRunning) globalState.__cancelledInventoryBatchIds?.add(batchId);

  if (active?.id === batchId) {
    active.batch.remaining = [];
    active.batch.current = null;
    globalState.__activeInventoryBatch = null;
  }

  await getDb()
    .update(inventoryResults)
    .set({
      status: "cancelled",
      collectedAt: new Date(),
      error: {
        message: "Inventory run cancelled by operator",
        code: "cancelled",
      },
    })
    .where(
      and(
        eq(inventoryResults.batchId, batchId),
        inArray(inventoryResults.status, ["queued", "running"])
      )
    );

  revalidatePath("/inventory");
}

export type { CollectAndStoreResult };
