"use server";

import { revalidatePath } from "next/cache";
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { getDb, sites } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { collectAndStore, type CollectAndStoreResult } from "@/lib/inventory";

/** Run inventory collection for a single dealer. Returns the result so the
 *  client can update state immediately without waiting for a page refresh. */
export async function runInventoryForSite(siteId: string): Promise<CollectAndStoreResult> {
  await requireSession();
  const db = getDb();
  const [site] = await db.select().from(sites).where(eq(sites.id, siteId));
  if (!site) throw new Error("Site not found");

  const batchId = randomUUID();
  const result = await collectAndStore(site, batchId);
  revalidatePath("/inventory");
  return result;
}
