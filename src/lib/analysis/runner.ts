import { and, eq, inArray } from "drizzle-orm";
import sharp from "sharp";
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
import {
  extractOffers,
  extractOffersFromDisclosure,
  extractOffersFromOcrImage,
  findKnownModel,
  htmlToText,
  findServiceCouponImages,
  reconcileServiceCoupon,
  type ExtractedOffer,
} from "./extract";
import { getComplianceGrader, type ComplianceGrader } from "./compliance";
import { runMistralOcr, type OcrArtifact } from "./ocr-mistral";
import { parseMileage, deriveAnnualMileage } from "@/lib/report";
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

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#36;|&dollar;/gi, "$")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/** New product rule (July 2026): a priced vehicle offer (finance, lease, OR cash)
 *  we couldn't tie to a specific vehicle model is not a real, reportable offer. A
 *  make-only "Kia finance" row is noise — the model is what makes the offer
 *  actionable — so we drop it rather than persist it, no matter how many other
 *  fields parsed (a full-field but model-less offer must never read as a
 *  confident offer). Every model-recovery path (AI enrichment, OCR model hint,
 *  captured-disclaimer / label match) runs BEFORE this check, so only offers
 *  whose model could not be resolved by any means are discarded. Service and
 *  promotional offers are intentionally exempt — service is model-less by design
 *  (shop work, not vehicle-specific), and promotional is a bare price teaser. */
const MODEL_REQUIRED_TYPES = ["finance", "lease", "cash"];
function isUnmodeledPricedOffer(
  offerType: string,
  vehicleModel: string | null | undefined
): boolean {
  return MODEL_REQUIRED_TYPES.includes(offerType) && !vehicleModel;
}

/** Below this, an image can't plausibly hold legible offer text — franchise
 *  badges (e.g. "franchise-logos/.../117x80.png") and nav/UI icons are well
 *  under this, real ad cards and coupon graphics are well over it. Shared by
 *  the URL-hint fast path (extractAdImageUrls) and the post-fetch real-pixel
 *  check (isAdSizedImage) so both agree on what counts as "too small". */
const MIN_AD_IMAGE_WIDTH = 150;
const MIN_AD_IMAGE_HEIGHT = 100;
/** Below this many bytes an image is a tracking pixel, spacer, or trivial
 *  icon — not worth decoding just to measure it. */
const MIN_AD_IMAGE_BYTES = 1024;

/** True if the URL itself (filename dimensions like "117x80.png", or a
 *  resize query param like "w=100"/"h=64") tells us the image is too small
 *  to be an ad, without having to fetch it. */
function isTooSmallByUrlHints(url: string): boolean {
  const dims = /(\d{2,4})x(\d{2,4})(?=\.\w+(?:\?|#|$))/i.exec(url);
  if (dims) {
    const w = Number(dims[1]);
    const h = Number(dims[2]);
    if (w < MIN_AD_IMAGE_WIDTH || h < MIN_AD_IMAGE_HEIGHT) return true;
  }
  try {
    const params = new URL(url).searchParams;
    const w = Number(params.get("w") ?? params.get("width") ?? "");
    const h = Number(params.get("h") ?? params.get("height") ?? "");
    if (Number.isFinite(w) && w > 0 && w < MIN_AD_IMAGE_WIDTH) return true;
    if (Number.isFinite(h) && h > 0 && h < MIN_AD_IMAGE_HEIGHT) return true;
  } catch {
    // not a resolvable absolute URL — nothing to check here
  }
  return false;
}

/** Strips structural chrome (header/footer/nav) from HTML, then extracts
 *  candidate offer-card image URLs. Checks src and common lazy-load attributes
 *  (data-src, data-lazy-src, data-original). Skips data URIs, SVGs, obvious
 *  icon/logo/badge URLs, and images too small (by filename or query-param
 *  dimensions) to hold legible offer text. Returns absolute URLs only. */
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
    // Matches a keyword as a whole path/filename segment (delimited by /, _,
    // -, or .) rather than requiring it to start right after a "/" — the old
    // pattern missed "franchise-logos/.../117x80.png" because "logos" isn't
    // preceded by a slash.
    if (/(?:^|[/_-])(icons?|logos?|sprites?|badges?|avatars?|favicons?|placeholders?|spacers?|swatch(?:es)?|arrow|btn|button|nav|menu|header|footer|social|share|fb|twitter|instagram|linkedin|youtube|track|pixel|beacon)(?:[/_.-]|$)/i.test(src)) continue;

    src = decodeHtmlAttribute(src);

    let resolved = src;
    if (!src.startsWith("http")) {
      if (!pageUrl) continue;
      try { resolved = new URL(src, pageUrl).toString(); } catch { continue; }
    }
    if (isTooSmallByUrlHints(resolved)) continue;
    if (!seen.has(resolved)) { seen.add(resolved); urls.push(resolved); }
  }
  return urls;
}

function cleanParam(value: string | null): string | null {
  const cleaned = value?.replace(/\s+/g, " ").trim() ?? "";
  return cleaned || null;
}

