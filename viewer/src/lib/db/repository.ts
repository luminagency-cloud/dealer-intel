import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { getDb } from "./index";
import {
  evidence,
  inventoryResults,
  newsItems,
  reportSnapshots,
  runGroupMembers,
  runGroups,
  snapshotOffers,
  userRunGroups,
  type Evidence,
  type InventoryResult,
  type ReportSnapshot,
  type SnapshotOffer,
} from "./schema";

export async function getSnapshot(id: string): Promise<ReportSnapshot | null> {
  const [row] = await getDb()
    .select()
    .from(reportSnapshots)
    .where(eq(reportSnapshots.id, id));
  return row ?? null;
}

/**
 * Look up a snapshot by its public share token, but only if it is released
 * (`clientVisible`). Returns null for unknown tokens or unpublished snapshots,
 * so revoked/draft links 404. This is the only lookup the public /r/ route uses.
 */
export async function getSnapshotByShareToken(
  token: string
): Promise<ReportSnapshot | null> {
  if (!token) return null;
  const [row] = await getDb()
    .select()
    .from(reportSnapshots)
    .where(
      and(
        eq(reportSnapshots.shareToken, token),
        eq(reportSnapshots.clientVisible, true)
      )
    );
  return row ?? null;
}

export async function listSnapshotOffers(snapshotId: string): Promise<SnapshotOffer[]> {
  return getDb()
    .select()
    .from(snapshotOffers)
    .where(eq(snapshotOffers.snapshotId, snapshotId))
    .orderBy(asc(snapshotOffers.siteName));
}

/** Run groups accessible to a dealer user (by user_run_groups join). */
export async function getUserRunGroups(
  userId: string
): Promise<{ id: string; name: string }[]> {
  const rows = await getDb()
    .select({ id: runGroups.id, name: runGroups.name })
    .from(userRunGroups)
    .innerJoin(runGroups, eq(runGroups.id, userRunGroups.runGroupId))
    .where(eq(userRunGroups.userId, userId))
    .orderBy(asc(runGroups.name));
  return rows;
}

/** All run groups — for admin users who see everything. */
export async function getAllRunGroups(): Promise<{ id: string; name: string }[]> {
  return getDb()
    .select({ id: runGroups.id, name: runGroups.name })
    .from(runGroups)
    .orderBy(asc(runGroups.name));
}

/** Client-visible snapshots for a set of run group ids, newest first. */
export async function listVisibleSnapshots(
  runGroupIds: string[]
): Promise<ReportSnapshot[]> {
  if (runGroupIds.length === 0) return [];
  return getDb()
    .select()
    .from(reportSnapshots)
    .where(
      and(
        inArray(reportSnapshots.runGroupId, runGroupIds),
        eq(reportSnapshots.clientVisible, true)
      )
    )
    .orderBy(desc(reportSnapshots.approvedAt));
}

/** All snapshots (admin view — no clientVisible filter). */
export async function listAllSnapshots(): Promise<ReportSnapshot[]> {
  return getDb()
    .select()
    .from(reportSnapshots)
    .orderBy(desc(reportSnapshots.approvedAt));
}

export async function getPrimarySiteIds(runGroupId: string): Promise<Set<string>> {
  const rows = await getDb()
    .select({ siteId: runGroupMembers.siteId })
    .from(runGroupMembers)
    .where(
      and(
        eq(runGroupMembers.runGroupId, runGroupId),
        eq(runGroupMembers.isPrimary, true)
      )
    );
  return new Set(rows.map((r) => r.siteId));
}

export async function listLatestInventoryForSites(
  siteIds: string[]
): Promise<InventoryResult[]> {
  if (siteIds.length === 0) return [];
  const rows = await getDb()
    .select()
    .from(inventoryResults)
    .where(and(inArray(inventoryResults.siteId, siteIds), eq(inventoryResults.status, "ok")))
    .orderBy(desc(inventoryResults.collectedAt));
  const seen = new Set<string>();
  const latest: InventoryResult[] = [];
  for (const row of rows) {
    if (!seen.has(row.siteId)) {
      seen.add(row.siteId);
      latest.push(row);
    }
  }
  return latest;
}

export async function getStoredNewsForReport(
  brand: string | null
): Promise<import("../news").NewsData | null> {
  const now = new Date();
  const jan4 = new Date(now.getFullYear(), 0, 4);
  const weekNum = Math.ceil(((now.getTime() - jan4.getTime()) / 86400000 + jan4.getDay() + 1) / 7);
  const weekKey = `${now.getFullYear()}-W${String(weekNum).padStart(2, "0")}`;
  const db = getDb();
  const brandSlug = brand?.toLowerCase() ?? null;

  const rows = await db
    .select()
    .from(newsItems)
    .where(
      and(
        eq(newsItems.weekKey, weekKey),
        brandSlug
          ? or(isNull(newsItems.brand), eq(newsItems.brand, brandSlug))
          : isNull(newsItems.brand)
      )
    )
    .orderBy(desc(newsItems.pulledAt));

  if (rows.length === 0) return null;

  const toItem = (r: typeof rows[0]) => ({
    id: r.id,
    headline: r.headline,
    summary: r.summary,
    source_url: r.sourceUrl,
    published_at: r.publishedAt,
    category: r.category as import("../news").NewsItem["category"],
    brand: r.brand,
  });

  return {
    audience: "dealer",
    brand: brandSlug,
    week: weekKey,
    collected_at: rows[0].pulledAt.toISOString(),
    fresh: true,
    all_items: rows.map(toItem),
    brand_items: rows.filter((r) => r.brand !== null).slice(0, 6).map(toItem),
    industry_items: rows.filter((r) => r.brand === null).slice(0, 4).map(toItem),
    brand_groups: [],
  };
}

/** Evidence for one offer on a PUBLISHED, share-token-scoped snapshot — the
 *  access-control boundary for viewer's evidence links. Mirrors the main
 *  app's `getEvidenceForPublicSnapshotOffer`. Used by both viewer report
 *  routes (the public /r/ route and the authenticated /reports/ route),
 *  since both already have the snapshot's shareToken in hand — no separate
 *  admin-vs-public access mode needed here (viewer never renders with admin
 *  controls). */
export async function getEvidenceForPublicSnapshotOffer(
  shareToken: string,
  snapshotOfferId: string
): Promise<Evidence | undefined> {
  const [row] = await getDb()
    .select({ evidence })
    .from(snapshotOffers)
    .innerJoin(
      reportSnapshots,
      and(
        eq(snapshotOffers.snapshotId, reportSnapshots.id),
        eq(reportSnapshots.shareToken, shareToken),
        eq(reportSnapshots.clientVisible, true)
      )
    )
    .innerJoin(evidence, eq(evidence.id, snapshotOffers.sourceEvidenceId))
    .where(eq(snapshotOffers.id, snapshotOfferId));
  return row?.evidence;
}

export async function listSnapshotsForGroup(
  runGroupId: string
): Promise<ReportSnapshot[]> {
  return getDb()
    .select()
    .from(reportSnapshots)
    .where(
      and(
        eq(reportSnapshots.runGroupId, runGroupId),
        eq(reportSnapshots.clientVisible, true)
      )
    )
    .orderBy(desc(reportSnapshots.approvedAt));
}
