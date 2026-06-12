import { and, eq } from "drizzle-orm";
import {
  getDb,
  complianceGrades,
  evidence,
  offers,
  sites,
  type Evidence,
} from "@/lib/db";
import { getEvidenceText } from "@/lib/evidence";
import { extractOffers } from "./extract";
import { getComplianceGrader } from "./compliance";

/**
 * Phase 9 analysis runner. Independent, re-runnable passes over a run's stored
 * evidence — no site visits. Reads HTML snapshots, extracts structured offers
 * (classification + normalization), and grades each resulting ad through the
 * compliance service. Re-analysis replaces the run's derived offers and
 * grades, so it is safe to run repeatedly.
 *
 * Runs in the background like collection (a non-awaited task guarded by a
 * module-level active set on globalThis), so the action returns immediately
 * and the run page can poll for the offers to appear.
 */

const globalState = globalThis as unknown as {
  __activeAnalysisRuns?: Set<string>;
};
const activeAnalyses = (globalState.__activeAnalysisRuns ??= new Set<string>());

export function isAnalysisRunning(runId: string): boolean {
  return activeAnalyses.has(runId);
}

interface EvidenceWithBrand {
  evidence: Evidence;
  brand: string | null;
}

async function loadAnalyzableEvidence(
  runId: string
): Promise<EvidenceWithBrand[]> {
  const rows = await getDb()
    .select({ evidence, brand: sites.brand })
    .from(evidence)
    .innerJoin(sites, eq(sites.id, evidence.siteId))
    .where(
      and(
        eq(evidence.collectionRunId, runId),
        eq(evidence.evidenceType, "html_snapshot")
      )
    );
  return rows.map((r) => ({ evidence: r.evidence, brand: r.brand }));
}

async function processAnalysis(
  runId: string,
  rows: EvidenceWithBrand[]
): Promise<void> {
  const db = getDb();
  try {
    // Idempotent re-run: clear this run's derived results before regenerating.
    await db.delete(offers).where(eq(offers.collectionRunId, runId));
    await db
      .delete(complianceGrades)
      .where(eq(complianceGrades.collectionRunId, runId));

    const grader = getComplianceGrader();

    for (const { evidence: row, brand } of rows) {
      const html = await getEvidenceText(row);
      if (!html) continue;

      const extracted = extractOffers(html, {
        missionType: row.missionType,
        brand,
      });

      for (const offer of extracted) {
        await db.insert(offers).values({
          collectionRunId: runId,
          siteId: row.siteId,
          sourceEvidenceId: row.id,
          offerType: offer.offerType,
          vehicleMake: offer.vehicleMake,
          vehicleModel: offer.vehicleModel,
          vehicleTrim: offer.vehicleTrim,
          monthlyPayment: offer.monthlyPayment,
          apr: offer.apr,
          cashIncentive: offer.cashIncentive,
          termMonths: offer.termMonths,
          dueAtSigning: offer.dueAtSigning,
          rawText: offer.rawText,
          normalizedJson: { matches: offer.matches },
          disclaimerText: offer.disclaimerText,
          confidence: offer.confidence,
        });

        // Compliance pass: grade the ad through the external service (stubbed).
        const result = await grader.grade({
          evidenceId: row.id,
          offerType: offer.offerType,
          disclaimerText: offer.disclaimerText,
          adText: offer.rawText,
        });
        await db
          .insert(complianceGrades)
          .values({
            evidenceId: row.id,
            collectionRunId: runId,
            grade: result.grade,
            detailsJson: result.details,
          })
          .onConflictDoUpdate({
            target: complianceGrades.evidenceId,
            set: {
              grade: result.grade,
              detailsJson: result.details,
              gradedAt: new Date(),
            },
          });
      }
    }
  } finally {
    activeAnalyses.delete(runId);
  }
}

/** Starts background analysis for a run. Returns the number of evidence
 *  snapshots queued, or null when analysis is already running for this run. */
export async function startAnalysis(runId: string): Promise<number | null> {
  if (activeAnalyses.has(runId)) return null;
  activeAnalyses.add(runId);
  try {
    const rows = await loadAnalyzableEvidence(runId);
    if (rows.length === 0) {
      activeAnalyses.delete(runId);
      return 0;
    }
    void processAnalysis(runId, rows).catch((err) => {
      console.error(`analysis for run ${runId} crashed:`, err);
      activeAnalyses.delete(runId);
    });
    return rows.length;
  } catch (err) {
    activeAnalyses.delete(runId);
    throw err;
  }
}
