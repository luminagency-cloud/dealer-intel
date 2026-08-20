import { getDb, inventoryResults, sites } from "@/lib/db";
import { getISOWeekLabel } from "@/lib/cycle";
import { and, asc, desc, eq, inArray, max } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import {
  brandsToMakeAllowList,
  storeChromeInventoryResult,
  type ChromeInventoryResult,
  type CollectAndStoreResult,
} from "@/lib/inventory";
import { supportsChromeInventory } from "@/lib/inventory-platforms";

/**
 * Inventory batch bookkeeping. Collection itself runs in the operator's
 * visible Chrome via the extension; this module seeds the work queue, hands
 * it out, and records each dealer's outcome.
 *
 * Progress is persisted to `inventory_results` as queued/running rows so the
 * UI can poll reliably even if status requests land on a different worker.
 */

interface ActiveBatch {
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
};
if (globalState.__activeInventoryBatch === undefined) {
  globalState.__activeInventoryBatch = null;
}

/**
 * How long a batch may go without ANY dealer changing state before it is
 * treated as abandoned.
 *
 * The bound is on the batch's last progress, not on a row's age: a dealer
 * queued behind twenty others legitimately waits a long time, but the batch
 * around it does not stand still. The longest legitimate gap is one dealer's
 * whole collection — `collectionBudgetMs` in the extension, 45s plus 45s per
 * make plus session headroom, so about six minutes for the widest allow-list
 * we run. Twice that leaves room for a slow store without leaving a genuinely
 * dead batch sitting there.
 */
const ORPHANED_BATCH_MS = 12 * 60 * 1_000;

/**
 * Fail the rows of any batch nothing is driving any more.
 *
 * Queued work only ever moves because a Dealer Intel tab is holding the
 * browser lock for its batch and draining the queue. When that tab is closed,
 * reloaded away, or never claimed the batch at all, the rows stay queued and
 * the batch keeps reporting itself active — with no visible collection window
 * and no timeout to end it, because the per-dealer timeout only starts once a
 * dealer is actually handed to the extension. This is that missing bound.
 */
async function reapOrphanedBatches() {
  const db = getDb();
  const pending = await db
    .selectDistinct({ batchId: inventoryResults.batchId })
    .from(inventoryResults)
    .where(inArray(inventoryResults.status, ["queued", "running"]));
  if (pending.length === 0) return;

  const batchIds = pending.map((row) => row.batchId);
  const progress = await db
    .select({
      batchId: inventoryResults.batchId,
      lastProgress: max(inventoryResults.collectedAt),
    })
    .from(inventoryResults)
    .where(inArray(inventoryResults.batchId, batchIds))
    .groupBy(inventoryResults.batchId);

  const cutoff = new Date(Date.now() - ORPHANED_BATCH_MS);
  const orphaned = progress
    .filter((row) => row.lastProgress !== null && row.lastProgress < cutoff)
    .map((row) => row.batchId);
  if (orphaned.length === 0) return;

  await db
    .update(inventoryResults)
    .set({
      status: "failed",
      collectedAt: new Date(),
      error: {
        message:
          "No Chrome Collector picked this dealer up. The visible collection window never opened, or the Dealer Intel tab driving the run was closed. Press Run again.",
        code: "chrome_collector_unavailable",
      },
    })
    .where(
      and(
        inArray(inventoryResults.batchId, orphaned),
        inArray(inventoryResults.status, ["queued", "running"])
      )
    );

  const active = globalState.__activeInventoryBatch;
  if (active && orphaned.includes(active.id)) globalState.__activeInventoryBatch = null;
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

async function seedBatchRows(batchId: string, siteIds: string[]) {
  if (siteIds.length === 0) return;
  const weekKey = getISOWeekLabel();
  await getDb().insert(inventoryResults).values(
    siteIds.map((siteId) => ({
      siteId,
      batchId,
      weekKey,
      status: "queued",
      accessRoute: "chrome",
    }))
  );
}

export async function getActiveInventoryBatch(): Promise<{
  batchId: string;
  siteIds: string[];
  startedAt: Date;
} | null> {
  await reapOrphanedBatches();
  await clearStaleActiveBatch();
  const active = globalState.__activeInventoryBatch;
  if (active) {
    return {
      batchId: active.id,
      siteIds: active.batch.siteIds,
      startedAt: active.batch.startedAt,
    };
  }

  const rows = await getDb()
    .select({
      batchId: inventoryResults.batchId,
      siteId: inventoryResults.siteId,
      collectedAt: inventoryResults.collectedAt,
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
  };
}

export interface InventoryBatchStatus {
  active: boolean;
  siteIds: string[];
  current: string | null;
  startedAt: Date | null;
  results: Record<string, PersistedBatchRow>;
}

/** Latest result per site within one batch (one row per site, updated
 *  queued -> running -> ok/failed as work progresses). */
export async function getInventoryBatchStatus(batchId: string): Promise<InventoryBatchStatus> {
  await reapOrphanedBatches();
  const active = globalState.__activeInventoryBatch;
  const isThisBatch = active?.id === batchId;

  const rows = await getDb()
    .select({
      id: inventoryResults.id,
      siteId: inventoryResults.siteId,
      collectedAt: inventoryResults.collectedAt,
      status: inventoryResults.status,
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
    const fresh = ids.filter((id) => !active.batch.siteIds.includes(id));
    active.batch.siteIds.push(...fresh);
    active.batch.remaining.push(...fresh);
    await seedBatchRows(active.id, fresh);
    return { batchId: active.id };
  }

  const batchId = crypto.randomUUID();
  const startedAt = new Date();
  await seedBatchRows(batchId, ids);
  globalState.__activeInventoryBatch = {
    id: batchId,
    batch: {
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

/** Cancels queued work immediately. The Chrome client separately aborts and
 * closes its visible collection window. */
export async function cancelInventoryBatch(batchId: string): Promise<void> {
  const active = globalState.__activeInventoryBatch;
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
