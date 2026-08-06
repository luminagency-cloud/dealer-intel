"use server";

import { requireSession } from "@/lib/session";
import { cancelInventoryBatch, startChromeInventoryBatch } from "@/lib/inventory-batch";

/** Seeds (or extends) an inventory batch for the given sites and returns
 *  immediately. Collection is driven by the Chrome Collector extension; the
 *  client polls `/api/inventory/batch/[batchId]/status` for progress. */
export async function runInventoryBatch(siteIds: string[]): Promise<{ batchId: string }> {
  await requireSession();
  if (siteIds.length === 0) throw new Error("No sites selected");
  return startChromeInventoryBatch(siteIds);
}

export async function cancelInventoryBatchAction(batchId: string): Promise<void> {
  await requireSession();
  await cancelInventoryBatch(batchId);
}
