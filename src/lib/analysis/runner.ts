import { and, eq } from "drizzle-orm";
import {
  getDb,
  collectionRuns,
  complianceGrades,
  evidence,
  offers,
  sites,
  type Evidence,
} from "@/lib/db";
import { getEvidenceBody, getEvidenceText } from "@/lib/evidence";
import { extractOffers, findKnownModel, htmlToText } from "./extract";
import { getComplianceGrader } from "./compliance";
import {
  aiConfidenceThreshold,
  getOfferEnricher,
} from "./ai-enrich";

/**
 * Phase 9 analysis runner. Independent, re-runnable passes over a run's stored
 * evidence — no site visits. Reads HTML snapshots, extracts structured offers
 * (classification + normalization), and grades each resulting ad through the
 * compliance service. Re-analysis replaces the run's derived offers and
 * grades, so it is safe to run repeatedly.
 */

const globalState = globalThis as unknown as {
  __activeAnalysisRuns?: Set<string>;
};
const activeAnalyses = (globalState.__activeAnalysisRuns ??= new Set<string>());

export function isAnalysisRunning(runId: string): boolean {
  return activeAnalyses.has(runId);
}

interface SiteInfo {
  brand: string | null;
  name: string;
  state: string | null;
  otherStates: string[] | null;
}

interface EvidenceWithSite {
  evidence: Evidence;
  site: SiteInfo;
}

async function loadAnalyzableEvidence(
  runId: string
): Promise<EvidenceWithSite[]> {
  const rows = await getDb()
    .select({
      evidence,
      brand: sites.brand,
      name: sites.name,
      state: sites.state,
      otherStates: sites.otherStates,
    })
    .from(evidence)
    .innerJoin(sites, eq(sites.id, evidence.siteId))
    .where(
      and(
        eq(evidence.collectionRunId, runId),
        eq(evidence.evidenceType, "html_snapshot")
      )
    );
  return rows.map((r) => ({
    evidence: r.evidence,
    site: {
      brand: r.brand,
      name: r.name,
      state: r.state,
      otherStates: r.otherStates,
    },
  }));
}

interface CapturedDisclaimer {
  siteId: string;
  text: string;
}

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

/** Disclaimer screenshot rows that have captured modal text — used as a
 *  secondary offer source for platforms (e.g. DDC/Dealer.com) where the
 *  HTML snapshot contains image-only offer cards with no DOM price text. */
async function loadDisclaimerEvidence(
  runId: string
): Promise<EvidenceWithSite[]> {
  const rows = await getDb()
    .select({
      evidence,
      brand: sites.brand,
      name: sites.name,
      state: sites.state,
      otherStates: sites.otherStates,
    })
    .from(evidence)
    .innerJoin(sites, eq(sites.id, evidence.siteId))
    .where(
      and(
        eq(evidence.collectionRunId, runId),
        eq(evidence.evidenceType, "disclaimer_screenshot")
      )
    );
  return rows
    .filter((r) => Boolean(r.evidence.textContent))
    .map((r) => ({
      evidence: r.evidence,
      site: {
        brand: r.brand,
        name: r.name,
        state: r.state,
        otherStates: r.otherStates,
      },
    }));
}

/** Screenshot evidence rows for the run, keyed by "siteId:missionType:label"
 *  so each HTML snapshot can find its paired page screenshot. */
async function loadScreenshotIndex(
  runId: string
): Promise<Map<string, Evidence>> {
  const rows = await getDb()
    .select({ evidence })
    .from(evidence)
    .where(
      and(
        eq(evidence.collectionRunId, runId),
        eq(evidence.evidenceType, "screenshot")
      )
    );
  const index = new Map<string, Evidence>();
  for (const { evidence: row } of rows) {
    const key = `${row.siteId}:${row.missionType}:${row.label ?? ""}`;
    // First row wins — consistent with how capture pairs are uploaded.
    if (!index.has(key)) index.set(key, row);
  }
  return index;
}

/** Disclaimer-modal text captured during collection. */
function disclaimerPortion(modalText: string): string {
  const colon = modalText.search(/disclaimer\s*:/i);
  if (colon >= 0) {
    const after = modalText.indexOf(":", colon);
    if (after >= 0) return modalText.slice(after + 1).trim();
  }
  const any = modalText.search(/disclaimer/i);
  return (any >= 0 ? modalText.slice(any) : modalText).trim();
}

