import { and, eq, inArray } from "drizzle-orm";
import {
  getDb,
  complianceGrades,
  evidence,
  ocrArtifacts,
  offers,
  sites,
  type Db,
  type Evidence,
  type MissionType,
  type Offer,
} from "@/lib/db";
import { isMistralConfigured } from "@/lib/env";
// Ad-graphic identification and capture belong to the collection phase; this
// layer only reads what collection stored (see the legacy fallback below).
import {
  MAX_AD_IMAGES,
  extractAdImageUrls,
  isAdSizedImage,
  redactUrl,
} from "@/lib/collector/ad-images";
import { getEvidenceBody, getEvidenceText, uploadEvidence } from "@/lib/evidence";
import {
  applyCouponVerdict,
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
import { runOcr, type OcrArtifact } from "./ocr";
import { parseMileage, deriveAnnualMileage } from "@/lib/report";
import {
  aiConfidenceThreshold,
  getCouponVerifier,
  getOfferEnricher,
  type OfferEnricher,
  type OfferEnrichment,
} from "./ai-enrich";
import { reportMinConfidence } from "@/lib/snapshot";
import { extractDealerInspireScene7Offers } from "./widgets/scene7";
import { extractOffersForPlatform } from "./platforms";

/**
 * The atomic analysis pipeline (see Docs/Analysis Pipeline Redesign.md). One
 * function, scoped to one site+mission, replaces what used to be two
 * hand-duplicated entry points (a full-run pass and a single-pair pass).
 * `runner.ts` decides scope — a full run, a resume, a single re-analyze, or a
 * re-collect catch-up are all just different lists of (siteId, missionType)
 * pairs handed to `runAnalysisForScope` one at a time.
 */

/** Applies an AI enrichment's FIELDS while keeping the rule-based confidence.
 *
 *  The enricher reports its own 0..1 self-assessment, which used to be spread
 *  straight onto the offer and stored in `offers.confidence`. That put two
 *  incompatible scales in one column: a deterministic completeness score for
 *  rows the rules handled, and a language model's opinion for rows they didn't.
 *  Two identical ads could then read 68% and 90% purely because one had a
 *  garbled character that sent it down the AI path. The rule score now always
 *  describes what the rules could verify; the model's number is kept alongside
 *  it (normalized_json.aiConfidence) for anyone auditing the AI pass.
 *
 *  The accept test is unchanged: a correction is only taken when the model is at
 *  least as confident as the guess it would replace. */
function applyEnrichment<T extends ExtractedOffer>(
  offer: T,
  enrichment: OfferEnrichment | null
): { offer: T; aiConfidence: number | null } {
  if (!enrichment || enrichment.confidence < offer.confidence) {
    return { offer, aiConfidence: null };
  }
  const { confidence, ...fields } = enrichment;
  return { offer: { ...offer, ...fields }, aiConfidence: confidence };
}

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

interface SiteInfo {
  brand: string | null;
  name: string;
  state: string | null;
  otherStates: string[] | null;
  platform: string | null;
}

export interface EvidenceWithSite {
  evidence: Evidence;
  site: SiteInfo;
}

export interface ScopePair {
  siteId: string;
  missionType: MissionType;
}

/** Every distinct site+mission pair this run has analyzable evidence for
 *  (html_snapshot or disclaimer_screenshot rows) — the full scope for a
 *  full-run analysis. */
export async function loadRunScopePairs(runId: string): Promise<ScopePair[]> {
  return getDb()
    .selectDistinct({ siteId: evidence.siteId, missionType: evidence.missionType })
    .from(evidence)
    .where(
      and(
        eq(evidence.collectionRunId, runId),
        inArray(evidence.evidenceType, ["html_snapshot", "disclaimer_screenshot"])
      )
    );
}

/** Site+mission pairs within a run that already have at least one persisted
 *  offer — used to filter a resume's scope down to pairs with no offers yet
 *  since the pause. */
export async function loadCompletedScopePairs(runId: string): Promise<ScopePair[]> {
  return getDb()
    .selectDistinct({ siteId: evidence.siteId, missionType: evidence.missionType })
    .from(offers)
    .innerJoin(evidence, eq(offers.sourceEvidenceId, evidence.id))
    .where(eq(offers.collectionRunId, runId));
}

export async function loadAnalyzableEvidenceForSiteMission(
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
      platform: sites.platform,
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
    site: { brand: r.brand, name: r.name, state: r.state, otherStates: r.otherStates, platform: r.platform },
  }));
}

