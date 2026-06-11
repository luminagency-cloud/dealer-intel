import { desc, eq } from "drizzle-orm";
import { getDb } from "./index";
import {
  collectionRuns,
  evidence,
  offers,
  reportSnapshots,
  siteRelationships,
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
