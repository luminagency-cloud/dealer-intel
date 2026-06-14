import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "./index";
import {
  reportSnapshots,
  runGroupMembers,
  runGroups,
  snapshotOffers,
  userRunGroups,
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