function matchCapturedDisclaimer(
  offer: { monthlyPayment: number | null },
  siteId: string,
  disclaimers: CapturedDisclaimer[]
): { text: string; model: string | null } | null {
  if (offer.monthlyPayment == null) return null;
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
  rows: EvidenceWithSite[]
): Promise<void> {
  const db = getDb();
  try {
    await db.delete(offers).where(eq(offers.collectionRunId, runId));
    await db
      .delete(complianceGrades)
      .where(eq(complianceGrades.collectionRunId, runId));

    const grader = getComplianceGrader(runId);
    const enricher = getOfferEnricher();
    const aiThreshold = aiConfidenceThreshold();
    const capturedDisclaimers = await loadCapturedDisclaimers(runId);
    const screenshotIndex = await loadScreenshotIndex(runId);
    // Cache R2 fetches: screenshot bytes keyed by evidence row ID.
    const screenshotCache = new Map<string, Buffer | null>();

    const seen = new Set<string>();

    for (const { evidence: row, site } of rows) {
      const html = await getEvidenceText(row);
      if (!html) continue;

      const extracted = extractOffers(html, {
        missionType: row.missionType,
        brand: site.brand,
      });
      const pageText = htmlToText(html);

      // Market states for this site: primary state + any additional ones.
      const marketStates = [
        site.state,
        ...(site.otherStates ?? []),
      ].filter((s): s is string => Boolean(s));

      // Find the screenshot evidence row that was captured alongside this HTML.
      const screenshotKey = `${row.siteId}:${row.missionType}:${row.label ?? ""}`;
      const screenshotRow = screenshotIndex.get(screenshotKey) ?? null;

      // Fetch screenshot bytes once per evidence row (many offers can come from
      // the same page; avoid redundant R2 reads via the cache).
      let screenshotBuffer: Buffer | null = null;
      if (screenshotRow) {
        if (!screenshotCache.has(screenshotRow.id)) {
          screenshotCache.set(
            screenshotRow.id,
            await getEvidenceBody(screenshotRow)
          );
        }
        screenshotBuffer = screenshotCache.get(screenshotRow.id) ?? null;
      }

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

        let effective = offer;
        let aiAssisted = false;
        if (offer.confidence < aiThreshold || effective.vehicleModel === null) {
          const enrichment = await enricher.enrich({
            pageText,
            brand: site.brand,
            current: effective,
            screenshotBuffer,
          });
          if (enrichment) {
            effective = { ...effective, ...enrichment };
            aiAssisted = true;
          }
        }

        const matched = matchCapturedDisclaimer(
          effective,
          row.siteId,
          capturedDisclaimers
        );
        const disclaimerText = effective.disclaimerText ?? matched?.text ?? null;
        const vehicleModel = matched?.model ?? effective.vehicleModel;

        await db.insert(offers).values({
          collectionRunId: runId,
          siteId: row.siteId,
          sourceEvidenceId: row.id,
          offerType: effective.offerType,
          vehicleMake: effective.vehicleMake,
          vehicleModel,
          vehicleTrim: effective.vehicleTrim,
          monthlyPayment: effective.monthlyPayment,
          apr: effective.apr,
          cashIncentive: effective.cashIncentive,
          termMonths: effective.termMonths,
          dueAtSigning: effective.dueAtSigning,
          rawText: effective.rawText,
          normalizedJson: { matches: offer.matches, aiAssisted },
          disclaimerText,
          confidence: effective.confidence,
        });

        // Compliance only applies to priced offers (lease / finance / cash).
        // Service and promotional offers are skipped — no API call, grade = n/a.
        const COMPLIANCE_TYPES: typeof effective.offerType[] = ["lease", "finance", "cash"];
        const result = COMPLIANCE_TYPES.includes(effective.offerType)
          ? await grader.grade({
              evidenceId: row.id,
              offerType: effective.offerType,
              disclaimerText,
              adText: effective.rawText,
              dealerName: site.name,
              marketStates,
              screenshotBuffer,
            })
          : { grade: "n/a", details: { notApplicable: true, offerType: effective.offerType } };
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

    // Secondary pass: extract offers from disclaimer modal text captured during
    // collection. Platforms like DDC/Dealer.com render offer prices as images, so
    // the HTML snapshot contains no price text — but the modal text_content has
    // the full offer details. We run the same extraction + dedup pipeline here;
    // the shared `seen` Set prevents duplicates with HTML-extracted offers.
    const disclaimerEvidence = await loadDisclaimerEvidence(runId);
    for (const { evidence: row, site } of disclaimerEvidence) {
      const text = row.textContent!;
      const extracted = extractOffers(text, {
        missionType: row.missionType,
        brand: site.brand,
      });

      const marketStates = [
        site.state,
        ...(site.otherStates ?? []),
      ].filter((s): s is string => Boolean(s));

      // The disclaimer screenshot IS the ad image — use it for compliance.
      if (!screenshotCache.has(row.id)) {
        screenshotCache.set(row.id, await getEvidenceBody(row));
      }
      const screenshotBuffer = screenshotCache.get(row.id) ?? null;

      const pageText = text;

      for (const offer of extracted) {
        // The evidence label stores the ad-anchor text that launched this modal
        // (e.g. "2025 Nissan Rogue · $379/mo"). When the disclaimer body text
        // has no model name, pull it from the label before computing the dedup
        // signature — so a label-recovered "Rogue" matches an HTML-extracted
        // "Rogue" and we don't insert the same offer twice for non-DDC sites.
        let effective = offer;
        if (!effective.vehicleModel && row.label) {
          const labelModel = findKnownModel(row.label);
          if (labelModel) effective = { ...effective, vehicleModel: labelModel };
        }

        const signature = [
          row.siteId,
          effective.offerType,
          effective.vehicleModel ?? "",
          effective.monthlyPayment ?? "",
          effective.apr ?? "",
          effective.termMonths ?? "",
          effective.cashIncentive ?? "",
          effective.dueAtSigning ?? "",
        ].join("|");
        if (seen.has(signature)) continue;
        seen.add(signature);

        let aiAssisted = false;
        if (effective.confidence < aiThreshold || effective.vehicleModel === null) {
          const enrichment = await enricher.enrich({
            pageText,
            brand: site.brand,
            current: effective,
            screenshotBuffer,
          });
          if (enrichment) {
            effective = { ...effective, ...enrichment };
            aiAssisted = true;
          }
        }

        const disclaimerText = disclaimerPortion(text).slice(0, 1000);

        await db.insert(offers).values({
          collectionRunId: runId,
          siteId: row.siteId,
          sourceEvidenceId: row.id,
          offerType: effective.offerType,
          vehicleMake: effective.vehicleMake,
          vehicleModel: effective.vehicleModel,
          vehicleTrim: effective.vehicleTrim,
          monthlyPayment: effective.monthlyPayment,
          apr: effective.apr,
          cashIncentive: effective.cashIncentive,
          termMonths: effective.termMonths,
          dueAtSigning: effective.dueAtSigning,
          rawText: effective.rawText,
          normalizedJson: { matches: offer.matches, aiAssisted },
          disclaimerText,
          confidence: effective.confidence,
        });

        const COMPLIANCE_TYPES: typeof effective.offerType[] = ["lease", "finance", "cash"];
        const result = COMPLIANCE_TYPES.includes(effective.offerType)
          ? await grader.grade({
              evidenceId: row.id,
              offerType: effective.offerType,
              disclaimerText,
              adText: effective.rawText,
              dealerName: site.name,
              marketStates,
              screenshotBuffer,
            })
          : { grade: "n/a", details: { notApplicable: true, offerType: effective.offerType } };
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

    await db
      .update(collectionRuns)
      .set({ analysisCompletedAt: new Date() })
      .where(eq(collectionRuns.id, runId));
  } finally {
    activeAnalyses.delete(runId);
  }
}

export async function startAnalysis(runId: string): Promise<number | null> {
  if (activeAnalyses.has(runId)) return null;
  try {
    const rows = await loadAnalyzableEvidence(runId);
    if (rows.length === 0) return 0;
    activeAnalyses.add(runId);
    await getDb()
      .update(collectionRuns)
      .set({ analysisStartedAt: new Date() })
      .where(eq(collectionRuns.id, runId));
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
