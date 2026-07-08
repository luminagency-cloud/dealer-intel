import { and, eq, inArray, ne } from "drizzle-orm";
import {
  getDb,
  collectionRuns,
  complianceGrades,
  evidence,
  ocrArtifacts,
  offers,
  sites,
  type Db,
  type Evidence,
  type MissionType,
} from "@/lib/db";
import { isMistralConfigured } from "@/lib/env";
import { getEvidenceBody, getEvidenceText } from "@/lib/evidence";
import { extractOffers, findKnownModel, htmlToText } from "./extract";
import { getComplianceGrader } from "./compliance";
import { runMistralOcr, type OcrArtifact } from "./ocr-mistral";
import { parseMileage } from "@/lib/report";
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

/** Parses the page URL from an evidence label ("Page Title — https://...").
 *  Labels produced by the collector end with " — <url>". */
function pageUrlFromLabel(label: string | null | undefined): string | undefined {
  if (!label) return undefined;
  const sep = label.lastIndexOf(" — ");
  if (sep < 0) return undefined;
  const raw = label.slice(sep + 3).trim();
  if (!raw) return undefined;
  const url = raw.startsWith("http") ? raw : `https://${raw}`;
  try { new URL(url); return url; } catch { return undefined; }
}

/** Strips structural chrome (header/footer/nav) from HTML, then extracts
 *  candidate offer-card image URLs. Checks src and common lazy-load attributes
 *  (data-src, data-lazy-src, data-original). Skips data URIs, SVGs, and
 *  obvious icon/logo URLs. Returns absolute URLs only. */
