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
import { extractOffers, findKnownModel } from "./extract";
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

interface CapturedDisclaimer {
  siteId: string;
  text: string;
}

/** Disclaimer-modal text captured during collection (evidence.text_content on
 *  disclaimer_screenshot rows). This is the real fine print the HTML snapshot
 *  often misses, used to backfill an offer's disclaimer when the HTML pass
 *  found none. */
async function loadCapturedDisclaimers(
  runId: string
): Promise<CapturedDisclaimer[]> {
  const rows = await getDb()
    .select({ siteId: evidence.siteId, text: evidence.textContent })
    .from(evidence)
    .where(
      and(
        eq(evidence.collectionRunId, runId),
        eq(evidence.evidenceType, "disclaimer_screenshot")
      )
    );
  return rows
    .filter((r): r is CapturedDisclaimer => Boolean(r.text))
    .map((r) => ({ siteId: r.siteId, text: r.text }));
}

/** The disclaimer (fine-print) portion of a captured modal text, dropping the
 *  leading offer line and the "DISCLAIMER Disclaimer:" markers. */
function disclaimerPortion(modalText: string): string {
  const colon = modalText.search(/disclaimer\s*:/i);
  if (colon >= 0) {
    const after = modalText.indexOf(":", colon);
    if (after >= 0) return modalText.slice(after + 1).trim();
  }
  const any = modalText.search(/disclaimer/i);
  return (any >= 0 ? modalText.slice(any) : modalText).trim();
}

/** Finds the captured disclaimer that belongs to this offer by matching the
 *  monthly payment — a high-precision, offer-specific token. Cash amounts and
 *  bare model names are deliberately NOT used: they false-match (a "$15" coupon
 *  hits "$15,000", and a model name hits a modal that lists several vehicles),
 *  and a wrong disclaimer is worse than none for the compliance pass. Offers
 *  without a monthly payment (e.g. APR-only finance) get no backfill.
 *
 *  Returns the disclaimer text and the model named in it. The payment-matched
 *  disclaimer describes exactly this offer, so its model is authoritative — it
 *  corrects the page-level vehicle guess, which can grab the wrong model from a
 *  multi-offer page (e.g. a $475 Tundra lease mislabeled "Corolla"). */
function matchCapturedDisclaimer(
  offer: { monthlyPayment: number | null },
  siteId: string,
  disclaimers: CapturedDisclaimer[]
): { text: string; model: string | null } | null {
  if (offer.monthlyPayment == null) return null;
  // "$205" but not "$205,000" or "$2,050" — bounded so the amount is exact.
  const amountRe = new RegExp(`\\$\\s?${offer.monthlyPayment}(?![\\d,])`);

  for (const d of disclaimers) {
    if (d.siteId !== siteId) continue;
    if (amountRe.test(d.text)) {
      return {
        text: disclaimerPortion(d.text).slice(0, 1000),
        model: findKnownModel(d.text),
      };
    }
  }
  return null;
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
    const capturedDisclaimers = await loadCapturedDisclaimers(runId);
    // Dedup: the same offer often appears on several pages (one offer per
    // evidence × many finance/lease pages). Keep one row per distinct offer
    // signature per site.
    const seen = new Set<string>();

    for (const { evidence: row, brand } of rows) {
      const html = await getEvidenceText(row);
      if (!html) continue;

      const extracted = extractOffers(html, {
        missionType: row.missionType,
        brand,
      });

      for (const offer of extracted) {
        const signature = [
          row.siteId,
          offer.offerType,
          offer.vehicleModel ?? "",
          offer.monthlyPayment ?? "",
          offer.apr ?? "",
          offer.termMonths ?? "",
          offer.cashIncentive ?? "",
          offer.dueAtSigning ?? "",
        ].join("|");
        if (seen.has(signature)) continue;
        seen.add(signature);

        // Pair the captured disclaimer-modal text to this offer by payment.
        const matched = matchCapturedDisclaimer(
          offer,
          row.siteId,
          capturedDisclaimers
        );
        // Prefer the HTML-extracted ad disclaimer; backfill from the captured
        // modal text when the HTML pass found none.
        const disclaimerText = offer.disclaimerText ?? matched?.text ?? null;
        // The payment-matched disclaimer names this exact offer's vehicle —
        // authoritative over the page-level model guess.
        const vehicleModel = matched?.model ?? offer.vehicleModel;

        await db.insert(offers).values({
          collectionRunId: runId,
          siteId: row.siteId,
          sourceEvidenceId: row.id,
          offerType: offer.offerType,
          vehicleMake: offer.vehicleMake,
          vehicleModel,
          vehicleTrim: offer.vehicleTrim,
          monthlyPayment: offer.monthlyPayment,
          apr: offer.apr,
          cashIncentive: offer.cashIncentive,
          termMonths: offer.termMonths,
          dueAtSigning: offer.dueAtSigning,
          rawText: offer.rawText,
          normalizedJson: { matches: offer.matches },
          disclaimerText,
          confidence: offer.confidence,
        });

        // Compliance pass: grade the ad through the external service (stubbed).
        const result = await grader.grade({
          evidenceId: row.id,
          offerType: offer.offerType,
          disclaimerText,
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
