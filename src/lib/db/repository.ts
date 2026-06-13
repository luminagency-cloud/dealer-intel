import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "./index";
import {
  collectionRunMissions,
  collectionRunSites,
  collectionRuns,
  complianceGrades,
  siteMissions,
  evidence,
  missionResults,
  missions,
  offers,
  reportSnapshots,
  runGroupMembers,
  siteRelationships,
  sites,
  snapshotOffers,
  type ComplianceGrade,
  type Mission,
  type SiteMission,
  type MissionResult,
  type Site,
  type CollectionRun,
  type Evidence,
  type NewCollectionRun,
  type NewEvidence,
  type NewOffer,
  type NewReportSnapshot,
  type NewSiteRelationship,
  type Offer,
  type ReportSnapshot,
  type RunStatus,
  type SiteRelationship,
  type SnapshotOffer,
} from "./schema";

/**
 * CRUD for the Phase 2 entities that have no admin UI yet. Sites and
 * missions keep their server actions; later phases (run management,
 * evidence services, discovery) build on these functions.
 */

// --- Site Relationships -------------------------------------------------

export async function createSiteRelationship(
  data: NewSiteRelationship
): Promise<SiteRelationship> {
  const [row] = await getDb().insert(siteRelationships).values(data).returning();
  return row;
}

export async function listSiteRelationships(
  siteId?: string
): Promise<SiteRelationship[]> {
  const db = getDb();
  return siteId
    ? db
        .select()
        .from(siteRelationships)
        .where(eq(siteRelationships.siteId, siteId))
    : db.select().from(siteRelationships);
}

export async function deleteSiteRelationship(id: string): Promise<void> {
  await getDb().delete(siteRelationships).where(eq(siteRelationships.id, id));
}

// --- Collection Runs ----------------------------------------------------

export async function createCollectionRun(
  data: NewCollectionRun = {}
): Promise<CollectionRun> {
  const [row] = await getDb().insert(collectionRuns).values(data).returning();
  return row;
}

export async function getCollectionRun(
  id: string
): Promise<CollectionRun | undefined> {
  const [row] = await getDb()
    .select()
    .from(collectionRuns)
    .where(eq(collectionRuns.id, id));
  return row;
}

export async function listCollectionRuns(): Promise<CollectionRun[]> {
  return getDb()
    .select()
    .from(collectionRuns)
    .orderBy(desc(collectionRuns.createdAt));
}

export async function updateCollectionRunStatus(
  id: string,
  status: RunStatus,
  timestamps: Pick<NewCollectionRun, "startedAt" | "completedAt"> = {}
): Promise<CollectionRun | undefined> {
  const [row] = await getDb()
    .update(collectionRuns)
    .set({ status, ...timestamps })
    .where(eq(collectionRuns.id, id))
    .returning();
  return row;
}

/** A unit of collection work: one global mission applied to one site, with
 *  the site's URL config/memory when it exists. */
export interface WorkItem {
  site: Site;
  mission: Mission;
  siteMission: SiteMission | null;
}

async function listScopedSites(scope?: {
  runGroupId?: string | null;
  siteIds?: string[];
}): Promise<Site[]> {
  const db = getDb();
  if (scope?.siteIds && scope.siteIds.length > 0) {
    return db
      .select()
      .from(sites)
      .where(and(eq(sites.active, true), inArray(sites.id, scope.siteIds)))
      .orderBy(asc(sites.name));
  }
  if (scope?.runGroupId) {
    return db
      .select({ sites })
      .from(sites)
      .innerJoin(
        runGroupMembers,
        and(
          eq(runGroupMembers.siteId, sites.id),
          eq(runGroupMembers.runGroupId, scope.runGroupId)
        )
      )
      .where(eq(sites.active, true))
      .orderBy(asc(sites.name))
      .then((rows) => rows.map((r) => r.sites));
  }
  return db
    .select()
    .from(sites)
    .where(eq(sites.active, true))
    .orderBy(asc(sites.name));
}

/** The work list a run executes: scoped sites x selected active missions,
 *  with per-site config attached where it exists. */
export async function listWorkItemsForRun(run: {
  id: string;
  runGroupId: string | null;
}): Promise<WorkItem[]> {
  const db = getDb();

  const adHoc = run.runGroupId
    ? []
    : await db
        .select({ siteId: collectionRunSites.siteId })
        .from(collectionRunSites)
        .where(eq(collectionRunSites.collectionRunId, run.id));

  const [scopedSites, allMissions, selectedMissionRows] = await Promise.all([
    listScopedSites({
      runGroupId: run.runGroupId,
      siteIds: adHoc.map((r) => r.siteId),
    }),
    db
      .select()
      .from(missions)
      .where(eq(missions.active, true))
      .orderBy(asc(missions.name)),
    db
      .select({ missionId: collectionRunMissions.missionId })
      .from(collectionRunMissions)
      .where(eq(collectionRunMissions.collectionRunId, run.id)),
  ]);

  const selected = new Set(selectedMissionRows.map((r) => r.missionId));
  const runMissions =
    selected.size > 0
      ? allMissions.filter((m) => selected.has(m.id))
      : allMissions;

  const siteIds = scopedSites.map((s) => s.id);
  const configs =
    siteIds.length > 0
      ? await db
          .select()
          .from(siteMissions)
          .where(inArray(siteMissions.siteId, siteIds))
      : [];
  const configByKey = new Map(
    configs.map((c) => [`${c.siteId}:${c.missionId}`, c])
  );

  const items: WorkItem[] = [];
  for (const site of scopedSites) {
    for (const mission of runMissions) {
      const config = configByKey.get(`${site.id}:${mission.id}`) ?? null;
      // A per-site disable opts the pair out of runs.
      if (config && !config.active) continue;
      items.push({ site, mission, siteMission: config });
    }
  }
  return items;
}

