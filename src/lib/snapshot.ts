import { asc, eq } from "drizzle-orm";
import {
  getDb,
  collectionRuns,
  complianceGrades,
  evidence,
  offers,
  reportSnapshots,
  runGroups,
  sites,
  snapshotOffers,
  type ReportSnapshot,
} from "@/lib/db";

/**
 * Phase 10 — Snapshot Publishing. The wall between analysis and reporting.
 *
 * A snapshot is a FROZEN copy of a run's analysis output (the offers produced
 * by classification/normalization, each carrying its compliance grade) taken at
 * approval time. Once written it never changes: re-running analysis or
 * re-collecting the run does not touch a published snapshot. Reports (Phase 11)
 * read only from `report_snapshots` + `snapshot_offers`, never from the live
 * `offers`/`compliance_grades` tables.
 */

/** Freezes a run's current analysis output into a new snapshot. Returns the
 *  snapshot row, or null when the run has no analyzed offers to publish yet
 *  (analysis must run before a meaningful snapshot exists). */
export async function createSnapshotFromRun(
  runId: string,
  approvedBy: string,
  label?: string | null
): Promise<ReportSnapshot | null> {
  const db = getDb();

  // Pull the run's offers joined to live site identity and the per-evidence
  // compliance grade — everything the frozen copy needs in one read.
  const rows = await db
    .select({
      offer: offers,
      siteName: sites.name,
      siteBrand: sites.brand,
      siteState: sites.state,
      missionType: evidence.missionType,
      grade: complianceGrades.grade,
      gradeDetails: complianceGrades.detailsJson,
    })
    .from(offers)
    .innerJoin(sites, eq(sites.id, offers.siteId))
    .leftJoin(evidence, eq(evidence.id, offers.sourceEvidenceId))
    .leftJoin(
      complianceGrades,
      eq(complianceGrades.evidenceId, offers.sourceEvidenceId)
    )
    .where(eq(offers.collectionRunId, runId))
    .orderBy(asc(sites.name));

  if (rows.length === 0) return null;

  // Freeze the run's group scope (label survives a later group rename/delete).
  const [run] = await db
    .select({ runGroupId: collectionRuns.runGroupId })
    .from(collectionRuns)
    .where(eq(collectionRuns.id, runId));
  let runGroupName: string | null = null;
  if (run?.runGroupId) {
    const [group] = await db
      .select({ name: runGroups.name })
      .from(runGroups)
      .where(eq(runGroups.id, run.runGroupId));
    runGroupName = group?.name ?? null;
  }

  const distinctSites = new Set(rows.map((r) => r.offer.siteId)).size;

  const [snapshot] = await db
    .insert(reportSnapshots)
    .values({
      collectionRunId: runId,
      runGroupId: run?.runGroupId ?? null,
      runGroupName,
      label: label?.trim() || null,
      offerCount: rows.length,
      siteCount: distinctSites,
      approvedBy,
    })
    .returning();

  await db.insert(snapshotOffers).values(
    rows.map((r) => ({
      snapshotId: snapshot.id,
      siteId: r.offer.siteId,
      siteName: r.siteName,
      siteBrand: r.siteBrand,
      siteState: r.siteState,
      sourceEvidenceId: r.offer.sourceEvidenceId,
      // Mission type lives on the evidence; fall back to homepage when the
      // source evidence is gone (shouldn't happen for a live run).
      missionType: r.missionType ?? "homepage_offers",
      offerType: r.offer.offerType,
      vehicleMake: r.offer.vehicleMake,
      vehicleModel: r.offer.vehicleModel,
      vehicleTrim: r.offer.vehicleTrim,
      monthlyPayment: r.offer.monthlyPayment,
      apr: r.offer.apr,
      cashIncentive: r.offer.cashIncentive,
      termMonths: r.offer.termMonths,
      dueAtSigning: r.offer.dueAtSigning,
      rawText: r.offer.rawText,
      normalizedJson: r.offer.normalizedJson,
      disclaimerText: r.offer.disclaimerText,
      confidence: r.offer.confidence,
      complianceGrade: r.grade ?? null,
      complianceDetailsJson: r.gradeDetails ?? null,
    }))
  );

  return snapshot;
}
