import { getDb, inventoryResults, sites } from "@/lib/db";
import { getISOWeekLabel } from "@/lib/cycle";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { collectAndStore, type CollectAndStoreResult } from "@/lib/inventory";

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
  | CollectAndStoreResult;

// Survives dev-server HMR module reloads; one active batch at a time.
const globalState = globalThis as unknown as {
  __activeInventoryBatch?: { id: string; batch: ActiveBatch } | null;
};
if (globalState.__activeInventoryBatch === undefined) {
  globalState.__activeInventoryBatch = null;
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
    }))
  );
}

export async function getActiveInventoryBatch(): Promise<{ batchId: string; siteIds: string[]; startedAt: Date } | null> {
  const active = globalState.__activeInventoryBatch;
  if (active) {
    return { batchId: active.id, siteIds: active.batch.siteIds, startedAt: active.batch.startedAt };
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

async function markBatchRow(siteId: string, batchId: string, status: "running" | "failed", error?: { message: string; code: string }) {
  await getDb()
    .update(inventoryResults)
    .set({
      status,
      collectedAt: new Date(),
      ...(status === "failed" ? { error: error ?? { message: "Unexpected inventory batch error", code: "unexpected_error" } } : {}),
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
      } catch (err) {
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
    revalidatePath("/inventory");
  }
}

/** Starts a new inventory batch, or appends to the currently active one.
 *  Returns immediately — the actual collection runs in the background. */
export async function startInventoryBatch(siteIds: string[]): Promise<{ batchId: string }> {
  const ids = [...new Set(siteIds)];
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
    batch: { siteIds: [...ids], remaining: [...ids], current: null, startedAt },
  };
  void runBatch(batchId);
  return { batchId };
}

export type { CollectAndStoreResult };