// --- Mission Results ------------------------------------------------------

export async function listResultsForRun(
  collectionRunId: string
): Promise<MissionResult[]> {
  return getDb()
    .select()
    .from(missionResults)
    .where(eq(missionResults.collectionRunId, collectionRunId));
}

// --- Evidence -----------------------------------------------------------

export async function createEvidence(data: NewEvidence): Promise<Evidence> {
  const [row] = await getDb().insert(evidence).values(data).returning();
  return row;
}

export async function getEvidence(id: string): Promise<Evidence | undefined> {
  const [row] = await getDb().select().from(evidence).where(eq(evidence.id, id));
  return row;
}

export async function listEvidenceForRun(
  collectionRunId: string
): Promise<Evidence[]> {
  return getDb()
    .select()
    .from(evidence)
    .where(eq(evidence.collectionRunId, collectionRunId));
}

export async function deleteEvidence(id: string): Promise<void> {
  await getDb().delete(evidence).where(eq(evidence.id, id));
}

// --- Offers ---------------------------------------------------------------

export async function createOffer(data: NewOffer): Promise<Offer> {
  const [row] = await getDb().insert(offers).values(data).returning();
  return row;
}

export async function listOffersForRun(
  collectionRunId: string
): Promise<Offer[]> {
  return getDb()
    .select()
    .from(offers)
    .where(eq(offers.collectionRunId, collectionRunId));
}

export async function updateOffer(
  id: string,
  data: Partial<NewOffer>
): Promise<Offer | undefined> {
  const [row] = await getDb()
    .update(offers)
    .set(data)
    .where(eq(offers.id, id))
    .returning();
  return row;
}

export async function deleteOffer(id: string): Promise<void> {
  await getDb().delete(offers).where(eq(offers.id, id));
}

// --- Compliance Grades ----------------------------------------------------

export async function listComplianceGradesForRun(
  collectionRunId: string
): Promise<ComplianceGrade[]> {
  return getDb()
    .select()
    .from(complianceGrades)
    .where(eq(complianceGrades.collectionRunId, collectionRunId));
}

// --- Report Snapshots -----------------------------------------------------

export async function createReportSnapshot(
  data: NewReportSnapshot
): Promise<ReportSnapshot> {
  const [row] = await getDb().insert(reportSnapshots).values(data).returning();
  return row;
}

export async function getReportSnapshot(
  id: string
): Promise<ReportSnapshot | undefined> {
  const [row] = await getDb()
    .select()
    .from(reportSnapshots)
    .where(eq(reportSnapshots.id, id));
  return row;
}

export async function listReportSnapshots(): Promise<ReportSnapshot[]> {
  return getDb()
    .select()
    .from(reportSnapshots)
    .orderBy(desc(reportSnapshots.approvedAt));
}

/** Snapshots created from a single run, newest first (a run can be
 *  re-published after re-analysis, so there may be more than one). */
export async function listSnapshotsForRun(
  collectionRunId: string
): Promise<ReportSnapshot[]> {
  return getDb()
    .select()
    .from(reportSnapshots)
    .where(eq(reportSnapshots.collectionRunId, collectionRunId))
    .orderBy(desc(reportSnapshots.approvedAt));
}

/** The frozen offers belonging to a snapshot — the only data a report reads. */
export async function listSnapshotOffers(
  snapshotId: string
): Promise<SnapshotOffer[]> {
  return getDb()
    .select()
    .from(snapshotOffers)
    .where(eq(snapshotOffers.snapshotId, snapshotId))
    .orderBy(asc(snapshotOffers.siteName));
}

export async function deleteReportSnapshot(id: string): Promise<void> {
  // snapshot_offers cascade via FK; the snapshot owns no R2 objects (it links
  // to the run's evidence, which the run delete cleans up).
  await getDb().delete(reportSnapshots).where(eq(reportSnapshots.id, id));
}

/** Snapshots cut from a run group, newest first — the group's report history
 *  for trend/historical comparison (Phase 11). */
export async function listSnapshotsForGroup(
  runGroupId: string
): Promise<ReportSnapshot[]> {
  return getDb()
    .select()
    .from(reportSnapshots)
    .where(eq(reportSnapshots.runGroupId, runGroupId))
    .orderBy(desc(reportSnapshots.approvedAt));
}

/** Site ids flagged primary in a run group — reporting anchors competitive
 *  comparisons on the primary dealer(s). Read live: group membership is a
 *  Phase 11 reporting input (AD-002), distinct from the frozen offer data. */
export async function getPrimarySiteIds(
  runGroupId: string
): Promise<Set<string>> {
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
