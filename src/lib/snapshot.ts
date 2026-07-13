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
import { getEvidencePublicUrl } from "@/lib/evidence";

/** Minimum offer confidence to publish into a snapshot. An offer scoring below
 *  this is treated as junk and never enters a report — the only confidence
 *  cutoff in the whole reporting path. Env-tunable (REPORT_MIN_CONFIDENCE);
 *  default 0.6. Null-confidence offers are kept (unknown ≠ low). */
export function reportMinConfidence(): number {
  return Number(process.env.REPORT_MIN_CONFIDENCE ?? 0.6);
}

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
 *  (analysis must run before a meaningful snapshot exists).
 *
 *  Pass `groupFilter` to restrict the snapshot to a specific group's sites —
 *  used when publishing a combined multi-group run as separate per-group
 *  snapshots. The filter overrides the run's own runGroupId. */
export async function createSnapshotFromRun(
  runId: string,
  approvedBy: string,
  label?: string | null,
  groupFilter?: { id: string; name: string; siteIds: string[] }
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
      evidenceScreenshotUrl: evidence.screenshotUrl,
      evidenceHtmlUrl: evidence.htmlUrl,
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

  // When a groupFilter is provided, restrict to that group's sites only.
  const scopedRows = groupFilter
    ? rows.filter((r) => groupFilter.siteIds.includes(r.offer.siteId))
    : rows;
  if (scopedRows.length === 0) return null;

  // Confidence gate: drop low-confidence offers so obvious junk (partial
  // extractions, weak single-signal guesses) never reaches a report. This is
  // the reporting cutoff — below the floor an offer is excluded from the frozen
  // copy entirely. Already-published snapshots are unaffected; re-publish a run
  // to apply a new floor. An offer an operator explicitly PASSED (reviewed) is
  // an override: they vouched for it, so it publishes regardless of score.
  const minConfidence = reportMinConfidence();
  const filteredRows = scopedRows.filter((r) => {
    const reviewed =
      (r.offer.normalizedJson as { reviewed?: boolean } | null)?.reviewed ===
      true;
    return (
      reviewed || r.offer.confidence == null || r.offer.confidence >= minConfidence
    );
  });
  if (filteredRows.length === 0) return null;

  // Resolve group scope: groupFilter overrides the run's own runGroupId.
  let effectiveGroupId: string | null = groupFilter?.id ?? null;
  let effectiveGroupName: string | null = groupFilter?.name ?? null;
  if (!groupFilter) {
    const [run] = await db
      .select({ runGroupId: collectionRuns.runGroupId })
      .from(collectionRuns)
      .where(eq(collectionRuns.id, runId));
    effectiveGroupId = run?.runGroupId ?? null;
    if (effectiveGroupId) {
      const [group] = await db
        .select({ name: runGroups.name })
        .from(runGroups)
        .where(eq(runGroups.id, effectiveGroupId));
      effectiveGroupName = group?.name ?? null;
    }
  }

  const distinctSites = new Set(filteredRows.map((r) => r.offer.siteId)).size;

  const [snapshot] = await db
    .insert(reportSnapshots)
    .values({
      collectionRunId: runId,
      runGroupId: effectiveGroupId,
      runGroupName: effectiveGroupName,
      label: label?.trim() || null,
      offerCount: filteredRows.length,
      siteCount: distinctSites,
      approvedBy,
    })
    .returning();

  await db.insert(snapshotOffers).values(
    filteredRows.map((r) => {
      const key = r.evidenceScreenshotUrl ?? r.evidenceHtmlUrl ?? null;
      const evidenceUrl = key ? getEvidencePublicUrl(key) : null;
      return {
      snapshotId: snapshot.id,
      siteId: r.offer.siteId,
      siteName: r.siteName,
      siteBrand: r.siteBrand,
      siteState: r.siteState,
      sourceEvidenceId: r.offer.sourceEvidenceId,
      evidenceUrl,
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
      salePrice: r.offer.salePrice,
      termMonths: r.offer.termMonths,
      dueAtSigning: r.offer.dueAtSigning,
      mileageAllowance: r.offer.mileageAllowance,
      rawText: r.offer.rawText,
      normalizedJson: r.offer.normalizedJson,
      disclaimerText: r.offer.disclaimerText,
      confidence: r.offer.confidence,
      complianceGrade: r.grade ?? null,
      complianceDetailsJson: r.gradeDetails ?? null,
      };
    })
  );

  return snapshot;
}
