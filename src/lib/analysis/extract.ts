import type { MissionType, OfferType } from "@/lib/db";

/**
 * Rule-based offer extraction (Phase 9 classification + normalization). Reads
 * the rendered HTML snapshot text and pulls structured offer fields with
 * deterministic patterns — no AI (that is the Phase 12 fallback for
 * low-confidence cases this pass deliberately leaves behind).
 *
 * Multi-offer pages are handled by windowing: every `$X/mo` (and APR-only)
 * anchor in the page text gets its own bounded excerpt, so a specials page
 * with 4 lease cards yields up to 4 offers. Service specials stay full-page
 * (one URL = one service item).
 */

export interface ExtractedOffer {
  offerType: OfferType;
  vehicleMake: string | null;
  vehicleModel: string | null;
  vehicleTrim: string | null;
  monthlyPayment: number | null;
  apr: number | null;
  cashIncentive: number | null;
  termMonths: number | null;
  dueAtSigning: number | null;
  disclaimerText: string | null;
  /** Short human-readable context around the primary match. */
  rawText: string | null;
  /** 0..1 — how much structured signal backed this record. */
  confidence: number;
  /** Raw matched substrings, preserved for drill-down in normalized_json. */
  matches: Record<string, string>;
}

export interface ExtractHints {
  missionType: MissionType;
  /** The dealer's brand(s), a strong prior for vehicle make. */
  brand?: string | null;
}

// Makes we recognize for vehicle classification. Lowercased compare.
const KNOWN_MAKES = [
  "Acura", "Audi", "BMW", "Buick", "Cadillac", "Chevrolet", "Chrysler",
  "Dodge", "Ford", "Genesis", "GMC", "Honda", "Hyundai", "Infiniti", "Jeep",
  "Kia", "Lexus", "Lincoln", "Mazda", "Mercedes-Benz", "Mitsubishi", "Nissan",
  "Porsche", "Ram", "Subaru", "Tesla", "Toyota", "Volkswagen", "Volvo",
];

// Real model names for the brands in the dataset. The extractor emits a model
// ONLY if it matches one of these — a null model beats junk like "Dealer" or
// "Safety Sense" grabbed from page chrome. Multi-word models are matched
// longest-first so "Grand Cherokee" wins over "Cherokee". Lowercased compare.
const KNOWN_MODELS = [
  // Toyota
  "Grand Highlander", "Land Cruiser", "Corolla Cross", "Prius Prime", "RAV4 Prime",
  "Camry", "Corolla", "RAV4", "Highlander", "Tacoma", "Tundra", "4Runner",
  "Sienna", "Prius", "Venza", "Sequoia", "Crown", "bZ4X", "GR86", "GR Corolla",
  "Supra", "C-HR", "Avalon", "Mirai",
  // Honda
  "Civic", "Accord", "CR-V", "Pilot", "Odyssey", "HR-V", "Passport",
  "Ridgeline", "Insight", "Prologue",
  // Nissan
  "Altima", "Sentra", "Maxima", "Rogue", "Murano", "Pathfinder", "Kicks",
  "Frontier", "Titan", "Versa", "Leaf", "Ariya", "Armada",
  // Subaru
  "Outback", "Forester", "Crosstrek", "Impreza", "Legacy", "Ascent", "WRX",
  "BRZ", "Solterra",
  // Kia
  "Telluride", "Sportage", "Sorento", "Carnival", "Seltos", "Forte", "Soul",
  "Niro", "EV6", "EV9", "Stinger", "Rio", "K5", "Optima",
  // Hyundai
  "Santa Cruz", "Santa Fe", "Ioniq 5", "Ioniq 6", "Ioniq", "Tucson", "Palisade",
  "Elantra", "Sonata", "Kona", "Venue", "Accent", "Veloster",
  // Chrysler / Dodge / Jeep / Ram
  "Grand Cherokee", "Grand Wagoneer", "Pacifica", "Wrangler", "Cherokee",
  "Compass", "Renegade", "Gladiator", "Wagoneer", "Durango", "Charger",
  "Challenger", "Hornet", "ProMaster", "1500", "2500", "3500", "300",
  // Chevrolet / GMC / Buick
  "Silverado", "Equinox", "Traverse", "Tahoe", "Suburban", "Malibu", "Trax",
  "Trailblazer", "Blazer", "Colorado", "Camaro", "Corvette", "Sierra",
  "Terrain", "Acadia", "Yukon", "Canyon", "Encore", "Enclave", "Envision",
  "Envista",
  // Ford
  "F-150", "Escape", "Explorer", "Edge", "Bronco", "Mustang", "Ranger",
  "Maverick", "Expedition",
  // Volvo
  "XC90", "XC60", "XC40", "S60", "S90", "V60", "V90", "C40",
  // Volkswagen / Mazda
  "Jetta", "Passat", "Tiguan", "Atlas", "Taos", "Golf", "ID.4",
  "CX-90", "CX-50", "CX-30", "CX-5", "Mazda3", "Mazda6", "MX-5",
].sort((a, b) => b.length - a.length);

