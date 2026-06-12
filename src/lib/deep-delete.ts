import { DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";
import { getR2Bucket, getR2Client } from "@/lib/r2";
import {
  getDb,
  collectionRuns,
  evidence,
  missions,
  runGroups,
  sites,
} from "@/lib/db";

/**
 * Intelligent deletes: rows cascade through Postgres foreign keys, but R2
 * objects must be removed explicitly first — these helpers gather the
 * evidence object keys for a record's blast radius, delete them from R2 in
 * batches, then delete the row (cascading the rest).
 */

async function deleteR2Objects(keys: string[]): Promise<void> {
  const client = getR2Client();
  const bucket = getR2Bucket();
  // DeleteObjects caps at 1000 keys per request.
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: batch.map((Key) => ({ Key })) },
      })
    );
  }
}

function evidenceKeys(
  rows: { screenshotUrl: string | null; htmlUrl: string | null }[]
): string[] {
  return rows
    .flatMap((r) => [r.screenshotUrl, r.htmlUrl])
    .filter((k): k is string => Boolean(k));
}

/** Deletes a run, its evidence (rows + R2 objects), results, offers, and
 *  snapshots. */
export async function deleteRunDeep(runId: string): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({
      screenshotUrl: evidence.screenshotUrl,
      htmlUrl: evidence.htmlUrl,
    })
    .from(evidence)
    .where(eq(evidence.collectionRunId, runId));
  await deleteR2Objects(evidenceKeys(rows));
  await db.delete(collectionRuns).where(eq(collectionRuns.id, runId));
}

/** Deletes a site, its mission configs, group memberships, evidence (rows +
 *  R2 objects), results, and offers. Runs survive (their other sites'
 *  evidence is untouched). */
export async function deleteSiteDeep(siteId: string): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({
      screenshotUrl: evidence.screenshotUrl,
      htmlUrl: evidence.htmlUrl,
    })
    .from(evidence)
    .where(eq(evidence.siteId, siteId));
  await deleteR2Objects(evidenceKeys(rows));
  await db.delete(sites).where(eq(sites.id, siteId));
}

/** Deletes a global mission and its per-site configs and results. Evidence
 *  is keyed by run+site (mission type is just a label on it), so captured
 *  evidence survives. */
export async function deleteMissionDeep(missionId: string): Promise<void> {
  await getDb().delete(missions).where(eq(missions.id, missionId));
}

/** Group deletes carry no evidence; rows cascade. Kept here so every
 *  entity's delete path lives in one module. */
export async function deleteRunGroupDeep(groupId: string): Promise<void> {
  await getDb().delete(runGroups).where(eq(runGroups.id, groupId));
}