export async function loadDisclaimerEvidenceForSiteMission(
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
      platform: sites.platform,
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
      site: { brand: r.brand, name: r.name, state: r.state, otherStates: r.otherStates, platform: r.platform },
    }));
}

export interface CapturedDisclaimer {
  siteId: string;
  text: string;
}

/** Disclaimer-screenshot rows with captured modal text, across the WHOLE run —
 *  a secondary offer-matching source for platforms (e.g. DDC/Dealer.com) where
 *  the HTML snapshot has image-only offer cards with no DOM price text. Loaded
 *  run-wide because a disclaimer captured on one page can corroborate an offer
 *  extracted from another page of the same site. */
export async function loadCapturedDisclaimers(
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

/** Screenshot evidence rows for the run, keyed by "siteId:missionType:label"
 *  so each HTML snapshot can find its paired page screenshot. */
export async function loadScreenshotIndex(
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

/** Ad graphics the collector stored for this run, grouped by SITE.
 *
 *  These are the primary input to the image pass. A given image URL is stored
 *  once per run (the capture key is run+URL), so a hero graphic that appears on
 *  the homepage, the specials page, and every carousel state of both yields one
 *  row — and therefore one OCR call — instead of one per page state.
 *
 *  Grouped by site and NOT by mission precisely because of that dedupe: the one
 *  stored row carries whichever mission happened to capture it first, so keying
 *  by mission made every sibling mission look like it had no ad graphics at all.
 *  Those pages then fell through to full-page screenshot OCR, which re-read the
 *  same banner at page scale — a duplicate, lower-confidence offer whose "View
 *  ad" opened the whole page instead of the ad. Callers narrow the site-wide set
 *  to the images their own page renders. */
export async function loadAdImageIndex(
  runId: string
): Promise<Map<string, Evidence[]>> {
  const rows = await getDb()
    .select({ evidence })
    .from(evidence)
    .where(
      and(
        eq(evidence.collectionRunId, runId),
        eq(evidence.evidenceType, "ad_image")
      )
    );
  const index = new Map<string, Evidence[]>();
  for (const { evidence: row } of rows) {
    const list = index.get(row.siteId);
    if (list) list.push(row);
    else index.set(row.siteId, [row]);
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
 *  pipeline call (a screenshot referenced by several low-confidence offers on
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
      const artifact = await runOcr(buf);
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

/** Stores an ad graphic the image pass read as its own evidence row, so the
 *  offers extracted from it link to THAT ad and not to the whole-page HTML
 *  snapshot. Without this every image-extracted offer on a page shared one
 *  sourceEvidenceId: "View ad" opened the same stored page for all of them, and
 *  — because compliance grades are unique per evidence — the last offer graded
 *  overwrote the grades of every other offer on the page (a lease grade shown
 *  on finance rows). Stored as `screenshot`: it is an image, served like one,
 *  so no schema change is needed. captureKey makes re-analysis reuse the row
 *  instead of duplicating the upload. Returns null if the upload fails, and
 *  callers fall back to the page evidence. */
async function storeAdImageEvidence(input: {
  runId: string;
  siteId: string;
  missionType: MissionType;
  imageUrl: string;
  body: Buffer;
}): Promise<string | null> {
  try {
    const row = await uploadEvidence({
      collectionRunId: input.runId,
      siteId: input.siteId,
      missionType: input.missionType,
      evidenceType: "screenshot",
      fileName: new URL(input.imageUrl).pathname.split("/").pop() || "ad.jpg",
      body: input.body,
      label: `Ad graphic — ${redactUrl(input.imageUrl)}`,
      captureKey: `${input.runId}:ad-image:${input.imageUrl}`,
      sourceUrl: redactUrl(input.imageUrl),
    });
    return row.id;
  } catch (err) {
    console.error(`[analysis] ad image evidence upload failed url=${redactUrl(input.imageUrl)}:`, err);
    return null;
  }
}

/** One offer-card graphic the image pass can read, however it was obtained.
 *  Normally an evidence row the collector stored; for pre-capture runs, a live
 *  URL. Keeping both behind one shape means the pass itself has no idea which
 *  it's working with. */
interface AdSource {
  /** Original image URL. The Scene7 parser reads offer terms out of its query
   *  parameters, so the pass needs it even when the bytes come from R2. */
  url: string;
  /** Evidence row for the graphic, when collection stored it. */
  evidenceId: string | null;
  load: () => Promise<Buffer | null>;
}

/** Pre-capture runs only: ad graphics resolved by live-fetching the dealer's
 *  CDN during analysis. Kept so historical runs stay re-analysable. Anything
 *  captured after ad-image capture shipped reads stored evidence instead — see
 *  src/lib/collector/ad-images.ts for why that matters. */
function legacyAdSources(urls: string[]): AdSource[] {
  return urls.slice(0, MAX_AD_IMAGES).map((url) => ({
    url,
    evidenceId: null,
    load: async () => {
      const buf = await fetchImageBuffer(url);
      return (await isAdSizedImage(buf)) ? buf : null;
    },
  }));
}

/** The stored ad graphics to run the image pass over for ONE page: the ones
 *  captured from that page's own states, plus any of the site's graphics this
 *  page's HTML references. The second half is what makes shared creative work —
 *  capture stores an image URL once per run, so a banner the homepage and the
 *  finance page both show belongs to whichever mission reached it first, and the
 *  other page would otherwise see no ad graphics at all and fall through to
 *  full-page screenshot OCR. */
export function storedAdSources(
  index: Map<string, Evidence[]>,
  htmlRow: Evidence,
  html: string
): AdSource[] {
  // Capture-state ids are "<pageId>:<state>" — the prefix is the page.
  const pageId = htmlRow.captureStateId?.split(":")[0];
  const onPage = new Set(
    extractAdImageUrls(html, pageUrlFromLabel(htmlRow.label)).map(imageKey)
  );
  return (index.get(htmlRow.siteId) ?? [])
    .filter(
      (row) =>
        (pageId && row.captureStateId?.startsWith(`${pageId}:`)) ||
        (row.sourceUrl != null && onPage.has(imageKey(row.sourceUrl)))
    )
    .map((row) => ({
      url: row.sourceUrl ?? "",
      evidenceId: row.id,
      load: () => getEvidenceBody(row),
    }));
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

/** Fields the dedup key is built from — the shape both a freshly extracted
 *  offer and a persisted `offers` row satisfy, so the same key computation
 *  covers within-call dedup AND the cross-call seed from persisted rows below. */
interface OfferSignatureFields {
  offerType: string;
  vehicleModel: string | null;
  vehicleTrim: string | null;
  monthlyPayment: number | null;
  apr: number | null;
  termMonths: number | null;
  cashIncentive: number | null;
  salePrice: number | null;
  dueAtSigning: number | null;
  mileageAllowance: number | null;
  rawText?: string | null;
  matches?: Record<string, string> | null;
}

/** The ONE dedup key, used by every pass (DOM, disclaimer, image) and by the
 *  persisted-offer seed below. Must include `vehicleTrim` — its previous
 *  absence from three of four inline copies of this key is what let
 *  trim-only-different offers (e.g. "Civic LX $199/mo" and "Civic EX $199/mo")
 *  collide and silently drop the second. */
function offerSignature(siteId: string, offer: OfferSignatureFields): string {
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

function offerSignatureFromPersistedRow(siteId: string, row: Offer): string {
  const matches =
    (row.normalizedJson as { matches?: Record<string, string> } | null)?.matches ?? null;
  return offerSignature(siteId, { ...row, matches });
}

/** Seeds the in-call dedup set from offers already persisted for this site+run
 *  — a DB read, not an in-memory Set scoped to this one call. Required because
 *  atomic calls for different missions on the same site can run at different
 *  times (e.g. home page analyzed today, specials page re-analyzed tomorrow),
 *  and a duplicate offer appearing on both pages must still collapse to one row
 *  regardless of call order. This scope's OWN prior offers were already deleted
 *  by the time this runs, so what's left is exactly the other missions' rows to
 *  dedup against. */
async function loadPersistedSignatures(
  db: Db,
  runId: string,
  siteId: string
): Promise<Set<string>> {
  const rows = await db
    .select()
    .from(offers)
    .where(and(eq(offers.collectionRunId, runId), eq(offers.siteId, siteId)));
  return new Set(rows.map((row) => offerSignatureFromPersistedRow(siteId, row)));
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
  /** The ad's own transcribed text (OCR output, or the Scene7 raw copy). Scope
   *  for model recovery below — one ad, so no cross-ad bleed. */
  adText?: string | null;
  /** Dealer brand prior, for the same recovery. */
  brand?: string | null;
  enricher?: OfferEnricher;
  aiThreshold?: number;
}): Promise<boolean> {
  const {
    db,
    runId,
    siteId,
    sourceEvidenceId,
    seen,
    grader,
    dealerName,
    marketStates,
    screenshotBuffer,
    source,
    adText = null,
    brand = null,
    enricher,
    aiThreshold = 0,
  } = input;

  let offer = input.offer;
  let aiAssisted = input.aiAssisted ?? false;
  let aiConfidence: number | null = null;

  if (offer.confidence < 0.3) return false;
  // Cheap exact-duplicate exit before spending anything on recovery. Recorded
  // alongside the resolved signature below, otherwise a second copy of the same
  // model-less ad misses this exit and re-pays for enrichment only to be
  // deduped afterwards.
  const rawSig = offerSignature(siteId, offer);
  if (seen.has(rawSig)) return false;

  // Model recovery, which this path used to have none of. A priced offer with
  // no model is discarded outright (isUnmodeledPricedOffer), and the DOM pass
  // gets two chances to resolve one — an OCR hint and the AI enricher — while
  // the image pass got zero, so a correctly-read, correctly-parsed ad was
  // simply thrown away. Elmwood's "SAVE $5,000 ON ALL JEEP GRAND WAGONEERS AND
  // GET 2.97% APR for 72 months" was read, classified as finance at 2.97%, and
  // dropped for want of the word "Wagoneer" in a form findKnownModel accepted.
  const needsModel =
    isUnmodeledPricedOffer(offer.offerType, offer.vehicleModel) ||
    offer.confidence < aiThreshold;
  if (needsModel) {
    const hint = adText ? findKnownModel(adText) : null;
    if (hint && !offer.vehicleModel) {
      offer = { ...offer, vehicleModel: hint };
    }
    // Same gate as the DOM pass: still unmodeled after the hint, OR simply
    // under-confident. Gating on isUnmodeledPricedOffer alone made the
    // confidence half of `needsModel` unreachable, so a low-confidence offer
    // that already carried a model never got enriched here and sank below the
    // publish floor — the very divergence this block was added to close.
    if (
      enricher &&
      (isUnmodeledPricedOffer(offer.offerType, offer.vehicleModel) ||
        offer.confidence < aiThreshold)
    ) {
      const enrichment = await enricher.enrich({
        pageText: adText ?? offer.rawText ?? "",
        brand,
        current: offer,
        ocrModelHint: hint,
      });
      const applied = applyEnrichment(offer, enrichment);
      offer = applied.offer;
      if (applied.aiConfidence !== null) {
        aiAssisted = true;
        aiConfidence = applied.aiConfidence;
      }
    }
  }

  // Signature is computed on the RESOLVED offer: recovering a model changes it,
  // and deduping on the pre-recovery shape would let the same ad land twice
  // (once model-less from one page state, once resolved from another).
  const sig = offerSignature(siteId, offer);
  if (seen.has(sig)) return false;
  seen.add(sig);
  seen.add(rawSig);
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
    normalizedJson: { matches: offer.matches, aiAssisted, aiConfidence, source },
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
 *  alt_only) and a confidence set by that agreement. A `mismatch` is then
 *  adjudicated by the service-shaped coupon verifier (confirm the OCR read or
 *  drop the row) so it doesn't sit unpublishable at 0.50. Called only when the DOM
 *  pass found nothing, so DOM-text coupons keep their trusted extraction and
 *  never pay for OCR. Degrades gracefully: if Mistral is off or an image fails,
 *  the alt cross-check alone still yields an (alt_only) offer. */
async function serviceCouponOffers(
  html: string,
  brand: string | null,
  /** Coupon graphics the collector stored, by original URL. Coupons are ad
   *  graphics like any other, so capture already stores them; reading from here
   *  keeps this pass off the dealer's site, same as the offer-card pass. Empty
   *  for runs captured before ad-image capture shipped, which then fall back to
   *  a live fetch. */
  storedByUrl: Map<string, Evidence>
): Promise<ExtractedOffer[]> {
  const coupons = findServiceCouponImages(html);
  if (coupons.length === 0) return [];
  const hints = { missionType: "service_specials" as const, brand };
  const mistralOn = isMistralConfigured();
  const verifier = getCouponVerifier();
  const out: ExtractedOffer[] = [];
  let tried = 0;
  for (const coupon of coupons) {
    if (tried >= MAX_COUPON_IMAGES) break;
    tried++;
    let ocrText: string | null = null;
    if (mistralOn) {
      try {
        const stored = storedByUrl.get(imageKey(coupon.imageUrl));
        const buf = stored
          ? await getEvidenceBody(stored)
          : await fetchImageBuffer(coupon.imageUrl);
        if (buf && (await isAdSizedImage(buf))) {
          const artifact = await runOcr(buf);
          ocrText = artifact?.imageText ?? null;
        }
      } catch {
        // Image read/OCR failed — fall back to the alt cross-check alone.
      }
    }
    const offer = reconcileServiceCoupon(ocrText, coupon.alt, hints);
    if (!offer) continue;
    // A coupon whose two reads disagree scores 0.50 — under the publish floor,
    // and out of reach of both AI routing conditions (the vehicle enricher is
    // deliberately kept away from service offers). Adjudicate it here, where
    // both readings are still in hand: confirm the OCR read or drop the row.
    if (offer.matches.verify === "mismatch") {
      const verdict = await verifier.verify({
        brand,
        label: offer.rawText,
        ocrValue: offer.matches.ocrValue ?? "",
        altValue: offer.matches.altValue ?? "",
        ocrText,
        altText: coupon.alt,
      });
      if (verdict) applyCouponVerdict(offer, verdict, reportMinConfidence());
    }
    out.push(offer);
  }
  return out;
}

/** Identity of an image across the different URLs a page uses for it: origin
 *  plus path, no query. The coupon scanner reads `data-image-url` (the
 *  unresized original) while ad-image capture reads `src` (the CDN's resized
 *  variant, `?impolicy=downsize_bkpt&w=1600`). Same picture, two URLs — matching
 *  on the full string silently missed every stored coupon and fell back to
 *  fetching the dealer's site. */
function imageKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

/** Stored ad graphics for one site, keyed by image identity. Callers match
 *  against URLs read out of a specific page, so the site-wide set costs nothing
 *  extra — an image the page doesn't reference is simply never looked up. */
function adImagesByUrl(
  index: Map<string, Evidence[]>,
  siteId: string
): Map<string, Evidence> {
  const byUrl = new Map<string, Evidence>();
  for (const row of index.get(siteId) ?? []) {
    if (row.sourceUrl) byUrl.set(imageKey(row.sourceUrl), row);
  }
  return byUrl;
}

/** Resources scoped to a whole run rather than one site+mission pair, so a
 *  caller driving many pairs for the same run (a full run, a resume) can build
 *  them once and reuse them across every pair instead of paying for a fresh
 *  AdScore batch / a fresh set of run-wide DB reads on every single pair. When
 *  omitted (the single-pair callers — manual re-analyze, re-collect catch-up),
 *  each pair builds its own, same cost profile those callers always had. */
export interface RunAnalysisSharedContext {
  grader?: ComplianceGrader;
  capturedDisclaimers?: CapturedDisclaimer[];
  screenshotIndex?: Map<string, Evidence>;
  adImageIndex?: Map<string, Evidence[]>;
}

/**
 * The atomic pipeline: extract, dedup, insert, grade — scoped to ONE
 * site+mission within one run. Every caller (full run, resume, manual
 * re-analyze, re-collect catch-up) is just a different list of
 * (siteId, missionType) pairs handed to this one function.
 */
export async function runAnalysisForScope(
  runId: string,
  siteId: string,
  missionType: MissionType,
  shared?: RunAnalysisSharedContext
): Promise<"analyzed" | "no_evidence"> {
  const db = getDb();
  const htmlRows = await loadAnalyzableEvidenceForSiteMission(runId, siteId, missionType);
  const disclaimerRows = await loadDisclaimerEvidenceForSiteMission(runId, siteId, missionType);
  if (htmlRows.length === 0 && disclaimerRows.length === 0) return "no_evidence";

  console.log(`[analysis] run=${runId} site=${siteId} mission=${missionType} html=${htmlRows.length} disclaimer=${disclaimerRows.length}`);

  // Delete this scope's existing offers/grades — its own evidence ids only,
  // never the whole run. Every evidence row for this site+mission, not just the
  // html/disclaimer rows read above: the image pass stores each OCR'd ad
  // graphic as its own evidence row, and offers hang off THOSE too.
  const allEvidenceIds = (
    await db
      .select({ id: evidence.id })
      .from(evidence)
      .where(
        and(
          eq(evidence.collectionRunId, runId),
          eq(evidence.siteId, siteId),
          eq(evidence.missionType, missionType)
        )
      )
  ).map((r) => r.id);
  if (allEvidenceIds.length > 0) {
    await db.delete(offers).where(inArray(offers.sourceEvidenceId, allEvidenceIds));
    await db
      .delete(complianceGrades)
      .where(
        and(
          eq(complianceGrades.collectionRunId, runId),
          inArray(complianceGrades.evidenceId, allEvidenceIds)
        )
      );
  }

  const grader = shared?.grader ?? getComplianceGrader(runId);
  const enricher = getOfferEnricher();
  const aiThreshold = aiConfidenceThreshold();
  const capturedDisclaimers = shared?.capturedDisclaimers ?? (await loadCapturedDisclaimers(runId));
  const screenshotIndex = shared?.screenshotIndex ?? (await loadScreenshotIndex(runId));
  const adImageIndex = shared?.adImageIndex ?? (await loadAdImageIndex(runId));
  const runHasStoredAdImages = adImageIndex.size > 0;
  const ocrCache = new Map<string, Promise<OcrArtifact | null>>();

  // Seed dedup with what's already persisted for this site+run (see
  // loadPersistedSignatures) — makes dedup correct across calls regardless of
  // which mission gets analyzed first.
  const seen = await loadPersistedSignatures(db, runId, siteId);
  // Per-page text yield, used to gate the image pass PER PAGE (not per site).
  const domOffersByEvidence = new Map<string, number>();
  const disclaimerOffersByMission = new Map<string, number>();

  // --- Pass 1: DOM extraction ---------------------------------------------
  for (const { evidence: row, site } of htmlRows) {
    const html = await getEvidenceText(row);
    if (!html) continue;
    let extracted = extractOffersForPlatform(html, { missionType: row.missionType, brand: site.brand }, site.platform);
    if (row.missionType === "service_specials" && extracted.length === 0) {
      extracted = await serviceCouponOffers(html, site.brand, adImagesByUrl(adImageIndex, row.siteId));
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
      const sig = offerSignature(row.siteId, offer);
      if (seen.has(sig)) continue;
      seen.add(sig);

      let effective = offer;
      let aiAssisted = false;
      let aiConfidence: number | null = null;
      if (offer.confidence < aiThreshold || (effective.vehicleModel === null && effective.offerType !== "service")) {
        let ocrModelHint: string | null = null;
        if (effective.vehicleModel === null && screenshotRow) {
          const artifact = await getOcrArtifact(db, runId, screenshotRow, ocrCache, screenshotBuffer);
          if (artifact) ocrModelHint = findKnownModel(artifact.imageText);
        }
        const enrichment = await enricher.enrich({ pageText, brand: site.brand, current: effective, ocrModelHint });
        const applied = applyEnrichment(effective, enrichment);
        effective = applied.offer;
        if (applied.aiConfidence !== null) { aiAssisted = true; aiConfidence = applied.aiConfidence; }
      }

      const matched = matchCapturedDisclaimer(effective, row.siteId, capturedDisclaimers);
      const disclaimerText = effective.disclaimerText ?? matched?.text ?? null;
      const vehicleModel = matched?.model ?? effective.vehicleModel;
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
        normalizedJson: {
          matches: offer.matches,
          aiAssisted,
          aiConfidence,
          ...(offer.aiVerified ? { aiVerified: offer.aiVerified } : {}),
        },
        disclaimerText,
        confidence: effective.confidence,
      });
      domOffersByEvidence.set(row.id, (domOffersByEvidence.get(row.id) ?? 0) + 1);

      const COMPLIANCE_TYPES: typeof effective.offerType[] = ["lease", "finance", "cash"];
      const result = COMPLIANCE_TYPES.includes(effective.offerType)
        ? await grader.grade({ evidenceId: row.id, offerType: effective.offerType, disclaimerText, adText: effective.rawText, dealerName: site.name, marketStates, screenshotBuffer })
        : { grade: "n/a", details: { notApplicable: true, offerType: effective.offerType } };
      await db.insert(complianceGrades)
        .values({ evidenceId: row.id, collectionRunId: runId, grade: result.grade, detailsJson: result.details })
        .onConflictDoUpdate({ target: complianceGrades.evidenceId, set: { grade: result.grade, detailsJson: result.details, gradedAt: new Date() } });
    }
  }

  // --- Pass 2: disclaimer-modal text extraction ---------------------------
  // Platforms like DDC/Dealer.com render offer prices as images, so the HTML
  // snapshot has no price text — but the modal's text_content has the full
  // offer details. Same extraction + dedup pipeline; the shared `seen` set
  // prevents duplicates with DOM-extracted offers.
  for (const { evidence: row, site } of disclaimerRows) {
    if (row.missionType === "service_specials") continue;
    const text = row.textContent!;
    const extracted = extractOffersFromDisclosure(text, { missionType: row.missionType, brand: site.brand });
    const disclaimerMissionKey = `${row.siteId}:${row.missionType}`;
    const pricedDisclosureCount = extracted.filter((offer) => ["lease", "finance", "cash"].includes(offer.offerType)).length;
    if (pricedDisclosureCount > 0) {
      disclaimerOffersByMission.set(disclaimerMissionKey, (disclaimerOffersByMission.get(disclaimerMissionKey) ?? 0) + pricedDisclosureCount);
    }
    const marketStates = [site.state, ...(site.otherStates ?? [])].filter((s): s is string => Boolean(s));
    const screenshotBuffer = await getEvidenceBody(row);
    const pageText = text;

    for (const offer of extracted) {
      // The evidence label stores the ad-anchor text that launched this modal
      // (e.g. "2025 Nissan Rogue · $379/mo"). When the disclaimer body text has
      // no model name, pull it from the label before computing the dedup
      // signature — so a label-recovered "Rogue" matches an HTML-extracted
      // "Rogue" and we don't insert the same offer twice for non-DDC sites.
      let effective = offer;
      if (!effective.vehicleModel && row.label) {
        const labelModel = findKnownModel(row.label);
        if (labelModel) effective = { ...effective, vehicleModel: labelModel };
      }

      const sig = offerSignature(row.siteId, effective);
      if (seen.has(sig)) continue;
      seen.add(sig);

      let aiAssisted = false;
      let aiConfidence: number | null = null;
      if (effective.confidence < aiThreshold || effective.vehicleModel === null) {
        let ocrModelHint: string | null = null;
        if (effective.vehicleModel === null) {
          const artifact = await getOcrArtifact(db, runId, row, ocrCache, screenshotBuffer);
          if (artifact) ocrModelHint = findKnownModel(artifact.imageText);
        }
        const enrichment = await enricher.enrich({ pageText, brand: site.brand, current: effective, ocrModelHint });
        const applied = applyEnrichment(effective, enrichment);
        effective = applied.offer;
        if (applied.aiConfidence !== null) { aiAssisted = true; aiConfidence = applied.aiConfidence; }
      }

      const disclaimerText = disclaimerPortion(text).slice(0, 1000);
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
        normalizedJson: {
          matches: offer.matches,
          aiAssisted,
          aiConfidence,
          ...(offer.aiVerified ? { aiVerified: offer.aiVerified } : {}),
        },
        disclaimerText,
        confidence: effective.confidence,
      });

      const COMPLIANCE_TYPES: typeof effective.offerType[] = ["lease", "finance", "cash"];
      const result = COMPLIANCE_TYPES.includes(effective.offerType)
        ? await grader.grade({ evidenceId: row.id, offerType: effective.offerType, disclaimerText, adText: effective.rawText, dealerName: site.name, marketStates, screenshotBuffer })
        : { grade: "n/a", details: { notApplicable: true, offerType: effective.offerType } };
      await db.insert(complianceGrades)
        .values({ evidenceId: row.id, collectionRunId: runId, grade: result.grade, detailsJson: result.details })
        .onConflictDoUpdate({ target: complianceGrades.evidenceId, set: { grade: result.grade, detailsJson: result.details, gradedAt: new Date() } });
    }
  }

  // --- Pass 3: image/OCR extraction ---------------------------------------
  // A page whose DOM + disclaimer text yielded very few offers relative to its
  // ad-card images likely renders offers as graphics (DDC/Dealer.com). OCR that
  // page's ad images and, as a fallback, its full screenshot.
  const mistralOn = isMistralConfigured();
  if (!runHasStoredAdImages) {
    console.warn(`[analysis] run ${runId} stored no ad images — using the legacy live-fetch path.`);
  }
  const adOcrByUrl = new Map<string, OcrArtifact | null>();
  for (const { evidence: htmlRow, site } of htmlRows) {
    if (htmlRow.missionType === "service_specials") continue;
    const coveredCount =
      (domOffersByEvidence.get(htmlRow.id) ?? 0) +
      (disclaimerOffersByMission.get(`${htmlRow.siteId}:${htmlRow.missionType}`) ?? 0);
    if (coveredCount > MAX_DOM_OFFERS_FOR_IMAGE_PASS) continue;

    const html = await getEvidenceText(htmlRow);
    if (!html) continue;

    const adSources: AdSource[] = runHasStoredAdImages
      ? storedAdSources(adImageIndex, htmlRow, html)
      : legacyAdSources(extractAdImageUrls(html, pageUrlFromLabel(htmlRow.label)));

    const wantImagePass = coveredCount === 0 || adSources.length > coveredCount;
    if (!wantImagePass) continue;

    const marketStates = [site.state, ...(site.otherStates ?? [])].filter((s): s is string => Boolean(s));
    console.log(`[analysis] image pass site="${site.name}" mission=${htmlRow.missionType}: text offers=${coveredCount}, ad images=${adSources.length}${runHasStoredAdImages ? " (stored)" : " (legacy live fetch)"}`);

    let pageFoundOffer = false;

    for (const ad of adSources) {
      const directOffers = extractDealerInspireScene7Offers(ad.url, { missionType: htmlRow.missionType, brand: site.brand });
      if (directOffers.length === 0) continue;
      const imageBuf = await ad.load();
      const adEvidenceId =
        ad.evidenceId ??
        (imageBuf
          ? await storeAdImageEvidence({ runId, siteId: htmlRow.siteId, missionType: htmlRow.missionType, imageUrl: ad.url, body: imageBuf })
          : null);
      for (const offer of directOffers) {
        pageFoundOffer = (await insertImageExtractedOffer({
          db, runId, siteId: htmlRow.siteId, sourceEvidenceId: adEvidenceId ?? htmlRow.id, offer, seen, grader,
          dealerName: site.name, marketStates, screenshotBuffer: imageBuf, source: "dealer_inspire_scene7",
          adText: offer.disclaimerText ?? offer.rawText, brand: site.brand, enricher, aiThreshold,
        })) || pageFoundOffer;
      }
    }

    if (pageFoundOffer) {
      console.log(`[analysis] Dealer Inspire Scene7 parser site=${site.name} extracted direct offer(s)`);
      continue;
    }

    if (mistralOn) {
      for (const ad of adSources) {
        if (extractDealerInspireScene7Offers(ad.url, { missionType: htmlRow.missionType, brand: site.brand }).length > 0) continue;
        const imageBuf = await ad.load();
        if (!imageBuf) continue;
        let artifact = adOcrByUrl.get(ad.url);
        if (artifact === undefined) {
          artifact = await runOcr(imageBuf);
          adOcrByUrl.set(ad.url, artifact);
        }
        if (!artifact || !artifact.imageText.trim()) continue;
        const extracted = extractOffersFromOcrImage(artifact.imageText, { missionType: htmlRow.missionType, brand: site.brand });
        console.log(`[analysis] img-src OCR site=${site.name} url=...${redactUrl(ad.url).slice(-60)} extracted ${extracted.length} offer(s)`);
        const adEvidenceId = ad.evidenceId ?? (await storeAdImageEvidence({ runId, siteId: htmlRow.siteId, missionType: htmlRow.missionType, imageUrl: ad.url, body: imageBuf }));
        for (const offer of extracted) {
          pageFoundOffer = (await insertImageExtractedOffer({
            db, runId, siteId: htmlRow.siteId, sourceEvidenceId: adEvidenceId ?? htmlRow.id, offer, seen, grader,
            dealerName: site.name, marketStates, screenshotBuffer: imageBuf, source: "image_extraction",
            adText: artifact.imageText, brand: site.brand, enricher, aiThreshold,
          })) || pageFoundOffer;
        }
      }
    }

    if (!pageFoundOffer && mistralOn) {
      const screenshotKey = `${htmlRow.siteId}:${htmlRow.missionType}:${htmlRow.label ?? ""}`;
      const screenshotRow = screenshotIndex.get(screenshotKey) ?? null;
      if (screenshotRow) {
        const buf = await getEvidenceBody(screenshotRow);
        if (buf) {
          const artifact = await getOcrArtifact(db, runId, screenshotRow, ocrCache, buf);
          const extracted = artifact && artifact.imageText.trim()
            ? extractOffers(artifact.imageText, { missionType: screenshotRow.missionType, brand: site.brand })
            : [];
          console.log(`[analysis] screenshot OCR fallback site=${site.name} mission=${htmlRow.missionType} screenshot=${screenshotRow.id} extracted ${extracted.length} offer(s)`);
          for (const offer of extracted) {
            await insertImageExtractedOffer({
              db, runId, siteId: htmlRow.siteId, sourceEvidenceId: screenshotRow.id, offer, seen, grader,
              dealerName: site.name, marketStates, screenshotBuffer: buf, source: "image_extraction",
              aiAssisted: true, adText: artifact?.imageText ?? null, brand: site.brand, enricher, aiThreshold,
            });
          }
        }
      }
    }
  }

  if (!mistralOn) {
    console.warn(`[analysis] MISTRAL_API_KEY not set — image pass ran Scene7-only for run=${runId} site=${siteId} mission=${missionType}.`);
  }

  return "analyzed";
}