// Plausible vehicle cash incentive / rebate band. Below this is service-coupon
// noise; above it is an MSRP or total price misread as cash.
const CASH_MIN = 250;
const CASH_MAX = 25_000;

// Text window cut around each payment anchor for multi-offer segmentation.
// 350 chars before captures vehicle name; 650 after captures term + disclaimer.
const WINDOW_BEFORE = 350;
const WINDOW_AFTER = 650;

/** Strip scripts/styles, drop tags, decode the common entities, collapse
 *  whitespace — enough to regex visible offer copy out of a snapshot. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#36;|&dollar;/gi, "$")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseAmount(raw: string): number {
  return Number(raw.replace(/[,$\s]/g, ""));
}

function firstMatch(text: string, re: RegExp): RegExpMatchArray | null {
  return text.match(re);
}

// --- Field extractors ----------------------------------------------------

function extractMonthlyPayment(text: string) {
  // "$279/mo", "$279 per month", "$279 a month", "$279 monthly"
  const m = firstMatch(
    text,
    /\$\s?([\d,]{2,7})\s*(?:\/|per\s+|a\s+)?\s*(?:mo(?:nthly)?\b|month\b)/i
  );
  return m ? { value: parseAmount(m[1]), match: m[0].trim() } : null;
}

function extractApr(text: string) {
  // "2.9% APR", "APR: 1.9%", "0% APR", "0% financing", "0% Annual Percentage Rate"
  const m =
    firstMatch(text, /([\d]+(?:\.\d+)?)\s*%\s*APR\b/i) ??
    firstMatch(text, /\bAPR[:\s]+([\d]+(?:\.\d+)?)\s*%/i) ??
    firstMatch(text, /([\d]+(?:\.\d+)?)\s*%\s*(?:financing|annual percentage rate)\b/i);
  return m ? { value: Number(m[1]), match: m[0].trim() } : null;
}

function extractTerm(text: string) {
  // Plausible lease/finance terms only, to avoid matching "per month".
  const re = /(\d{2,3})\s*[- ]?\s*(?:months?|mos?)\b/gi;
  for (const m of text.matchAll(re)) {
    const months = Number(m[1]);
    if (months >= 12 && months <= 96) {
      return { value: months, match: m[0].trim() };
    }
  }
  return null;
}

function extractDueAtSigning(text: string) {
  const m =
    firstMatch(
      text,
      /\$\s?([\d,]{1,7})\s*(?:due at (?:lease )?signing|total due at signing|due at delivery)/i
    ) ??
    firstMatch(
      text,
      /(?:due at (?:lease )?signing|cash due at signing)[:\s]*\$\s?([\d,]{1,7})/i
    );
  return m ? { value: parseAmount(m[1]), match: m[0].trim() } : null;
}

function extractCashIncentive(text: string) {
  const m =
    firstMatch(
      text,
      /\$\s?([\d,]{2,7})\s*(?:cash back|customer cash|bonus cash|cash allowance|rebate|in (?:total )?savings)/i
    ) ??
    firstMatch(text, /save\s+(?:up to\s+)?\$\s?([\d,]{2,7})/i);
  if (!m) return null;
  const value = parseAmount(m[1]);
  // Reject service-coupon noise and MSRP/price misreads — a real vehicle cash
  // incentive sits in a plausible band (see CASH_MIN/CASH_MAX).
  if (value < CASH_MIN || value > CASH_MAX) return null;
  return { value, match: m[0].trim() };
}

/** Service specials price by the job, not by the month: a flat price
 *  ("$39.95 oil change") or a discount ("$25 off"). Captured separately so a
 *  service page yields an offer even without lease/finance fields. */