function scene7Param(params: URLSearchParams, name: string): string | null {
  return cleanParam(params.get(`$${name}`) ?? params.get(name));
}

function parseMoneyParam(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value.replace(/[^\d.]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function parsePercentParam(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value.replace(/[^\d.]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseIntegerParam(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value.replace(/[^\d]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function vehicleModelFromScene7(params: URLSearchParams): string | null {
  const model = scene7Param(params, "model");
  if (model) return model;
  const vehicle = scene7Param(params, "VEHICLE")?.replace(/_/g, " ");
  return vehicle ? findKnownModel(vehicle) : null;
}

function vehicleMakeFromScene7(params: URLSearchParams, brand: string | null): string | null {
  return scene7Param(params, "make") ?? brand?.split(/[,/]/)[0].trim() ?? null;
}

function vehicleLabelFromScene7(params: URLSearchParams, brand: string | null): string {
  return [
    scene7Param(params, "year"),
    vehicleMakeFromScene7(params, brand),
    vehicleModelFromScene7(params),
    scene7Param(params, "trim"),
  ].filter(Boolean).join(" ");
}

function extractDealerInspireScene7Offers(
  imageUrl: string,
  hints: { missionType: MissionType; brand: string | null }
): ExtractedOffer[] {
  if (!/scene7\.com\/is\/image\/streamcompanies\//i.test(imageUrl)) return [];

  let url: URL;
  try {
    url = new URL(imageUrl);
  } catch {
    return [];
  }

  const params = url.searchParams;
  const model = vehicleModelFromScene7(params);
  const make = vehicleMakeFromScene7(params, hints.brand);
  const trim = scene7Param(params, "trim");
  const label = vehicleLabelFromScene7(params, hints.brand);
  const disclaimer = scene7Param(params, "DISCLAIMER")?.slice(0, 1000) ?? null;
  const mileage = parseMileage(disclaimer);

  const leasePayment =
    parseMoneyParam(scene7Param(params, "payment_per_month_leaseinfo")) ??
    parseMoneyParam(scene7Param(params, "payment_per_month"));
  const leaseTerm =
    parseIntegerParam(scene7Param(params, "monthly_terms_leaseinfo")) ??
    parseIntegerParam(scene7Param(params, "monthly_terms"));
  const dueAtSigning =
    parseMoneyParam(scene7Param(params, "down_payment")) ??
    parseMoneyParam(disclaimer?.match(/\$\s?[\d,]+(?:\.\d{2})?\s+due at signing/i)?.[0] ?? null);

  const apr = parsePercentParam(scene7Param(params, "apr_aproffer"));
  const financeTerm = parseIntegerParam(scene7Param(params, "monthly_terms_aproffer"));

  const common = {
    vehicleMake: make,
    vehicleModel: model,
    vehicleTrim: trim,
    cashIncentive: null,
    salePrice: null,
    disclaimerText: disclaimer,
  };

  const out: ExtractedOffer[] = [];
  if (leasePayment !== null) {
    out.push({
      ...common,
      offerType: "lease",
      monthlyPayment: leasePayment,
      apr: null,
      termMonths: leaseTerm,
      dueAtSigning,
      mileageAllowance: mileage,
      rawText: `${label || "Vehicle"} lease: $${leasePayment}/mo${leaseTerm ? ` for ${leaseTerm} months` : ""}${dueAtSigning ? ` with $${dueAtSigning} due at signing` : ""}.`,
      confidence: 0.95,
      matches: {
        monthlyPayment: `$${leasePayment}/mo`,
        ...(leaseTerm ? { termMonths: `${leaseTerm} months` } : {}),
        ...(dueAtSigning ? { dueAtSigning: `$${dueAtSigning} due at signing` } : {}),
        ...(mileage ? { mileageAllowance: `${mileage} miles/year` } : {}),
        source: "dealer_inspire_scene7",
      },
    });
  }

  if (apr !== null) {
    out.push({
      ...common,
      offerType: "finance",
      monthlyPayment: null,
      apr,
      termMonths: financeTerm,
      dueAtSigning: null,
      mileageAllowance: null,
      rawText: `${label || "Vehicle"} finance: ${apr}% APR${financeTerm ? ` for ${financeTerm} months` : ""}.`,
      confidence: 0.95,
      matches: {
        apr: `${apr}% APR`,
        ...(financeTerm ? { termMonths: `${financeTerm} months` } : {}),
        source: "dealer_inspire_scene7",
      },
    });
  }

  return out;
}

const globalState = globalThis as unknown as {
  __activeAnalysisRuns?: Set<string>;
  __analysisProgress?: Map<string, { processed: number; total: number }>;
  __analysisQueueState?: {
    queue: AnalysisQueueTask[];
    running: number;
  };
};
const activeAnalyses = (globalState.__activeAnalysisRuns ??= new Set<string>());
const analysisProgress = (globalState.__analysisProgress ??= new Map<
  string,
  { processed: number; total: number }
>());
const ANALYSIS_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.ANALYSIS_CONCURRENCY ?? "1", 10)
);

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

interface AnalysisQueueTask {
  runId: string;
  rows: EvidenceWithSite[];
  resume: boolean;
}

const analysisQueueState = (globalState.__analysisQueueState ??= {
  queue: [],
  running: 0,
});

function enqueueAnalysis(task: AnalysisQueueTask): void {
  analysisQueueState.queue.push(task);
  drainAnalysisQueue();
}

function drainAnalysisQueue(): void {
  while (
    analysisQueueState.running < ANALYSIS_CONCURRENCY &&
    analysisQueueState.queue.length > 0
  ) {
    const task = analysisQueueState.queue.shift()!;
    analysisQueueState.running++;
    void processAnalysis(task.runId, task.rows, task.resume)
      .catch((err) => {
        console.error(`analysis for run ${task.runId} crashed:`, err);
      })
      .finally(() => {
        analysisQueueState.running--;
        drainAnalysisQueue();
      });
  }
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
  offer: { monthlyPayment: number | null; vehicleModel: string | null },
  siteId: string,
  disclaimers: CapturedDisclaimer[]
): { text: string; model: string | null } | null {
  if (offer.monthlyPayment == null) return null;
  const amountRe = new RegExp(`\\$\\s?${offer.monthlyPayment}(?![\\d,])`);
  const candidates = disclaimers.filter(
    (d) => d.siteId === siteId && amountRe.test(d.text)
  );
  if (candidates.length === 0) return null;
  // Two different vehicles can share the same monthly payment (e.g. two
  // $399/mo leases on the same site), so a bare payment match is ambiguous
  // when there's more than one candidate. Prefer the one whose own text names
  // the vehicle model the rule-based/AI pass already settled on — that beats
  // an arbitrary "first in DB order" pick, which would silently attach the
  // wrong disclaimer (and overwrite a correct model with a wrong one).
  const corroborated = offer.vehicleModel
    ? candidates.find((d) => findKnownModel(d.text) === offer.vehicleModel)
    : null;
  const chosen = corroborated ?? candidates[0];
  return {
    text: disclaimerPortion(chosen.text).slice(0, 1000),
    model: findKnownModel(chosen.text),
  };
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

async function fetchImageBuffer(url: string): Promise<Buffer | null> {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) return null;
    return Buffer.from(await resp.arrayBuffer());
  } catch {
    return null;
  }
}

/** Real-pixel-dimension gate applied to a fetched image buffer, right before
 *  it would be sent to Mistral OCR. Catches everything the URL-hint fast path
 *  (isTooSmallByUrlHints) can't see — icons with no size in the URL, tracking
 *  pixels, and (as a side effect) empty/corrupt fetch bodies, which otherwise
 *  reach sharp's resize inside runMistralOcr and throw "Input Buffer is
 *  empty". */
async function isAdSizedImage(buf: Buffer | null): Promise<boolean> {
  if (!buf || buf.length < MIN_AD_IMAGE_BYTES) return false;
  try {
    const { width, height } = await sharp(buf).metadata();
    return Boolean(width && height && width >= MIN_AD_IMAGE_WIDTH && height >= MIN_AD_IMAGE_HEIGHT);
  } catch {
    return false;
  }
}

function offerSignature(siteId: string, offer: ExtractedOffer): string {
  return [
    siteId,
    offer.offerType,
    offer.vehicleModel ?? "",
    offer.vehicleTrim ?? "",
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
}

async function insertImageExtractedOffer(input: {
  db: Db;
  runId: string;
  siteId: string;
  sourceEvidenceId: string;
  offer: ExtractedOffer;
  seen: Set<string>;
  grader: ComplianceGrader;
  dealerName: string;
  marketStates: string[];
  screenshotBuffer: Buffer | null;
  source: string;
  aiAssisted?: boolean;
}): Promise<boolean> {
  const {
    db,
    runId,
    siteId,
    sourceEvidenceId,
    offer,
    seen,
    grader,
    dealerName,
    marketStates,
    screenshotBuffer,
    source,
    aiAssisted = false,
  } = input;

  if (offer.confidence < 0.3) return false;
  const sig = offerSignature(siteId, offer);
  if (seen.has(sig)) return false;
  seen.add(sig);
  if (isUnmodeledPricedOffer(offer.offerType, offer.vehicleModel)) return false;

  const mileageAllowance =
    offer.offerType === "lease"
      ? offer.mileageAllowance ?? parseMileage(offer.disclaimerText)
      : null;

  await db.insert(offers).values({
    collectionRunId: runId,
    siteId,
    sourceEvidenceId,
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
    mileageAllowance,
    rawText: offer.rawText,
    normalizedJson: { matches: offer.matches, aiAssisted, source },
    disclaimerText: offer.disclaimerText,
    confidence: offer.confidence,
  });

  const COMPLIANCE_TYPES: typeof offer.offerType[] = ["lease", "finance", "cash"];
  const result = COMPLIANCE_TYPES.includes(offer.offerType)
    ? await grader.grade({
        evidenceId: sourceEvidenceId,
        offerType: offer.offerType,
        disclaimerText: offer.disclaimerText,
        adText: offer.rawText,
        dealerName,
        marketStates,
        screenshotBuffer,
      })
    : { grade: "n/a", details: { notApplicable: true, offerType: offer.offerType } };

  await db.insert(complianceGrades)
    .values({ evidenceId: sourceEvidenceId, collectionRunId: runId, grade: result.grade, detailsJson: result.details })
    .onConflictDoUpdate({ target: complianceGrades.evidenceId, set: { grade: result.grade, detailsJson: result.details, gradedAt: new Date() } });

  return true;
}

const MAX_COUPON_IMAGES = 12;

/** Cap on ad-card images OCR'd per page in the image pass. */
const MAX_AD_IMAGES = 15;

/** A page whose DOM + disclaimer text yielded more offers than this is treated
 *  as adequately covered by text and skips the (expensive) per-image OCR pass.
 *  Keeps the pass targeted at image-rendered platforms (DDC/Dealer.com) rather
 *  than OCR-storming text-rendered pages across a full run. Two is enough to
 *  catch the failure mode where one stray DOM offer (e.g. a finance banner)
 *  masks several image-rendered offer cards on the same page. */
const MAX_DOM_OFFERS_FOR_IMAGE_PASS = 2;

/** Image-coupon service pass: for pages whose coupons are graphics (DDC/
 *  Dealer.com), OCR each coupon image (primary — it's what customers see) and
 *  reconcile it against the image's alt text (cross-check). Returns reconciled
 *  offers, each carrying a `verify` marker (corroborated / mismatch / ocr_only /
 *  alt_only) and a confidence set by that agreement. Called only when the DOM
 *  pass found nothing, so DOM-text coupons keep their trusted extraction and
 *  never pay for OCR. Degrades gracefully: if Mistral is off or an image fails,
 *  the alt cross-check alone still yields an (alt_only) offer. */
async function serviceCouponOffers(
  html: string,
  brand: string | null
): Promise<ExtractedOffer[]> {
  const coupons = findServiceCouponImages(html);
  if (coupons.length === 0) return [];
  const hints = { missionType: "service_specials" as const, brand };
  const mistralOn = isMistralConfigured();
  const out: ExtractedOffer[] = [];
  let tried = 0;
  for (const coupon of coupons) {
    if (tried >= MAX_COUPON_IMAGES) break;
    tried++;
    let ocrText: string | null = null;
    if (mistralOn) {
      try {
        const resp = await fetch(coupon.imageUrl, { signal: AbortSignal.timeout(10_000) });
        if (resp.ok) {
          const buf = Buffer.from(await resp.arrayBuffer());
          if (await isAdSizedImage(buf)) {
            const artifact = await runMistralOcr(buf);
            ocrText = artifact?.imageText ?? null;
          }
        }
      } catch {
        // Image fetch/OCR failed — fall back to the alt cross-check alone.
      }
    }
    const offer = reconcileServiceCoupon(ocrText, coupon.alt, hints);
    if (offer) out.push(offer);
  }
  return out;
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

    const grader = getComplianceGrader(runId);
    const enricher = getOfferEnricher();
    const aiThreshold = aiConfidenceThreshold();
    const capturedDisclaimers = await loadCapturedDisclaimers(runId);
    const screenshotIndex = await loadScreenshotIndex(runId);
    const disclaimerEvidence = await loadDisclaimerEvidence(runId);
    analysisProgress.set(runId, { processed: 0, total: rows.length + disclaimerEvidence.length });
    // Cache Mistral OCR reads per screenshot evidence id (see getOcrArtifact).
    const ocrCache = new Map<string, Promise<OcrArtifact | null>>();

    const seen = new Set<string>();
    // Per-page text yield, used to gate the image pass PER PAGE (not per site).
    // DOM offers are keyed by the html evidence row id; disclaimer-modal offers
    // attach to a page's mission, so they're keyed by "siteId:missionType". A
    // page whose own yield is smaller than its ad-card image count still gets the
    // OCR pass even if OTHER pages on the same site produced offers — the old
    // all-or-nothing site gate suppressed exactly that (a lone finance banner on
    // one page hid the image-rendered offer cards on the specials page).
    const domOffersByEvidence = new Map<string, number>();
    const disclaimerOffersByMission = new Map<string, number>();

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

      let extracted = extractOffers(html, {
        missionType: row.missionType,
        brand: site.brand,
      });
      // Image-coupon service pages have no DOM text — OCR each coupon graphic
      // and reconcile against its alt (see serviceCouponOffers).
      if (row.missionType === "service_specials" && extracted.length === 0) {
        extracted = await serviceCouponOffers(html, site.brand);
        console.log(`[analysis] service coupon OCR pass for site="${site.name}" -> ${extracted.length} offer(s)`);
      }
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
        screenshotBuffer = await getEvidenceBody(screenshotRow);
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
          // Only take the AI's correction when it's at least as confident as
          // the rule-based guess it's replacing — a low-confidence AI answer
          // ("I don't know either") shouldn't silently overwrite offer fields
          // just because it was asked to look.
          if (enrichment && enrichment.confidence >= effective.confidence) {
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
              parseMileage(effective.rawText) ??
              deriveAnnualMileage(disclaimerText, effective.termMonths) ??
              deriveAnnualMileage(effective.rawText, effective.termMonths)
            : null;

        if (isUnmodeledPricedOffer(effective.offerType, vehicleModel)) continue;
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
        domOffersByEvidence.set(row.id, (domOffersByEvidence.get(row.id) ?? 0) + 1);

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
      const extracted = extractOffersFromDisclosure(text, {
        missionType: row.missionType,
        brand: site.brand,
      });
      const disclaimerMissionKey = `${row.siteId}:${row.missionType}`;
      const pricedDisclosureCount = extracted.filter((offer) =>
        ["lease", "finance", "cash"].includes(offer.offerType)
      ).length;
      if (pricedDisclosureCount > 0) {
        // Coverage describes what the evidence supplied, not how many new rows
        // survived run-wide dedup. The same ad can be captured by homepage and
        // finance missions; a duplicate still means OCR is unnecessary here.
        disclaimerOffersByMission.set(
          disclaimerMissionKey,
          (disclaimerOffersByMission.get(disclaimerMissionKey) ?? 0) + pricedDisclosureCount
        );
      }

      const prog = analysisProgress.get(runId);
      if (prog) prog.processed += 1;

      const marketStates = [
        site.state,
        ...(site.otherStates ?? []),
      ].filter((s): s is string => Boolean(s));

      // The disclaimer screenshot IS the ad image — use it for compliance.
      const screenshotBuffer = await getEvidenceBody(row);

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
          if (enrichment && enrichment.confidence >= effective.confidence) {
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
              parseMileage(text) ??
              deriveAnnualMileage(disclaimerText, effective.termMonths) ??
              deriveAnnualMileage(text, effective.termMonths)
            : null;

        if (isUnmodeledPricedOffer(effective.offerType, effective.vehicleModel)) continue;
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

    // Image pass (per page): a page whose DOM + disclaimer text yielded very few
    // offers relative to its ad-card images likely renders offers as graphics
    // (DDC/Dealer.com). OCR that page's ad images and, as a fallback, its full
    // screenshot. The gate is PER html evidence row, not per site — a single
    // weak text offer on one page no longer suppresses OCR recovery for the rest
    // of the site (the old all-or-nothing site gate did exactly that).
    const mistralOn = isMistralConfigured();
    const imageOnlyBlocked: string[] = [];

    for (const { evidence: htmlRow, site } of rows) {
      // Service specials have their own OCR-coupon pass (serviceCouponOffers).
      if (htmlRow.missionType === "service_specials") continue;

      const coveredCount =
        (domOffersByEvidence.get(htmlRow.id) ?? 0) +
        (disclaimerOffersByMission.get(`${htmlRow.siteId}:${htmlRow.missionType}`) ?? 0);
      // Already well-covered by text — skip before any R2 fetch or OCR.
      if (coveredCount > MAX_DOM_OFFERS_FOR_IMAGE_PASS) continue;

      const html = await getEvidenceText(htmlRow);
      if (!html) continue;
      const pageUrl = pageUrlFromLabel(htmlRow.label);
      const adImageUrls = extractAdImageUrls(html, pageUrl);

      // Run the pass when the page has more ad-card images than offers we found
      // (image-rendered offers we missed), or produced nothing at all.
      const wantImagePass = coveredCount === 0 || adImageUrls.length > coveredCount;
      if (!wantImagePass) continue;

      const marketStates = [site.state, ...(site.otherStates ?? [])].filter(
        (s): s is string => Boolean(s)
      );
      console.log(
        `[analysis] image pass site="${site.name}" mission=${htmlRow.missionType}: text offers=${coveredCount}, ad images=${adImageUrls.length}`
      );

      let pageFoundOffer = false;

      let directTried = 0;
      for (const url of adImageUrls) {
        if (directTried >= MAX_AD_IMAGES) break;
        directTried++;
        const directOffers = extractDealerInspireScene7Offers(url, {
          missionType: htmlRow.missionType,
          brand: site.brand,
        });
        if (directOffers.length === 0) continue;
        const imageBuf = await fetchImageBuffer(url);
        for (const offer of directOffers) {
          pageFoundOffer = (await insertImageExtractedOffer({
            db,
            runId,
            siteId: htmlRow.siteId,
            sourceEvidenceId: htmlRow.id,
            offer,
            seen,
            grader,
            dealerName: site.name,
            marketStates,
            screenshotBuffer: imageBuf,
            source: "dealer_inspire_scene7",
          })) || pageFoundOffer;
        }
      }

      if (pageFoundOffer) {
        console.log(`[analysis] Dealer Inspire Scene7 parser site=${site.name} extracted direct offer(s)`);
        continue;
      }

      if (!mistralOn) {
        if (!pageFoundOffer) imageOnlyBlocked.push(`${site.name} [${htmlRow.missionType}]`);
        continue;
      }

      // Sub-pass B: OCR each ad-card image in isolation (no cross-ad disclaimer
      // bleed). Collect ALL distinct offers on the page — never stop at the
      // first, or a 5-card page would yield a single offer.
      let tried = 0;
      for (const url of adImageUrls) {
        if (tried >= MAX_AD_IMAGES) break;
        tried++;
        if (extractDealerInspireScene7Offers(url, {
          missionType: htmlRow.missionType,
          brand: site.brand,
        }).length > 0) {
          continue;
        }
        let imageBuf: Buffer | null = null;
        try {
          const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
          if (!resp.ok) continue;
          imageBuf = Buffer.from(await resp.arrayBuffer());
        } catch { continue; }
        if (!(await isAdSizedImage(imageBuf))) continue;
        const artifact = await runMistralOcr(imageBuf);
        if (!artifact || !artifact.imageText.trim()) continue;
        const extracted = extractOffersFromOcrImage(artifact.imageText, {
          missionType: htmlRow.missionType,
          brand: site.brand,
        });
        console.log(`[analysis] img-src OCR site=${site.name} url=...${url.slice(-60)} extracted ${extracted.length} offer(s)`);
        for (const offer of extracted) {
          if (offer.confidence < 0.3) continue;
          const sig = [htmlRow.siteId, offer.offerType, offer.vehicleModel ?? "", offer.monthlyPayment ?? "", offer.apr ?? "", offer.termMonths ?? "", offer.cashIncentive ?? "", offer.salePrice ?? "", offer.dueAtSigning ?? "", offer.mileageAllowance ?? "", offer.matches?.serviceOffer ?? "", offer.offerType === "service" ? (offer.rawText ?? "") : ""].join("|");
          if (seen.has(sig)) continue;
          seen.add(sig);
          if (isUnmodeledPricedOffer(offer.offerType, offer.vehicleModel)) continue;
          pageFoundOffer = true;
          await db.insert(offers).values({
            collectionRunId: runId,
            siteId: htmlRow.siteId,
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

      // Sub-pass A: full-page screenshot OCR — fallback when per-image OCR found
      // nothing (e.g. JS-loaded images absent from the HTML snapshot). Uses the
      // screenshot captured alongside THIS html row.
      if (!pageFoundOffer) {
        const screenshotKey = `${htmlRow.siteId}:${htmlRow.missionType}:${htmlRow.label ?? ""}`;
        const screenshotRow = screenshotIndex.get(screenshotKey) ?? null;
        if (screenshotRow) {
          const buf = await getEvidenceBody(screenshotRow);
          if (buf) {
            const artifact = await getOcrArtifact(db, runId, screenshotRow, ocrCache, buf);
            const extracted = artifact && artifact.imageText.trim()
              ? extractOffers(artifact.imageText, { missionType: screenshotRow.missionType, brand: site.brand })
              : [];
            console.log(`[analysis] screenshot OCR fallback site=${site.name} screenshot=${screenshotRow.id} extracted ${extracted.length} offer(s)`);
            for (const offer of extracted) {
              if (offer.confidence < 0.3) continue;
              const sig = [htmlRow.siteId, offer.offerType, offer.vehicleModel ?? "", offer.monthlyPayment ?? "", offer.apr ?? "", offer.termMonths ?? "", offer.cashIncentive ?? "", offer.salePrice ?? "", offer.dueAtSigning ?? "", offer.mileageAllowance ?? "", offer.matches?.serviceOffer ?? "", offer.offerType === "service" ? (offer.rawText ?? "") : ""].join("|");
              if (seen.has(sig)) continue;
              seen.add(sig);
              if (isUnmodeledPricedOffer(offer.offerType, offer.vehicleModel)) continue;
              await db.insert(offers).values({
                collectionRunId: runId,
                siteId: htmlRow.siteId,
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
      }
    }

    if (imageOnlyBlocked.length > 0) {
      console.warn(
        `[analysis] WARNING: ${imageOnlyBlocked.length} page(s) look image-rendered but MISTRAL_API_KEY is not set, ` +
        `so the image pass is disabled and they get no image-based offers: ${imageOnlyBlocked.join(", ")}. ` +
        `Set MISTRAL_API_KEY in .env to enable OCR extraction for image-only platforms.`
      );
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
    enqueueAnalysis({ runId, rows, resume });
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
      const ocrCache = new Map<string, Promise<OcrArtifact | null>>();
      const seen = new Set<string>();
      // Per-page text yield, to gate the image pass per page (see processAnalysis).
      const domOffersByEvidence = new Map<string, number>();
      const disclaimerOffersByMission = new Map<string, number>();

      for (const { evidence: row, site } of htmlRows) {
        const html = await getEvidenceText(row);
        if (!html) continue;
        let extracted = extractOffers(html, { missionType: row.missionType, brand: site.brand });
        if (row.missionType === "service_specials" && extracted.length === 0) {
          extracted = await serviceCouponOffers(html, site.brand);
        }
        const pageText = htmlToText(html);
        const marketStates = [site.state, ...(site.otherStates ?? [])].filter((s): s is string => Boolean(s));
        const screenshotKey = `${row.siteId}:${row.missionType}:${row.label ?? ""}`;
        const screenshotRow = screenshotIndex.get(screenshotKey) ?? null;
        let screenshotBuffer: Buffer | null = null;
        if (screenshotRow) {
          screenshotBuffer = await getEvidenceBody(screenshotRow);
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
            if (enrichment && enrichment.confidence >= effective.confidence) { effective = { ...effective, ...enrichment }; aiAssisted = true; }
          }
          const matched = matchCapturedDisclaimer(effective, row.siteId, capturedDisclaimers);
          const disclaimerText = effective.disclaimerText ?? matched?.text ?? null;
          const vehicleModel = matched?.model ?? effective.vehicleModel;
          const mileageAllowance = effective.offerType === "lease" ? effective.mileageAllowance ?? parseMileage(disclaimerText) ?? parseMileage(effective.rawText) ?? deriveAnnualMileage(disclaimerText, effective.termMonths) ?? deriveAnnualMileage(effective.rawText, effective.termMonths) : null;
          if (isUnmodeledPricedOffer(effective.offerType, vehicleModel)) continue;
          await db.insert(offers).values({ collectionRunId: runId, siteId: row.siteId, sourceEvidenceId: row.id, offerType: effective.offerType, vehicleMake: effective.vehicleMake, vehicleModel, vehicleTrim: effective.vehicleTrim, monthlyPayment: effective.monthlyPayment, apr: effective.apr, cashIncentive: effective.cashIncentive, salePrice: effective.salePrice, termMonths: effective.termMonths, dueAtSigning: effective.dueAtSigning, mileageAllowance, rawText: effective.rawText, normalizedJson: { matches: offer.matches, aiAssisted }, disclaimerText, confidence: effective.confidence });
          domOffersByEvidence.set(row.id, (domOffersByEvidence.get(row.id) ?? 0) + 1);
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
        const extracted = extractOffersFromDisclosure(text, { missionType: row.missionType, brand: site.brand });
        const disclaimerMissionKey = `${row.siteId}:${row.missionType}`;
        const pricedDisclosureCount = extracted.filter((offer) =>
          ["lease", "finance", "cash"].includes(offer.offerType)
        ).length;
        if (pricedDisclosureCount > 0) {
          disclaimerOffersByMission.set(
            disclaimerMissionKey,
            (disclaimerOffersByMission.get(disclaimerMissionKey) ?? 0) + pricedDisclosureCount
          );
        }
        const marketStates = [site.state, ...(site.otherStates ?? [])].filter((s): s is string => Boolean(s));
        const screenshotBuffer = await getEvidenceBody(row);
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
            if (enrichment && enrichment.confidence >= effective.confidence) { effective = { ...effective, ...enrichment }; aiAssisted = true; }
          }
          const disclaimerText = disclaimerPortion(text).slice(0, 1000);
          const mileageAllowance = effective.offerType === "lease" ? effective.mileageAllowance ?? parseMileage(disclaimerText) ?? parseMileage(text) ?? deriveAnnualMileage(disclaimerText, effective.termMonths) ?? deriveAnnualMileage(text, effective.termMonths) : null;
          if (isUnmodeledPricedOffer(effective.offerType, effective.vehicleModel)) continue;
          await db.insert(offers).values({ collectionRunId: runId, siteId: row.siteId, sourceEvidenceId: row.id, offerType: effective.offerType, vehicleMake: effective.vehicleMake, vehicleModel: effective.vehicleModel, vehicleTrim: effective.vehicleTrim, monthlyPayment: effective.monthlyPayment, apr: effective.apr, cashIncentive: effective.cashIncentive, salePrice: effective.salePrice, termMonths: effective.termMonths, dueAtSigning: effective.dueAtSigning, mileageAllowance, rawText: effective.rawText, normalizedJson: { matches: offer.matches, aiAssisted }, disclaimerText, confidence: effective.confidence });
          const COMPLIANCE_TYPES: typeof effective.offerType[] = ["lease", "finance", "cash"];
          const result = COMPLIANCE_TYPES.includes(effective.offerType)
            ? await grader.grade({ evidenceId: row.id, offerType: effective.offerType, disclaimerText, adText: effective.rawText, dealerName: site.name, marketStates, screenshotBuffer })
            : { grade: "n/a", details: { notApplicable: true, offerType: effective.offerType } };
          await db.insert(complianceGrades).values({ evidenceId: row.id, collectionRunId: runId, grade: result.grade, detailsJson: result.details }).onConflictDoUpdate({ target: complianceGrades.evidenceId, set: { grade: result.grade, detailsJson: result.details, gradedAt: new Date() } });
        }
      }

      // Image pass (per page): mirror of processAnalysis. A page whose text yield
      // is smaller than its ad-card image count likely renders offers as graphics
      // (DDC/Dealer.com). Gate per html row so one weak text offer no longer
      // suppresses OCR recovery for this site+mission's other pages.
      for (const { evidence: htmlRow, site } of htmlRows) {
        if (htmlRow.missionType === "service_specials") continue;
        const coveredCount =
          (domOffersByEvidence.get(htmlRow.id) ?? 0) +
          (disclaimerOffersByMission.get(`${htmlRow.siteId}:${htmlRow.missionType}`) ?? 0);
        if (coveredCount > MAX_DOM_OFFERS_FOR_IMAGE_PASS) continue;
        const html = await getEvidenceText(htmlRow);
        if (!html) continue;
        const pageUrl = pageUrlFromLabel(htmlRow.label);
        const adImageUrls = extractAdImageUrls(html, pageUrl);
        const wantImagePass = coveredCount === 0 || adImageUrls.length > coveredCount;
        if (!wantImagePass) continue;
        const marketStates = [site.state, ...(site.otherStates ?? [])].filter((s): s is string => Boolean(s));
        console.log(`[partial-analysis] image pass site="${site.name}" mission=${htmlRow.missionType}: text offers=${coveredCount}, ad images=${adImageUrls.length}`);

        let pageFoundOffer = false;
        let directTried = 0;
        for (const url of adImageUrls) {
          if (directTried >= MAX_AD_IMAGES) break;
          directTried++;
          const directOffers = extractDealerInspireScene7Offers(url, {
            missionType: htmlRow.missionType,
            brand: site.brand,
          });
          if (directOffers.length === 0) continue;
          const imageBuf = await fetchImageBuffer(url);
          for (const offer of directOffers) {
            pageFoundOffer = (await insertImageExtractedOffer({
              db,
              runId,
              siteId: htmlRow.siteId,
              sourceEvidenceId: htmlRow.id,
              offer,
              seen,
              grader,
              dealerName: site.name,
              marketStates,
              screenshotBuffer: imageBuf,
              source: "dealer_inspire_scene7",
            })) || pageFoundOffer;
          }
        }

        if (pageFoundOffer) {
          console.log(`[partial-analysis] Dealer Inspire Scene7 parser site=${site.name} extracted direct offer(s)`);
          continue;
        }

        if (isMistralConfigured()) {
          let tried = 0;
          for (const url of adImageUrls) {
            if (tried >= MAX_AD_IMAGES) break;
            tried++;
            if (extractDealerInspireScene7Offers(url, {
              missionType: htmlRow.missionType,
              brand: site.brand,
            }).length > 0) {
              continue;
            }
            let imageBuf: Buffer | null = null;
            try {
              const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
              if (!resp.ok) continue;
              imageBuf = Buffer.from(await resp.arrayBuffer());
            } catch { continue; }
            if (!(await isAdSizedImage(imageBuf))) continue;
            const artifact = await runMistralOcr(imageBuf);
            if (!artifact || !artifact.imageText.trim()) continue;
            const extracted = extractOffersFromOcrImage(artifact.imageText, {
              missionType: htmlRow.missionType,
              brand: site.brand,
            });
            console.log(`[partial-analysis] img-src OCR site=${site.name} url=...${url.slice(-60)} extracted ${extracted.length} offer(s)`);
            for (const offer of extracted) {
              pageFoundOffer = (await insertImageExtractedOffer({
                db,
                runId,
                siteId: htmlRow.siteId,
                sourceEvidenceId: htmlRow.id,
                offer,
                seen,
                grader,
                dealerName: site.name,
                marketStates,
                screenshotBuffer: imageBuf,
                source: "image_extraction",
                aiAssisted: true,
              })) || pageFoundOffer;
            }
          }
        }

        if (!pageFoundOffer && isMistralConfigured()) {
          const screenshotKey = `${htmlRow.siteId}:${htmlRow.missionType}:${htmlRow.label ?? ""}`;
          const screenshotRow = screenshotIndex.get(screenshotKey) ?? null;
          if (screenshotRow) {
            const buf = await getEvidenceBody(screenshotRow);
            if (buf) {
              const artifact = await getOcrArtifact(db, runId, screenshotRow, ocrCache, buf);
              const extracted = artifact && artifact.imageText.trim()
                ? extractOffers(artifact.imageText, { missionType: screenshotRow.missionType, brand: site.brand })
                : [];
              console.log(`[partial-analysis] screenshot OCR fallback site=${site.name} mission=${htmlRow.missionType} screenshot=${screenshotRow.id} extracted ${extracted.length} offer(s)`);
              for (const offer of extracted) {
                await insertImageExtractedOffer({
                  db,
                  runId,
                  siteId: htmlRow.siteId,
                  sourceEvidenceId: screenshotRow.id,
                  offer,
                  seen,
                  grader,
                  dealerName: site.name,
                  marketStates,
                  screenshotBuffer: buf,
                  source: "image_extraction",
                  aiAssisted: true,
                });
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