function extractAdImageUrls(html: string, pageUrl?: string): string[] {
  const stripped = html
    .replace(/<header\b[\s\S]*?<\/header>/gi, "")
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, "")
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, "");

  const imgRe = /<img\b[^>]*>/gi;
  // src first, then common lazy-load attributes in priority order
  const srcPatterns = [
    /\bsrc=["']([^"']+)["']/i,
    /\bdata-src=["']([^"']+)["']/i,
    /\bdata-lazy-src=["']([^"']+)["']/i,
    /\bdata-original=["']([^"']+)["']/i,
    /\bdata-lazy=["']([^"']+)["']/i,
  ];
  const seen = new Set<string>();
  const urls: string[] = [];
  let m: RegExpExecArray | null;

  while ((m = imgRe.exec(stripped)) !== null) {
    const tag = m[0];
    let src: string | undefined;
    for (const re of srcPatterns) {
      const match = re.exec(tag);
      if (match) { src = match[1].trim(); break; }
    }
    if (!src || src.startsWith("data:")) continue;
    if (/\.(svg|ico|gif)(\?|#|$)/i.test(src)) continue;
    if (/\/(icon|logo|sprite|badge|arrow|btn|button|nav|menu|header|footer|social|share|fb|twitter|instagram|linkedin|youtube|track|pixel|beacon)\b/i.test(src)) continue;

    let resolved = src;
    if (!src.startsWith("http")) {
      if (!pageUrl) continue;
      try { resolved = new URL(src, pageUrl).toString(); } catch { continue; }
    }
    if (!seen.has(resolved)) { seen.add(resolved); urls.push(resolved); }
  }
  return urls;
}

const globalState = globalThis as unknown as {
  __activeAnalysisRuns?: Set<string>;
  __analysisProgress?: Map<string, { processed: number; total: number }>;
};
const activeAnalyses = (globalState.__activeAnalysisRuns ??= new Set<string>());
const analysisProgress = (globalState.__analysisProgress ??= new Map<
  string,
  { processed: number; total: number }
>());

export function isAnalysisRunning(runId: string): boolean {
  return activeAnalyses.has(runId);
}

/** Returns the set of "siteId:missionType" pairs currently being partially
 *  re-analyzed within this run. Empty set = no partial analyses in flight. */
export function getPartialAnalysisKeys(runId: string): Set<string> {
  const prefix = `${runId}:`;
  const keys = new Set<string>();
  for (const key of activeAnalyses) {
    if (key.startsWith(prefix)) {
      keys.add(key.slice(prefix.length));
    }
  }
  return keys;
}

export function getAnalysisProgress(
  runId: string
): { processed: number; total: number } | null {
  return analysisProgress.get(runId) ?? null;
}

/** Summed live progress across several concurrently-analyzing runs (e.g. one
 *  per group), for a single "N of M pages" figure across a week's groups. */
export function getAnalysisProgressForRuns(runIds: string[]): { processed: number; total: number } {
  let processed = 0, total = 0;
  for (const runId of runIds) {
    const p = analysisProgress.get(runId);
    if (p) {
      processed += p.processed;
      total += p.total;
    }
  }
  return { processed, total };
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

/** OCRs a screenshot with Mistral, caching per evidence id within a single
 *  analysis pass (a screenshot referenced by several low-confidence offers on
 *  the same page is only OCR'd once), and upserting the artifact into
 *  ocr_artifacts for audit. Returns null when Mistral isn't configured, the
 *  screenshot bytes aren't available, or the OCR call fails — callers proceed
 *  without it, same graceful degradation as the rest of this pipeline. */
async function getOcrArtifact(
  db: Db,
  runId: string,
  screenshotRow: Evidence,
  cache: Map<string, Promise<OcrArtifact | null>>,
  bufferHint?: Buffer | null
): Promise<OcrArtifact | null> {
  if (!isMistralConfigured()) return null;
  let pending = cache.get(screenshotRow.id);
  if (!pending) {
    pending = (async () => {
      const buf = bufferHint ?? (await getEvidenceBody(screenshotRow));
      if (!buf) return null;
      const artifact = await runMistralOcr(buf);
      if (artifact) {
        await db
          .insert(ocrArtifacts)
          .values({
            evidenceId: screenshotRow.id,
            collectionRunId: runId,
            provider: artifact.provider,
            model: artifact.model,
            imageText: artifact.imageText,
            pagesJson: artifact.pages,
          })
          .onConflictDoUpdate({
            target: ocrArtifacts.evidenceId,
            set: {
              provider: artifact.provider,
              model: artifact.model,
              imageText: artifact.imageText,
              pagesJson: artifact.pages,
            },
          });
      }
      return artifact;
    })();
    cache.set(screenshotRow.id, pending);
  }
  return pending;
}

async function processAnalysis(
  runId: string,
  rows: EvidenceWithSite[],
  resume = false
): Promise<void> {
  console.log(`[analysis] run=${runId} html_snapshot rows=${rows.length} resume=${resume}`);
  const db = getDb();
  try {
    if (resume) {
      // Find sites that already have offers — skip them.
      const doneRows = await db
        .select({ siteId: offers.siteId })
        .from(offers)
        .where(eq(offers.collectionRunId, runId))
        .groupBy(offers.siteId);
      const doneSiteIds = new Set(doneRows.map((r) => r.siteId));
      if (doneSiteIds.size > 0) {
        console.log(`[analysis] resume: skipping ${doneSiteIds.size} already-analyzed sites`);
        rows = rows.filter((r) => !doneSiteIds.has(r.evidence.siteId));
      }
      // Delete offers/grades only for the sites we're about to (re)process.
      const siteIdsToProcess = [...new Set(rows.map((r) => r.evidence.siteId))];
      if (siteIdsToProcess.length > 0) {
        await db.delete(offers).where(
          and(eq(offers.collectionRunId, runId), inArray(offers.siteId, siteIdsToProcess))
        );
        // complianceGrades has no siteId — delete via evidenceId subquery.
        const evidenceIds = await db
          .select({ id: evidence.id })
          .from(evidence)
          .where(
            and(
              eq(evidence.collectionRunId, runId),
              inArray(evidence.siteId, siteIdsToProcess)
            )
          );
        if (evidenceIds.length > 0) {
          await db.delete(complianceGrades).where(
            inArray(complianceGrades.evidenceId, evidenceIds.map((r) => r.id))
          );
        }
      }
    } else {
      await db.delete(offers).where(eq(offers.collectionRunId, runId));
      await db
        .delete(complianceGrades)
        .where(eq(complianceGrades.collectionRunId, runId));
    }

    // Void prior-run offers for every site this run covers. Scoped by siteId
    // so runs covering different dealer sets don't step on each other.
    const siteIdsInRun = [...new Set(rows.map((r) => r.evidence.siteId))];
    if (siteIdsInRun.length > 0) {
      await db
        .delete(offers)
        .where(and(inArray(offers.siteId, siteIdsInRun), ne(offers.collectionRunId, runId)));
    }

    const grader = getComplianceGrader(runId);
    const enricher = getOfferEnricher();
    const aiThreshold = aiConfidenceThreshold();
    const capturedDisclaimers = await loadCapturedDisclaimers(runId);
    const screenshotIndex = await loadScreenshotIndex(runId);
    const disclaimerEvidence = await loadDisclaimerEvidence(runId);
    analysisProgress.set(runId, { processed: 0, total: rows.length + disclaimerEvidence.length });
    // Cache R2 fetches: screenshot bytes keyed by evidence row ID.
    const screenshotCache = new Map<string, Buffer | null>();
    // Cache Mistral OCR reads per screenshot evidence id (see getOcrArtifact).
    const ocrCache = new Map<string, Promise<OcrArtifact | null>>();

    const seen = new Set<string>();
    // Track which sites produced at least one offer (text or disclaimer passes).
    // Sites with zero offers after both passes are candidates for the image pass.
    const siteOfferInserted = new Set<string>();

    for (const { evidence: row, site } of rows) {
      console.log(`[analysis] processing evidence id=${row.id} site="${site.name}" missionType=${row.missionType} htmlUrl=${row.htmlUrl}`);
      let html: string | null;
      try {
        html = await getEvidenceText(row);
      } catch (err) {
        console.error(`[analysis] R2 fetch FAILED for evidence id=${row.id} site="${site.name}":`, err);
        continue;
      }
      if (!html) {
        console.warn(`[analysis] html is null/empty for evidence id=${row.id} site="${site.name}" — skipping`);
        continue;
      }
      console.log(`[analysis] html fetched ok for site="${site.name}", length=${html.length}`);

      const extracted = extractOffers(html, {
        missionType: row.missionType,
        brand: site.brand,
      });
      console.log(`[analysis] extracted ${extracted.length} offers for site="${site.name}"`);
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

      const prog = analysisProgress.get(runId);
      if (prog) prog.processed += 1;

      for (const offer of extracted) {
        const signature = [
          row.siteId,
          offer.offerType,
          offer.vehicleModel ?? "",
          offer.monthlyPayment ?? "",
          offer.apr ?? "",
          offer.termMonths ?? "",
          offer.cashIncentive ?? "",
          offer.salePrice ?? "",
          offer.dueAtSigning ?? "",
          offer.mileageAllowance ?? "",
          offer.matches?.serviceOffer ?? "",
          offer.offerType === "service" ? (offer.rawText ?? "") : "",
        ].join("|");
        if (seen.has(signature)) continue;
        seen.add(signature);

        let effective = offer;
        let aiAssisted = false;
        if (offer.confidence < aiThreshold || (effective.vehicleModel === null && effective.offerType !== "service")) {
          let ocrModelHint: string | null = null;
          if (effective.vehicleModel === null && screenshotRow) {
            const artifact = await getOcrArtifact(db, runId, screenshotRow, ocrCache, screenshotBuffer);
            if (artifact) ocrModelHint = findKnownModel(artifact.imageText);
          }
          const enrichment = await enricher.enrich({
            pageText,
            brand: site.brand,
            current: effective,
            ocrModelHint,
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
        // The rule-based pass only scans the price-anchor window for mileage;
        // the fully-resolved disclaimer (which can pull in a captured
        // disclaimer screenshot beyond that window) often states it even when
        // the window missed it — same fallback the report breakdown uses.
        // Meaningful only on leases — a shared multi-offer disclaimer can
        // mention lease mileage even for the finance/cash offer on the same page.
        const mileageAllowance =
          effective.offerType === "lease"
            ? effective.mileageAllowance ??
              parseMileage(disclaimerText) ??
              parseMileage(effective.rawText)
            : null;

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
          salePrice: effective.salePrice,
          termMonths: effective.termMonths,
          dueAtSigning: effective.dueAtSigning,
          mileageAllowance,
          rawText: effective.rawText,
          normalizedJson: { matches: offer.matches, aiAssisted },
          disclaimerText,
          confidence: effective.confidence,
        });
        siteOfferInserted.add(row.siteId);

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
    for (const { evidence: row, site } of disclaimerEvidence) {
      if (row.missionType === "service_specials") continue;
      const text = row.textContent!;
      const extracted = extractOffers(text, {
        missionType: row.missionType,
        brand: site.brand,
      });

      const prog = analysisProgress.get(runId);
      if (prog) prog.processed += 1;

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
          effective.salePrice ?? "",
          effective.dueAtSigning ?? "",
          effective.mileageAllowance ?? "",
          offer.matches?.serviceOffer ?? "",
          effective.offerType === "service" ? (effective.rawText ?? "") : "",
        ].join("|");
        if (seen.has(signature)) continue;
        seen.add(signature);

        let aiAssisted = false;
        if (effective.confidence < aiThreshold || effective.vehicleModel === null) {
          let ocrModelHint: string | null = null;
          if (effective.vehicleModel === null) {
            const artifact = await getOcrArtifact(db, runId, row, ocrCache, screenshotBuffer);
            if (artifact) ocrModelHint = findKnownModel(artifact.imageText);
          }
          const enrichment = await enricher.enrich({
            pageText,
            brand: site.brand,
            current: effective,
            ocrModelHint,
          });
          if (enrichment) {
            effective = { ...effective, ...enrichment };
            aiAssisted = true;
          }
        }

        const disclaimerText = disclaimerPortion(text).slice(0, 1000);
        // The disclaimer-modal pass extracts offers from a price-anchor window
        // within the modal text, but disclaimerText above is the FULL modal's
        // disclaimer portion (unwindowed) — mileage often sits past the
        // window even though the disclaimer clearly states it. Meaningful only
        // on leases — a shared disclaimer can mention lease mileage even for
        // the finance/cash offer on the same page.
        const mileageAllowance =
          effective.offerType === "lease"
            ? effective.mileageAllowance ??
              parseMileage(disclaimerText) ??
              parseMileage(text)
            : null;

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
          salePrice: effective.salePrice,
          termMonths: effective.termMonths,
          dueAtSigning: effective.dueAtSigning,
          mileageAllowance,
          rawText: effective.rawText,
          normalizedJson: { matches: offer.matches, aiAssisted },
          disclaimerText,
          confidence: effective.confidence,
        });
        siteOfferInserted.add(row.siteId);

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

    // Image pass: sites that produced zero text-extractable offers may have
    // image-only content (e.g. carousel slides on platforms that render offers
    // as graphics). OCR each screenshot evidence row with Mistral, then run
    // the same deterministic extractor used for DOM text over the OCR'd text.
    // No-op when Mistral is not configured.
    const imagePassSiteIds = siteIdsInRun.filter((id) => !siteOfferInserted.has(id));
    if (imagePassSiteIds.length > 0) {
      const ocrActive = isMistralConfigured();
      const zeroSiteNames = imagePassSiteIds.map((id) => {
        const r = rows.find((r) => r.evidence.siteId === id);
        return r?.site.name ?? id;
      });
      if (!ocrActive) {
        console.warn(
          `[analysis] WARNING: ${imagePassSiteIds.length} site(s) produced zero text offers and appear image-only, ` +
          `but MISTRAL_API_KEY is not set so the image pass is disabled. ` +
          `These sites will have no offers: ${zeroSiteNames.join(", ")}. ` +
          `Set MISTRAL_API_KEY in .env to enable OCR extraction for image-only platforms.`
        );
      } else {
        console.log(`[analysis] image pass: ${imagePassSiteIds.length} sites with zero text offers: ${zeroSiteNames.join(", ")}`);
      }
      const imageSiteSet = new Set(imagePassSiteIds);
      // Group screenshot evidence by siteId from the already-loaded index.
      const screenshotsBySite = new Map<string, Evidence[]>();
      for (const screenshotRow of screenshotIndex.values()) {
        if (!imageSiteSet.has(screenshotRow.siteId)) continue;
        const arr = screenshotsBySite.get(screenshotRow.siteId) ?? [];
        arr.push(screenshotRow);
        screenshotsBySite.set(screenshotRow.siteId, arr);
      }
      // Update progress total to include these images.
      const imageTotal = [...screenshotsBySite.values()].reduce((s, a) => s + a.length, 0);
      const iprog = analysisProgress.get(runId);
      if (iprog) iprog.total += imageTotal;

      const siteInfoMap = new Map(rows.map((r) => [r.evidence.siteId, r.site]));

      for (const siteId of imagePassSiteIds) {
        const shots = screenshotsBySite.get(siteId) ?? [];
        const site = siteInfoMap.get(siteId);
        if (!site) continue;
        const marketStates = [site.state, ...(site.otherStates ?? [])].filter((s): s is string => Boolean(s));

        let siteFoundOffer = false;

        // Sub-pass B: individual ad-card images fetched from HTML snapshot img
        // src URLs. Primary path for image-only platforms (e.g. Dealer.com) —
        // each CDN image is OCR'd in isolation so disclaimers can't bleed
        // between ads. header/footer/nav are stripped before URL parsing.
        if (isMistralConfigured()) {
          const htmlRowsForSite = rows.filter((r) => r.evidence.siteId === siteId);
          for (const { evidence: htmlRow } of htmlRowsForSite) {
            if (siteFoundOffer) break;
            if (htmlRow.missionType === "service_specials") continue;
            const html = await getEvidenceText(htmlRow);
            if (!html) continue;
            const pageUrl = pageUrlFromLabel(htmlRow.label);
            const adImageUrls = extractAdImageUrls(html, pageUrl);
            console.log(`[analysis] img-src pass site=${site.name} mission=${htmlRow.missionType} found ${adImageUrls.length} candidate image URL(s)`);
            const MAX_AD_IMAGES = 15;
            let tried = 0;
            for (const url of adImageUrls) {
              if (tried >= MAX_AD_IMAGES) break;
              tried++;
              let imageBuf: Buffer | null = null;
              try {
                const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
                if (!resp.ok) continue;
                imageBuf = Buffer.from(await resp.arrayBuffer());
              } catch { continue; }
              const artifact = await runMistralOcr(imageBuf);
              if (!artifact || !artifact.imageText.trim()) continue;
              const extracted = extractOffers(artifact.imageText, { missionType: htmlRow.missionType, brand: site.brand });
              console.log(`[analysis] img-src OCR site=${site.name} url=...${url.slice(-60)} extracted ${extracted.length} offer(s)`);
              for (const offer of extracted) {
                if (offer.confidence < 0.3) continue;
                const sig = [siteId, offer.offerType, offer.vehicleModel ?? "", offer.monthlyPayment ?? "", offer.apr ?? "", offer.termMonths ?? "", offer.cashIncentive ?? "", offer.salePrice ?? "", offer.dueAtSigning ?? "", offer.mileageAllowance ?? ""].join("|");
                if (seen.has(sig)) continue;
                seen.add(sig);
                siteFoundOffer = true;
                await db.insert(offers).values({
                  collectionRunId: runId,
                  siteId,
                  sourceEvidenceId: htmlRow.id,
                  offerType: offer.offerType,
                  vehicleMake: offer.vehicleMake,
                  vehicleModel: offer.vehicleModel,
                  vehicleTrim: offer.vehicleTrim,
                  monthlyPayment: offer.monthlyPayment,
                  apr: offer.apr,
                  cashIncentive: offer.cashIncentive,
                  salePrice: offer.salePrice,
                  termMonths: offer.termMonths,
                  dueAtSigning: offer.dueAtSigning,
                  mileageAllowance: offer.offerType === "lease" ? offer.mileageAllowance ?? parseMileage(offer.disclaimerText) : null,
                  rawText: offer.rawText,
                  normalizedJson: { matches: offer.matches, aiAssisted: true, source: "image_extraction" },
                  disclaimerText: offer.disclaimerText,
                  confidence: offer.confidence,
                });
                const COMPLIANCE_TYPES: typeof offer.offerType[] = ["lease", "finance", "cash"];
                const result = COMPLIANCE_TYPES.includes(offer.offerType)
                  ? await grader.grade({
                      evidenceId: htmlRow.id,
                      offerType: offer.offerType,
                      disclaimerText: offer.disclaimerText,
                      adText: offer.rawText,
                      dealerName: site.name,
                      marketStates,
                      screenshotBuffer: imageBuf,
                    })
                  : { grade: "n/a", details: { notApplicable: true, offerType: offer.offerType } };
                await db.insert(complianceGrades)
                  .values({ evidenceId: htmlRow.id, collectionRunId: runId, grade: result.grade, detailsJson: result.details })
                  .onConflictDoUpdate({ target: complianceGrades.evidenceId, set: { grade: result.grade, detailsJson: result.details, gradedAt: new Date() } });
              }
            }
          }
        }

        // Sub-pass A: full-page screenshot OCR — fallback when per-image CDN
        // extraction found nothing (e.g. JS-loaded images absent from the HTML
        // snapshot). On typical image-only platforms Mistral treats embedded ad
        // images as placeholders and finds no offer text, so this rarely fires
        // for those sites; it exists as a safety net for pages where the full
        // screenshot IS text-readable by Mistral.
        if (!siteFoundOffer) {
          for (const screenshotRow of shots) {
            const buf = await getEvidenceBody(screenshotRow);
            if (buf) {
              const artifact = await getOcrArtifact(db, runId, screenshotRow, ocrCache, buf);
              const extracted = artifact && artifact.imageText.trim()
                ? extractOffers(artifact.imageText, { missionType: screenshotRow.missionType, brand: site.brand })
                : [];
              console.log(`[analysis] screenshot OCR fallback site=${site.name} screenshot=${screenshotRow.id} extracted ${extracted.length} offer(s)`);
              for (const offer of extracted) {
                if (offer.confidence < 0.3) continue;
                const sig = [
                  siteId,
                  offer.offerType,
                  offer.vehicleModel ?? "",
                  offer.monthlyPayment ?? "",
                  offer.apr ?? "",
                  offer.termMonths ?? "",
                  offer.cashIncentive ?? "",
                  offer.salePrice ?? "",
                  offer.dueAtSigning ?? "",
                  offer.mileageAllowance ?? "",
                ].join("|");
                if (!seen.has(sig)) {
                  seen.add(sig);
                  siteFoundOffer = true;
                  await db.insert(offers).values({
                    collectionRunId: runId,
                    siteId,
                    sourceEvidenceId: screenshotRow.id,
                    offerType: offer.offerType,
                    vehicleMake: offer.vehicleMake,
                    vehicleModel: offer.vehicleModel,
                    vehicleTrim: offer.vehicleTrim,
                    monthlyPayment: offer.monthlyPayment,
                    apr: offer.apr,
                    cashIncentive: offer.cashIncentive,
                    salePrice: offer.salePrice,
                    termMonths: offer.termMonths,
                    dueAtSigning: offer.dueAtSigning,
                    mileageAllowance:
                      offer.offerType === "lease"
                        ? offer.mileageAllowance ?? parseMileage(offer.disclaimerText)
                        : null,
                    rawText: offer.rawText,
                    normalizedJson: { matches: offer.matches, aiAssisted: true, source: "image_extraction" },
                    disclaimerText: offer.disclaimerText,
                    confidence: offer.confidence,
                  });
                  const COMPLIANCE_TYPES: typeof offer.offerType[] = ["lease", "finance", "cash"];
                  const result = COMPLIANCE_TYPES.includes(offer.offerType)
                    ? await grader.grade({
                        evidenceId: screenshotRow.id,
                        offerType: offer.offerType,
                        disclaimerText: offer.disclaimerText,
                        adText: offer.rawText,
                        dealerName: site.name,
                        marketStates,
                        screenshotBuffer: buf,
                      })
                    : { grade: "n/a", details: { notApplicable: true, offerType: offer.offerType } };
                  await db
                    .insert(complianceGrades)
                    .values({ evidenceId: screenshotRow.id, collectionRunId: runId, grade: result.grade, detailsJson: result.details })
                    .onConflictDoUpdate({
                      target: complianceGrades.evidenceId,
                      set: { grade: result.grade, detailsJson: result.details, gradedAt: new Date() },
                    });
                }
              }
            }
            const iprog2 = analysisProgress.get(runId);
            if (iprog2) iprog2.processed += 1;
          }
        }
      }
    }

    await db
      .update(collectionRuns)
      .set({ analysisCompletedAt: new Date() })
      .where(eq(collectionRuns.id, runId));
  } finally {
    activeAnalyses.delete(runId);
    analysisProgress.delete(runId);
  }
}

/** For scripts/CLI: runs the full analysis pipeline and waits for completion. */
export async function runAnalysisDirect(runId: string): Promise<void> {
  const rows = await loadAnalyzableEvidence(runId);
  await getDb()
    .update(collectionRuns)
    .set({ analysisStartedAt: new Date() })
    .where(eq(collectionRuns.id, runId));
  await processAnalysis(runId, rows);
}

async function loadAnalyzableEvidenceForSiteMission(
  runId: string,
  siteId: string,
  missionType: MissionType
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
        eq(evidence.siteId, siteId),
        eq(evidence.missionType, missionType),
        eq(evidence.evidenceType, "html_snapshot")
      )
    );
  return rows.map((r) => ({
    evidence: r.evidence,
    site: { brand: r.brand, name: r.name, state: r.state, otherStates: r.otherStates },
  }));
}

async function loadDisclaimerEvidenceForSiteMission(
  runId: string,
  siteId: string,
  missionType: MissionType
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
        eq(evidence.siteId, siteId),
        eq(evidence.missionType, missionType),
        eq(evidence.evidenceType, "disclaimer_screenshot")
      )
    );
  return rows
    .filter((r) => Boolean(r.evidence.textContent))
    .map((r) => ({
      evidence: r.evidence,
      site: { brand: r.brand, name: r.name, state: r.state, otherStates: r.otherStates },
    }));
}