function extractServiceAmounts(text: string) {
  const discount = firstMatch(text, /\$\s?([\d,]{1,5}(?:\.\d{2})?)\s*off\b/i);
  const price = firstMatch(text, /\$\s?([\d,]{1,5}\.\d{2})\b/);
  return {
    discount: discount
      ? { value: parseAmount(discount[1]), match: discount[0].trim() }
      : null,
    price: price
      ? { value: parseAmount(price[1]), match: price[0].trim() }
      : null,
  };
}

// Offer-specific fine print. A disclaimer is tied to ONE ad and sits next to
// it (usually just below); these are the phrases that mark that ad fine print.
const AD_DISCLAIMER_KEYWORDS = [
  "with approved credit",
  "on approved credit",
  "well-qualified",
  "qualified lessees",
  "qualified buyers",
  "security deposit",
  "plus tax",
  "plus applicable",
  "plus title",
  "per $1,000 financed",
  "per $1000 financed",
  "acquisition fee",
  "destination charge",
  "lessee responsible",
  "not all buyers will qualify",
  "residency restrictions",
  "see dealer for details",
  "see dealer for complete details",
  "expires",
];

// Site-wide / footer boilerplate. If a candidate contains any of these it is
// NOT an ad disclaimer (it covers the whole website) — reject or truncate.
const SITEWIDE_TERMS_MARKERS = [
  "privacy policy",
  "terms of use",
  "terms of service",
  "terms & conditions",
  "do not sell",
  "all rights reserved",
  "©",
  "copyright",
  "accessibility",
  "sitemap",
  "cookie",
  "consent preferences",
  "your privacy choices",
];

/**
 * The disclaimer for THIS ad — the fine print that sits with the offer, never
 * the page's site-wide legal terms. We look only in the text just after the
 * offer anchor (reading order ≈ "just below the ad" once the DOM is
 * flattened), require offer-specific fine-print wording, and cut the moment
 * site-wide/footer boilerplate begins. No anchor ⇒ no ad to tie to ⇒ null.
 */
function extractDisclaimerNear(
  text: string,
  anchorIndex: number
): string | null {
  if (anchorIndex < 0) return null;
  const WINDOW = 900;
  const window = text.slice(anchorIndex, anchorIndex + WINDOW);
  const lower = window.toLowerCase();

  let kwIndex = -1;
  for (const kw of AD_DISCLAIMER_KEYWORDS) {
    const i = lower.indexOf(kw);
    if (i >= 0 && (kwIndex < 0 || i < kwIndex)) kwIndex = i;
  }
  if (kwIndex < 0) return null;

  // Start at the sentence boundary at/just before the first fine-print phrase.
  const before = window.slice(0, kwIndex);
  const boundary = Math.max(before.lastIndexOf(". "), before.lastIndexOf("! "));
  const start = boundary >= 0 ? boundary + 2 : kwIndex;
  let candidate = window.slice(start);

  // Stop before any site-wide/footer boilerplate creeps in.
  let cut = candidate.length;
  const candLower = candidate.toLowerCase();
  for (const marker of SITEWIDE_TERMS_MARKERS) {
    const i = candLower.indexOf(marker);
    if (i >= 0 && i < cut) cut = i;
  }
  candidate = candidate.slice(0, cut).trim();

  // A stray fragment isn't a disclaimer.
  if (candidate.length < 12) return null;
  return candidate.slice(0, 1000);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}

/** First known model appearing in `scope`, matched longest-first so multi-word
 *  models (e.g. "Grand Cherokee") beat their substrings. Null if none. */
export function findKnownModel(scope: string): string | null {
  for (const model of KNOWN_MODELS) {
    if (new RegExp(`\\b${escapeRe(model)}\\b`, "i").test(scope)) return model;
  }
  return null;
}

