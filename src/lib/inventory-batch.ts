import { getDb, sites, inventoryResults } from "@/lib/db";
import { eq } from "drizzle-orm";
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

// Survives dev-server HMR module reloads; one active batch at a time.
const globalState = globalThis as unknown as {
  __activeInventoryBatch?: { id: string; batch: ActiveBatch } | null;
};
if (globalState.__activeInventoryBatch === undefined) {
  globalState.__activeInventoryBatch = null;
}

export function getActiveInventoryBatch(): { batchId: string; siteIds: string[]; startedAt: Date } | null {
  const active = globalState.__activeInventoryBatch;
  if (!active) return null;
  return { batchId: active.id, siteIds: active.batch.siteIds, startedAt: active.batch.startedAt };
}

export interface InventoryBatchStatus {
  active: boolean;
  siteIds: string[];
  current: string | null;
  startedAt: Date | null;
  results: Record<string, CollectAndStoreResult>;
}

/** Latest result per site within one batch (there should only ever be one
 *  row per site per batch, but guard against retried sites anyway). */
export async function getInventoryBatchStatus(batchId: string): Promise<InventoryBatchStatus> {
  const active = globalState.__activeInventoryBatch;
  const isThisBatch = active?.id === batchId;

  const rows = await getDb()
    .select()
    .from(inventoryResults)
    .where(eq(inventoryResults.batchId, batchId));

  const results: Record<string, CollectAndStoreResult> = {};
  for (const r of rows) {
    results[r.siteId] = {
      id: r.id,
      status: r.status as "ok" | "failed",
      totals: r.totals as CollectAndStoreResult["totals"],
      makeSubtotals: r.makeSubtotals as CollectAndStoreResult["makeSubtotals"],
      models: r.models as CollectAndStoreResult["models"],
      error: r.error as CollectAndStoreResult["error"],
    };
  }

  return {
    active: isThisBatch,
    siteIds: isThisBatch ? active.batch.siteIds : Object.keys(results),
    current: isThisBatch ? active.batch.current : null,
    startedAt: isThisBatch ? active.batch.startedAt : null,
    results,
  };
}

async function runBatch(batchId: string): Promise<void> {
  try {
    while (true) {
      const active = globalState.__activeInventoryBatch;
      if (!active || active.id !== batchId) return;
      const siteId = active.batch.remaining.shift();
      if (!siteId) return;
      active.batch.current = siteId;

      const [site] = await getDb().select().from(sites).where(eq(sites.id, siteId));
      if (!site) continue;

      try {
        await collectAndStore(site, batchId);
      } catch (err) {
        console.error(`[inventory-batch] ${batchId} failed for site ${siteId}:`, err);
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
    return { batchId: active.id };
  }

  const batchId = crypto.randomUUID();
  globalState.__activeInventoryBatch = {
    id: batchId,
    batch: { siteIds: [...ids], remaining: [...ids], current: null, startedAt: new Date() },
  };
  void runBatch(batchId);
  return { batchId };
}

export type { CollectAndStoreResult };