export async function startAnalysis(runId: string, { resume = false }: { resume?: boolean } = {}): Promise<number | null> {
  if (activeAnalyses.has(runId)) return null;
  try {
    const rows = await loadAnalyzableEvidence(runId);
    console.log(`[analysis] startAnalysis run=${runId} found ${rows.length} html_snapshot rows resume=${resume}`);
    if (rows.length === 0) {
      console.warn(`[analysis] no html_snapshot evidence for run=${runId} — returning 0`);
      return 0;
    }
    activeAnalyses.add(runId);
    await getDb()
      .update(collectionRuns)
      .set({ analysisStartedAt: new Date() })
      .where(eq(collectionRuns.id, runId));
    void processAnalysis(runId, rows, resume).catch((err) => {
      console.error(`analysis for run ${runId} crashed:`, err);
      activeAnalyses.delete(runId);
    });
    return rows.length;
  } catch (err) {
    activeAnalyses.delete(runId);
    throw err;
  }
}

/** Re-run extraction for a single site+mission within a run.
 *
 *  Deletes only the offers and compliance grades sourced from this site+mission's
 *  evidence, then re-inserts fresh results. Safe to call while the rest of the
 *  run's offers are intact. Blocked if a full-run analysis is in flight. */
export async function startAnalysisForSiteMission(
  runId: string,
  siteId: string,
  missionType: MissionType
): Promise<"started" | "busy" | "no_evidence"> {
  // Block if a full-run analysis is already running.
  if (activeAnalyses.has(runId)) return "busy";
  const key = `${runId}:${siteId}:${missionType}`;
  if (activeAnalyses.has(key)) return "busy";

  const htmlRows = await loadAnalyzableEvidenceForSiteMission(runId, siteId, missionType);
  const disclaimerRows = await loadDisclaimerEvidenceForSiteMission(runId, siteId, missionType);
if (htmlRows.length === 0 && disclaimerRows.length === 0) return "no_evidence";

  activeAnalyses.add(key);

  void (async () => {
    try {
      const db = getDb();
      const allEvidenceIds = [
        ...htmlRows.map((r) => r.evidence.id),
        ...disclaimerRows.map((r) => r.evidence.id),
      ];

      // Delete existing offers sourced from this site+mission's evidence only,
      // leaving offers from other missions for this site intact.
      if (allEvidenceIds.length > 0) {
        await db
          .delete(offers)
          .where(inArray(offers.sourceEvidenceId, allEvidenceIds));
      }
      await db
        .delete(complianceGrades)
        .where(
          and(
            eq(complianceGrades.collectionRunId, runId),
            inArray(complianceGrades.evidenceId, allEvidenceIds)
          )
        );

      const grader = getComplianceGrader(runId);
      const enricher = getOfferEnricher();
      const aiThreshold = aiConfidenceThreshold();
      const capturedDisclaimers = await loadCapturedDisclaimers(runId);
      const screenshotIndex = await loadScreenshotIndex(runId);
      const screenshotCache = new Map<string, Buffer | null>();
      const ocrCache = new Map<string, Promise<OcrArtifact | null>>();
      const seen = new Set<string>();
      let offersInserted = 0;

      for (const { evidence: row, site } of htmlRows) {
        const html = await getEvidenceText(row);
        if (!html) continue;
        const extracted = extractOffers(html, { missionType: row.missionType, brand: site.brand });
        const pageText = htmlToText(html);
        const marketStates = [site.state, ...(site.otherStates ?? [])].filter((s): s is string => Boolean(s));
        const screenshotKey = `${row.siteId}:${row.missionType}:${row.label ?? ""}`;
        const screenshotRow = screenshotIndex.get(screenshotKey) ?? null;
        let screenshotBuffer: Buffer | null = null;
        if (screenshotRow) {
          if (!screenshotCache.has(screenshotRow.id)) {
            screenshotCache.set(screenshotRow.id, await getEvidenceBody(screenshotRow));
          }
          screenshotBuffer = screenshotCache.get(screenshotRow.id) ?? null;
        }
        for (const offer of extracted) {
          const sig = [row.siteId, offer.offerType, offer.vehicleModel ?? "", offer.monthlyPayment ?? "", offer.apr ?? "", offer.termMonths ?? "", offer.cashIncentive ?? "", offer.salePrice ?? "", offer.dueAtSigning ?? "", offer.mileageAllowance ?? "", offer.matches?.serviceOffer ?? "", offer.offerType === "service" ? (offer.rawText ?? "") : ""].join("|");
          if (seen.has(sig)) continue;
          seen.add(sig);
          let effective = offer;
          let aiAssisted = false;
          if (offer.confidence < aiThreshold || (effective.vehicleModel === null && effective.offerType !== "service")) {
            let ocrModelHint: string | null = null;
            if (effective.vehicleModel === null && screenshotRow) {
              const artifact = await getOcrArtifact(db, runId, screenshotRow, ocrCache, screenshotBuffer);
              if (artifact) ocrModelHint = findKnownModel(artifact.imageText);
            }
            const enrichment = await enricher.enrich({ pageText, brand: site.brand, current: effective, ocrModelHint });
            if (enrichment) { effective = { ...effective, ...enrichment }; aiAssisted = true; }
          }
          const matched = matchCapturedDisclaimer(effective, row.siteId, capturedDisclaimers);
          const disclaimerText = effective.disclaimerText ?? matched?.text ?? null;
          const vehicleModel = matched?.model ?? effective.vehicleModel;
          const mileageAllowance = effective.offerType === "lease" ? effective.mileageAllowance ?? parseMileage(disclaimerText) ?? parseMileage(effective.rawText) : null;
          await db.insert(offers).values({ collectionRunId: runId, siteId: row.siteId, sourceEvidenceId: row.id, offerType: effective.offerType, vehicleMake: effective.vehicleMake, vehicleModel, vehicleTrim: effective.vehicleTrim, monthlyPayment: effective.monthlyPayment, apr: effective.apr, cashIncentive: effective.cashIncentive, salePrice: effective.salePrice, termMonths: effective.termMonths, dueAtSigning: effective.dueAtSigning, mileageAllowance, rawText: effective.rawText, normalizedJson: { matches: offer.matches, aiAssisted }, disclaimerText, confidence: effective.confidence });
          offersInserted++;
          const COMPLIANCE_TYPES: typeof effective.offerType[] = ["lease", "finance", "cash"];
          const result = COMPLIANCE_TYPES.includes(effective.offerType)
            ? await grader.grade({ evidenceId: row.id, offerType: effective.offerType, disclaimerText, adText: effective.rawText, dealerName: site.name, marketStates, screenshotBuffer })
            : { grade: "n/a", details: { notApplicable: true, offerType: effective.offerType } };
          await db.insert(complianceGrades).values({ evidenceId: row.id, collectionRunId: runId, grade: result.grade, detailsJson: result.details }).onConflictDoUpdate({ target: complianceGrades.evidenceId, set: { grade: result.grade, detailsJson: result.details, gradedAt: new Date() } });
        }
      }

      for (const { evidence: row, site } of disclaimerRows) {
        if (row.missionType === "service_specials") continue;
        const text = row.textContent!;
        const extracted = extractOffers(text, { missionType: row.missionType, brand: site.brand });
        const marketStates = [site.state, ...(site.otherStates ?? [])].filter((s): s is string => Boolean(s));
        if (!screenshotCache.has(row.id)) screenshotCache.set(row.id, await getEvidenceBody(row));
        const screenshotBuffer = screenshotCache.get(row.id) ?? null;
        for (const offer of extracted) {
          let effective = offer;
          if (!effective.vehicleModel && row.label) {
            const labelModel = findKnownModel(row.label);
            if (labelModel) effective = { ...effective, vehicleModel: labelModel };
          }
          const sig = [row.siteId, effective.offerType, effective.vehicleModel ?? "", effective.monthlyPayment ?? "", effective.apr ?? "", effective.termMonths ?? "", effective.cashIncentive ?? "", effective.salePrice ?? "", effective.dueAtSigning ?? "", effective.mileageAllowance ?? "", offer.matches?.serviceOffer ?? "", effective.offerType === "service" ? (effective.rawText ?? "") : ""].join("|");
          if (seen.has(sig)) continue;
          seen.add(sig);
          let aiAssisted = false;
          if (effective.confidence < aiThreshold || effective.vehicleModel === null) {
            let ocrModelHint: string | null = null;
            if (effective.vehicleModel === null) {
              const artifact = await getOcrArtifact(db, runId, row, ocrCache, screenshotBuffer);
              if (artifact) ocrModelHint = findKnownModel(artifact.imageText);
            }
            const enrichment = await enricher.enrich({ pageText: text, brand: site.brand, current: effective, ocrModelHint });
            if (enrichment) { effective = { ...effective, ...enrichment }; aiAssisted = true; }
          }
          const disclaimerText = disclaimerPortion(text).slice(0, 1000);
          const mileageAllowance = effective.offerType === "lease" ? effective.mileageAllowance ?? parseMileage(disclaimerText) ?? parseMileage(text) : null;
          await db.insert(offers).values({ collectionRunId: runId, siteId: row.siteId, sourceEvidenceId: row.id, offerType: effective.offerType, vehicleMake: effective.vehicleMake, vehicleModel: effective.vehicleModel, vehicleTrim: effective.vehicleTrim, monthlyPayment: effective.monthlyPayment, apr: effective.apr, cashIncentive: effective.cashIncentive, salePrice: effective.salePrice, termMonths: effective.termMonths, dueAtSigning: effective.dueAtSigning, mileageAllowance, rawText: effective.rawText, normalizedJson: { matches: offer.matches, aiAssisted }, disclaimerText, confidence: effective.confidence });
          offersInserted++;
          const COMPLIANCE_TYPES: typeof effective.offerType[] = ["lease", "finance", "cash"];
          const result = COMPLIANCE_TYPES.includes(effective.offerType)
            ? await grader.grade({ evidenceId: row.id, offerType: effective.offerType, disclaimerText, adText: effective.rawText, dealerName: site.name, marketStates, screenshotBuffer })
            : { grade: "n/a", details: { notApplicable: true, offerType: effective.offerType } };
          await db.insert(complianceGrades).values({ evidenceId: row.id, collectionRunId: runId, grade: result.grade, detailsJson: result.details }).onConflictDoUpdate({ target: complianceGrades.evidenceId, set: { grade: result.grade, detailsJson: result.details, gradedAt: new Date() } });
        }
      }

      // Image pass: if HTML and disclaimer extraction found nothing, this site is
      // likely image-only (e.g. DDC/Dealer.com). Try two sub-passes:
      // A) full-page screenshot OCR; B) individual ad-card images from HTML img srcs.
      if (offersInserted === 0 && isMistralConfigured()) {
        const siteInfo = htmlRows[0]?.site ?? disclaimerRows[0]?.site;
        if (siteInfo) {
          const marketStates = [siteInfo.state, ...(siteInfo.otherStates ?? [])].filter((s): s is string => Boolean(s));
          const screenshotKey = `${siteId}:${missionType}:`;
          const shots = [...screenshotIndex.entries()]
            .filter(([k]) => k.startsWith(screenshotKey))
            .map(([, v]) => v);

          // Sub-pass B: individual ad-card images from HTML snapshot img srcs.
          // Primary path — each CDN image is isolated, no cross-ad bleed.
          // header/footer/nav stripped before parsing.
          let foundOfferInPass = false;
          if (missionType !== "service_specials") {
            for (const { evidence: htmlRow } of htmlRows) {
              if (foundOfferInPass) break;
              const html = await getEvidenceText(htmlRow);
              if (!html) continue;
              const pageUrl = pageUrlFromLabel(htmlRow.label);
              const adImageUrls = extractAdImageUrls(html, pageUrl);
              console.log(`[partial-analysis] img-src pass site=${siteInfo.name} mission=${missionType} found ${adImageUrls.length} candidate image URL(s)`);
              const MAX_AD_IMAGES = 15;
              let tried = 0;
              for (const url of adImageUrls) {
                if (tried >= MAX_AD_IMAGES) break;
                tried++;
                let imageBuf: Buffer | null = null;
                try {
                  const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
                  if (!resp.ok) continue;
                  imageBuf = Buffer.from(await resp.arrayBuffer());
                } catch { continue; }
                const artifact = await runMistralOcr(imageBuf);
                if (!artifact || !artifact.imageText.trim()) continue;
                const extracted = extractOffers(artifact.imageText, { missionType, brand: siteInfo.brand });
                console.log(`[partial-analysis] img-src OCR site=${siteInfo.name} url=...${url.slice(-60)} extracted ${extracted.length} offer(s)`);
                for (const offer of extracted) {
                  if (offer.confidence < 0.3) continue;
                  const sig = [siteId, offer.offerType, offer.vehicleModel ?? "", offer.monthlyPayment ?? "", offer.apr ?? "", offer.termMonths ?? "", offer.cashIncentive ?? "", offer.salePrice ?? "", offer.dueAtSigning ?? "", offer.mileageAllowance ?? ""].join("|");
                  if (seen.has(sig)) continue;
                  seen.add(sig);
                  foundOfferInPass = true;
                  await db.insert(offers).values({ collectionRunId: runId, siteId, sourceEvidenceId: htmlRow.id, offerType: offer.offerType, vehicleMake: offer.vehicleMake, vehicleModel: offer.vehicleModel, vehicleTrim: offer.vehicleTrim, monthlyPayment: offer.monthlyPayment, apr: offer.apr, cashIncentive: offer.cashIncentive, salePrice: offer.salePrice, termMonths: offer.termMonths, dueAtSigning: offer.dueAtSigning, mileageAllowance: offer.offerType === "lease" ? offer.mileageAllowance ?? parseMileage(offer.disclaimerText) : null, rawText: offer.rawText, normalizedJson: { matches: offer.matches, aiAssisted: true, source: "image_extraction" }, disclaimerText: offer.disclaimerText, confidence: offer.confidence });
                  const COMPLIANCE_TYPES: typeof offer.offerType[] = ["lease", "finance", "cash"];
                  const result = COMPLIANCE_TYPES.includes(offer.offerType)
                    ? await grader.grade({ evidenceId: htmlRow.id, offerType: offer.offerType, disclaimerText: offer.disclaimerText, adText: offer.rawText, dealerName: siteInfo.name, marketStates, screenshotBuffer: imageBuf })
                    : { grade: "n/a", details: { notApplicable: true, offerType: offer.offerType } };
                  await db.insert(complianceGrades).values({ evidenceId: htmlRow.id, collectionRunId: runId, grade: result.grade, detailsJson: result.details }).onConflictDoUpdate({ target: complianceGrades.evidenceId, set: { grade: result.grade, detailsJson: result.details, gradedAt: new Date() } });
                }
              }
            }
          }

          // Sub-pass A: full-page screenshot OCR — fallback when per-image CDN
          // extraction found nothing (e.g. JS-loaded images absent from the HTML
          // snapshot). Rarely succeeds on typical image-only platforms since
          // Mistral treats nested ad images as placeholders, but kept as a
          // safety net for pages where the screenshot IS text-readable.
          if (!foundOfferInPass) {
            for (const screenshotRow of shots) {
              if (!screenshotCache.has(screenshotRow.id)) {
                screenshotCache.set(screenshotRow.id, await getEvidenceBody(screenshotRow));
              }
              const buf = screenshotCache.get(screenshotRow.id) ?? null;
              if (!buf) continue;
              const artifact = await getOcrArtifact(db, runId, screenshotRow, ocrCache, buf);
              const extracted = artifact && artifact.imageText.trim()
                ? extractOffers(artifact.imageText, { missionType: screenshotRow.missionType, brand: siteInfo.brand })
                : [];
              console.log(`[partial-analysis] screenshot OCR fallback site=${siteInfo.name} mission=${missionType} screenshot=${screenshotRow.id} extracted ${extracted.length} offer(s)`);
              for (const offer of extracted) {
                if (offer.confidence < 0.3) continue;
                const sig = [siteId, offer.offerType, offer.vehicleModel ?? "", offer.monthlyPayment ?? "", offer.apr ?? "", offer.termMonths ?? "", offer.cashIncentive ?? "", offer.salePrice ?? "", offer.dueAtSigning ?? "", offer.mileageAllowance ?? ""].join("|");
                if (seen.has(sig)) continue;
                seen.add(sig);
                foundOfferInPass = true;
                await db.insert(offers).values({ collectionRunId: runId, siteId, sourceEvidenceId: screenshotRow.id, offerType: offer.offerType, vehicleMake: offer.vehicleMake, vehicleModel: offer.vehicleModel, vehicleTrim: offer.vehicleTrim, monthlyPayment: offer.monthlyPayment, apr: offer.apr, cashIncentive: offer.cashIncentive, salePrice: offer.salePrice, termMonths: offer.termMonths, dueAtSigning: offer.dueAtSigning, mileageAllowance: offer.offerType === "lease" ? offer.mileageAllowance ?? parseMileage(offer.disclaimerText) : null, rawText: offer.rawText, normalizedJson: { matches: offer.matches, aiAssisted: true, source: "image_extraction" }, disclaimerText: offer.disclaimerText, confidence: offer.confidence });
                const COMPLIANCE_TYPES: typeof offer.offerType[] = ["lease", "finance", "cash"];
                const result = COMPLIANCE_TYPES.includes(offer.offerType)
                  ? await grader.grade({ evidenceId: screenshotRow.id, offerType: offer.offerType, disclaimerText: offer.disclaimerText, adText: offer.rawText, dealerName: siteInfo.name, marketStates, screenshotBuffer: buf })
                  : { grade: "n/a", details: { notApplicable: true, offerType: offer.offerType } };
                await db.insert(complianceGrades).values({ evidenceId: screenshotRow.id, collectionRunId: runId, grade: result.grade, detailsJson: result.details }).onConflictDoUpdate({ target: complianceGrades.evidenceId, set: { grade: result.grade, detailsJson: result.details, gradedAt: new Date() } });
              }
            }
          }
        }
      }
    } finally {
      activeAnalyses.delete(key);
    }
  })().catch((err) => {
    console.error(`partial analysis for ${runId} ${siteId} ${missionType} crashed:`, err);
    activeAnalyses.delete(key);
  });

  return "started";
}