/** Make + model for the offer. Prefers the offer-anchor context (the copy
 *  around the price) over page-global text, so we don't grab the make from a
 *  "Toyota Dealership" nav link. Model must be a KNOWN_MODELS entry — a null
 *  model is better than junk pulled from page chrome. */
function extractVehicle(
  text: string,
  hints: ExtractHints,
  anchorContext: string | null
) {
  const brandMake = (hints.brand ?? "").split(/[,/]/)[0].trim();
  const findMake = (scope: string) =>
    KNOWN_MAKES.find((mk) =>
      new RegExp(`\\b${escapeRe(mk)}\\b`, "i").test(scope)
    ) ?? null;

  // Model first — it's the high-signal token. Look near the offer, then page.
  const model =
    (anchorContext ? findKnownModel(anchorContext) : null) ??
    findKnownModel(text);

  // Make: prefer the anchor context, then a make adjacent to the model, then
  // the dealer's brand prior.
  const make =
    (anchorContext ? findMake(anchorContext) : null) ??
    findMake(text) ??
    (brandMake || null);

  if (!make && !model) return { make: null, model: null, trim: null };
  return { make, model, trim: null };
}

// --- Classification ------------------------------------------------------

function classify(
  fields: {
    monthlyPayment: number | null;
    apr: number | null;
    cashIncentive: number | null;
    termMonths: number | null;
    dueAtSigning: number | null;
  },
  hints: ExtractHints
): OfferType {
  if (hints.missionType === "service_specials") return "service";
  // A monthly payment with due-at-signing is the lease fingerprint.
  if (fields.monthlyPayment !== null && fields.dueAtSigning !== null) {
    return "lease";
  }
  if (fields.apr !== null) return "finance";
  if (fields.monthlyPayment !== null && fields.termMonths !== null) {
    return "finance";
  }
  if (fields.cashIncentive !== null) return "cash";
  return "promotional";
}

function contextAround(text: string, anchor: string | null): string | null {
  if (!anchor) return null;
  const idx = text.indexOf(anchor);
  if (idx < 0) return anchor.slice(0, 200);
  const start = Math.max(0, idx - 80);
  return text.slice(start, idx + anchor.length + 120).trim();
}

// --- Single-offer extraction from a text chunk ---------------------------

/** Core extraction pass over an already-stripped text chunk (either a
 *  full-page text for service/fallback, or a per-offer window). Returns null
 *  when the chunk has no priced signal. */
function extractOfferFromText(
  text: string,
  hints: ExtractHints
): ExtractedOffer | null {
  const payment = extractMonthlyPayment(text);
  const apr = extractApr(text);
  const term = extractTerm(text);
  const due = extractDueAtSigning(text);
  const cash = extractCashIncentive(text);

  const isService = hints.missionType === "service_specials";
  const service = isService ? extractServiceAmounts(text) : null;
  const serviceCash = service?.discount?.value ?? null;

  const fields = {
    monthlyPayment: payment?.value ?? null,
    apr: apr?.value ?? null,
    cashIncentive: cash?.value ?? serviceCash,
    termMonths: term?.value ?? null,
    dueAtSigning: due?.value ?? null,
  };

  const signalCount = Object.values(fields).filter((v) => v !== null).length;
  const hasServiceSignal = Boolean(service?.discount || service?.price);
  if (signalCount === 0 && !hasServiceSignal) return null;

  const offerType = classify(fields, hints);

  const anchor =
    payment?.match ??
    cash?.match ??
    apr?.match ??
    service?.price?.match ??
    service?.discount?.match ??
    null;
  const anchorIndex = anchor ? text.indexOf(anchor) : -1;
  const anchorContext =
    anchorIndex >= 0
      ? text.slice(Math.max(0, anchorIndex - 140), anchorIndex + 160)
      : null;
  const vehicle = extractVehicle(text, hints, anchorContext);
  const disclaimer = extractDisclaimerNear(text, anchorIndex);

  const matches: Record<string, string> = {};
  if (payment) matches.monthlyPayment = payment.match;
  if (apr) matches.apr = apr.match;
  if (term) matches.termMonths = term.match;
  if (due) matches.dueAtSigning = due.match;
  if (cash) matches.cashIncentive = cash.match;
  if (service?.discount) matches.serviceDiscount = service.discount.match;
  if (service?.price) matches.servicePrice = service.price.match;

  const confidence = Math.min(
    1,
    0.2 * signalCount +
      (hasServiceSignal ? 0.2 : 0) +
      (vehicle.make ? 0.1 : 0) +
      (disclaimer ? 0.1 : 0)
  );

  return {
    offerType,
    vehicleMake: vehicle.make,
    vehicleModel: vehicle.model,
    vehicleTrim: vehicle.trim,
    monthlyPayment: fields.monthlyPayment,
    apr: fields.apr,
    cashIncentive: fields.cashIncentive,
    termMonths: fields.termMonths,
    dueAtSigning: fields.dueAtSigning,
    disclaimerText: disclaimer,
    rawText: contextAround(text, anchor),
    confidence: Number(confidence.toFixed(2)),
    matches,
  };
}

