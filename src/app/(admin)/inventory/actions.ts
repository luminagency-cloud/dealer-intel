"use server";

import { revalidatePath } from "next/cache";
import { randomUUID } from "crypto";
import { asc, eq, inArray } from "drizzle-orm";
import { getDb, runGroupMembers, sites } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { collectAndStore } from "@/lib/inventory";

/** Run inventory collection for a single dealer. */
export async function runInventoryForSite(siteId: string) {
  await requireSession();
  const db = getDb();
  const [site] = await db
    .select()
    .from(sites)
    .where(eq(sites.id, siteId));
  if (!site) throw new Error("Site not found");

  const batchId = randomUUID();
  await collectAndStore(site, batchId);
  revalidatePath("/inventory");
}

/** Run inventory collection for all active sites in a run group. */
export async function runInventoryForGroup(groupId: string) {
  await requireSession();
  const db = getDb();

  const members = await db
    .select({ siteId: runGroupMembers.siteId })
    .from(runGroupMembers)
    .where(eq(runGroupMembers.runGroupId, groupId));

  if (members.length === 0) return;

  const siteIds = members.map((m) => m.siteId);
  const groupSites = await db
    .select()
    .from(sites)
    .where(inArray(sites.id, siteIds))
    .orderBy(asc(sites.name));

  const activeSites = groupSites.filter((s) => s.active);
  if (activeSites.length === 0) return;

  const batchId = randomUUID();
  // Run sequentially — one at a time as the API doc implies
  for (const site of activeSites) {
    await collectAndStore(site, batchId);
    revalidatePath("/inventory");
  }
}
