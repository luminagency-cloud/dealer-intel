"use server";

import { requireSession } from "@/lib/session";
import { startInventoryBatch } from "@/lib/inventory-batch";

/** Starts (or extends) a background inventory batch for the given sites and
 *  returns immediately. Collection runs off-request so it survives the
 *  operator navigating elsewhere in the app — see `inventory-batch.ts`. The
 *  client polls `/api/inventory/batch/[batchId]/status` for progress. */
export async function runInventoryBatch(siteIds: string[]): Promise<{ batchId: string }> {
  await requireSession();
  if (siteIds.length === 0) throw new Error("No sites selected");
  return startInventoryBatch(siteIds);
}