// --- Multi-offer segmentation -------------------------------------------

/** Find every priced-offer anchor position in page text — monthly payment
 *  signals plus standalone APR signals. Each position becomes the centre of
 *  an independent offer window, so a page with both `$379/mo` and `0% APR`
 *  cards yields separate offers for each. Positions are returned sorted;
 *  the caller's per-window dedup collapses any that map to the same offer. */
function offerAnchorPositions(text: string): number[] {
  const paymentRe = /\$\s?[\d,]{2,7}\s*(?:\/|per\s+|a\s+)?\s*(?:mo(?:nthly)?\b|month\b)/gi;
  const aprRe = /[\d]+(?:\.\d+)?\s*%\s*(?:APR\b|financing\b|annual percentage rate\b)/gi;
  const positions: number[] = [];
  let m: RegExpExecArray | null;
  for (const re of [paymentRe, aprRe]) {
    while ((m = re.exec(text)) !== null) {
      positions.push(m.index);
    }
  }
  return positions.sort((a, b) => a - b);
}

/** Dedup key: two offers with the same fields are the same offer regardless
 *  of which text window they came from (e.g. a sticky header repeats the
 *  current-model payment). Vehicle model is intentionally excluded so a
 *  null-model offer from one window doesn't shadow a model-identified offer
 *  from another window covering the same anchor. */
function offerSig(o: ExtractedOffer): string {
  return [
    o.offerType,
    o.vehicleModel ?? "",
    o.monthlyPayment ?? "",
    o.apr ?? "",
    o.termMonths ?? "",
    o.dueAtSigning ?? "",
    o.cashIncentive ?? "",
  ].join("|");
}

/** Reads HTML, segments offer cards by payment anchor, and returns one
 *  ExtractedOffer per distinct priced ad on the page. Returns an empty array
 *  when no monetary signal is present (hero image, nav page, etc.). */
export function extractOffers(
  html: string,
  hints: ExtractHints
): ExtractedOffer[] {
  const text = htmlToText(html);
  if (!text) return [];

  // Service specials: one URL = one service item; skip windowing.
  if (hints.missionType === "service_specials") {
    const offer = extractOfferFromText(text, hints);
    return offer ? [offer] : [];
  }

  const positions = offerAnchorPositions(text);

  // No priced anchors at all — try full page (cash-only or promo-only pages).
  if (positions.length === 0) {
    const offer = extractOfferFromText(text, hints);
    return offer ? [offer] : [];
  }

  const results: ExtractedOffer[] = [];
  const seen = new Set<string>();

  for (const pos of positions) {
    const chunk = text.slice(
      Math.max(0, pos - WINDOW_BEFORE),
      Math.min(text.length, pos + WINDOW_AFTER)
    );
    const offer = extractOfferFromText(chunk, hints);
    if (!offer) continue;
    const sig = offerSig(offer);
    if (seen.has(sig)) continue;
    seen.add(sig);
    results.push(offer);
  }

  // All windows duped to each other (e.g. a sticky-header repeating one price) —
  // fall back to a single full-page extraction so we don't lose the offer.
  if (results.length === 0) {
    const offer = extractOfferFromText(text, hints);
    return offer ? [offer] : [];
  }

  return results;
}
