import type { MissionType, OfferType } from "@/lib/db";
import { parseMileage } from "@/lib/report";

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
  salePrice: number | null;
  termMonths: number | null;
  dueAtSigning: number | null;
  /** Lease mileage allowance, miles/year. Null for non-lease offers or when
   *  the page didn't state one. */
  mileageAllowance: number | null;
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
    firstMatch(text, /save\s+(?:up to\s+)?\$\s?([\d,]{2,7})/i) ??
    firstMatch(text, /\$\s?([\d,]{2,7})\s*(?:off\b)/i) ??
    firstMatch(text, /([\d,]{2,7})\s*dollars?\s+off\b/i);
  if (!m) return null;
  const value = parseAmount(m[1]);
  // Reject service-coupon noise and MSRP/price misreads — a real vehicle cash
  // incentive sits in a plausible band (see CASH_MIN/CASH_MAX).
  if (value < CASH_MIN || value > CASH_MAX) return null;
  return { value, match: m[0].trim() };
}

// Plausible cash sale price band — avoids zip codes, trim levels, and
// service coupon amounts being misread as a vehicle price.
const SALE_PRICE_MIN = 5_000;
const SALE_PRICE_MAX = 200_000;

function extractSalePrice(text: string) {
  // "$28,999", "priced at $28,999", "sale price $28,999", "now $28,999"
  const m =
    firstMatch(
      text,
      /(?:sale\s+price|priced\s+at|now|internet\s+price|our\s+price)[:\s]*\$\s?([\d,]{4,7})/i
    ) ??
    firstMatch(text, /\$\s?([\d,]{4,7})\s*(?:sale\s+price|internet\s+price)/i);
  if (!m) return null;
  const value = parseAmount(m[1]);
  if (value < SALE_PRICE_MIN || value > SALE_PRICE_MAX) return null;
  return { value, match: m[0].trim() };
}

// Service type keywords in priority order. First match wins.
// Pairs of [search-substring (lowercase), display label].
const SERVICE_TYPE_KEYWORDS: [string, string][] = [
  ["oil change", "Oil Change"],
  ["oil & filter", "Oil & Filter Change"],
  ["oil and filter", "Oil & Filter Change"],
  ["remote start", "Remote Start"],
  ["brake pad", "Brake Pads & Rotors"],
  ["rotor", "Brake Pads & Rotors"],
  ["brake", "Brake Service"],
  ["tire rotation", "Tire Rotation"],
  ["price match", "Price Match"],
  ["cabin air", "Cabin Air Filter"],
  ["engine air", "Engine Air Filter"],
  ["air filter", "Air Filter"],
  ["a/c performance", "A/C Performance Check"],
  ["a/c check", "A/C Check"],
  ["air conditioning", "A/C Service"],
  ["alignment", "Alignment"],
  ["coolant flush", "Coolant Flush"],
  ["coolant", "Coolant Service"],
  ["transmission flush", "Transmission Flush"],
  ["transmission", "Transmission Service"],
  ["battery", "Battery"],
  ["wiper", "Wiper Blades"],
  ["multi-point", "Multi-Point Inspection"],
  ["multipoint", "Multi-Point Inspection"],
  ["inspection", "Inspection"],
  ["loaner", "Complimentary Loaner"],
  ["rental", "Complimentary Rental"],
  ["detail", "Detail"],
  ["flush", "Fluid Flush"],
];

/** Returns a clean human label for a service offer from the text window around
 *  the price anchor. Prefers a recognized keyword label; falls back to the
 *  card's own title text (first meaningful phrase before the price) rather
 *  than a generic "Service Special". */
function buildServiceLabel(chunkText: string): string {
  const lower = chunkText.toLowerCase();
  for (const [kw, label] of SERVICE_TYPE_KEYWORDS) {
    if (lower.includes(kw)) return label;
  }
  // Extract the card title: text immediately before the price anchor.
  // Modal/print-coupon cards prepend a dealer address block; the service name
  // is always the last meaningful phrase before "STARTING AT $price".
  // Strategy: find text after the last phone number (which marks the end of the
  // address block), then strip trailing "STARTING AT".
  const beforePrice = chunkText.split(/\$\s?[\d,]+/)[0].trim();
  if (beforePrice.length > 0) {
    // Find position after the last phone-like sequence (NXX-NXX-XXXX or NXX.NXX.XXXX)
    const phoneRe = /\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g;
    let lastPhoneEnd = -1;
    let pm: RegExpExecArray | null;
    while ((pm = phoneRe.exec(beforePrice)) !== null) {
      lastPhoneEnd = pm.index + pm[0].length;
    }
    const afterPhone = lastPhoneEnd >= 0
      ? beforePrice.slice(lastPhoneEnd)
      : beforePrice;
    const label = afterPhone
      .replace(/[•\-–—|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\s*(starting\s+at|starting|at)\s*$/i, '')
      .replace(/^[\s,;:®™]+/, '')
      .trim()
      .slice(0, 60);
    if (label.length >= 4) return label;
  }
  return "Service Special";
}

/** Captures the service offer value as a human-readable string — no numeric
 *  parsing. Patterns tried in priority order so "25% off tires" beats "$25"
 *  and a percentage isn't rendered with a dollar sign.
 *
 *  Returns null when no monetary or discount signal is found (no priced offer). */
function extractServiceOfferText(text: string): string | null {
  const patterns: [RegExp, number][] = [
    [/\d+\s*%\s*off\b[^.!\n]{0,50}/i, 0],                  // "25% off new tires"
    [/\$\s?[\d,]+(?:\.\d{2})?\s*off\b[^.!\n]{0,40}/i, 0],  // "$25 off cabin air filter"
    [/save\s+(?:up\s+to\s+)?\$[\d,]+(?:\.\d{2})?/i, 0],    // "save $25"
    [/complimentary\b[^.!\n]{0,50}/i, 0],                   // "Complimentary Rental w/Major Maintenance"
    [/free\b[^.!\n]{0,30}/i, 0],                            // "FREE with purchase"
    [/\d+\s*for\s*\d+/i, 0],                                // "2 for 1"
    [/buy\s+\d+[^.!\n]{0,30}/i, 0],                         // "buy 2 get 1 free"
    [/\d+\s*%\s*price match\b[^.!\n]{0,30}/i, 0],           // "120% Price Match on Tire Purchases"
    [/price match\b[^.!\n]{0,30}/i, 0],                     // "Price Match Guarantee"
    [/\$\s?[\d,]{1,5}(?:\.\d{2})?\b/, 0],                   // flat price "$24.95" / "$30"
  ];
  for (const [re] of patterns) {
    const m = text.match(re);
    if (m) return m[0].trim();
  }
  return null;
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
    salePrice: number | null;
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
  if (fields.cashIncentive !== null || fields.salePrice !== null) return "cash";
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
  const salePrice = extractSalePrice(text);

  const isService = hints.missionType === "service_specials";
  // Mileage allowance is a lease-specific supplement, not a classification
  // signal — a stray "X miles per year" shouldn't itself make a chunk look
  // like a priced offer, so it's kept out of `fields`/signalCount below.
  const mileageAllowance = isService ? null : parseMileage(text);
  // Service offer text is captured as a human-readable string (e.g. "$25 off",
  // "25% off tires") — no numeric parse, so a percentage isn't stored as a
  // dollar amount and non-price offers (2-for-1, FREE) round-trip cleanly.
  const serviceOfferText = isService ? extractServiceOfferText(text) : null;

  const fields = {
    monthlyPayment: payment?.value ?? null,
    apr: apr?.value ?? null,
    // Service never populates cashIncentive/salePrice — the offer lives in matches.serviceOffer.
    cashIncentive: isService ? null : (cash?.value ?? null),
    salePrice: isService ? null : (salePrice?.value ?? null),
    termMonths: term?.value ?? null,
    dueAtSigning: due?.value ?? null,
  };

  const signalCount = Object.values(fields).filter((v) => v !== null).length;
  const hasServiceSignal = Boolean(serviceOfferText);
  if (signalCount === 0 && !hasServiceSignal) return null;

  const offerType = classify(fields, hints);

  // For service, use the offer text itself as the anchor so anchorIndex points
  // near the coupon value (used by extractDisclaimerNear).
  const anchor = isService
    ? serviceOfferText
    : (payment?.match ?? salePrice?.match ?? cash?.match ?? apr?.match ?? null);
  const anchorIndex = anchor ? text.indexOf(anchor) : -1;
  const anchorContext =
    anchorIndex >= 0
      ? text.slice(Math.max(0, anchorIndex - 140), anchorIndex + 160)
      : null;
  // Service offers are shop work, not vehicle-specific. Attaching a vehicle
  // model pulled from page chrome (e.g. "Grand Cherokee" in a Featured Vehicles
  // section) produces wrong labels AND breaks dedup (same offer, different model
  // → two rows). Always null for service.
  const vehicle = isService ? { make: null, model: null, trim: null } : extractVehicle(text, hints, anchorContext);
  const disclaimer = extractDisclaimerNear(text, anchorIndex);

  const matches: Record<string, string> = {};
  if (payment) matches.monthlyPayment = payment.match;
  if (apr) matches.apr = apr.match;
  if (term) matches.termMonths = term.match;
  if (due) matches.dueAtSigning = due.match;
  if (!isService && cash) matches.cashIncentive = cash.match;
  if (!isService && salePrice) matches.salePrice = salePrice.match;
  if (serviceOfferText) matches.serviceOffer = serviceOfferText;

  // Service: label = "what's it for" (Oil Change, Brake Service…);
  // offer value lives in matches.serviceOffer ("$25 off", "25% off", "$24.95").
  const rawText = isService
    ? buildServiceLabel(text)
    : contextAround(text, anchor);

  // Service confidence is scored independently from vehicle offers:
  // finding a price/discount is the dominant signal (0.4), a recognized
  // service label (not the generic fallback) adds 0.2. This pushes
  // well-extracted service offers above the AI threshold so they skip AI
  // enrichment — service offers are vehicle-free by design, so the null-model
  // AI trigger must not fire for them.
  const confidence = isService
    ? Math.min(
        1,
        (hasServiceSignal ? 0.4 : 0) +
          (rawText !== "Service Special" ? 0.2 : 0) +
          (disclaimer ? 0.1 : 0)
      )
    : Math.min(
        1,
        0.2 * signalCount +
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
    salePrice: fields.salePrice,
    termMonths: fields.termMonths,
    dueAtSigning: fields.dueAtSigning,
    mileageAllowance,
    disclaimerText: disclaimer,
    rawText,
    confidence: Number(confidence.toFixed(2)),
    matches,
  };
}

// --- Multi-offer segmentation -------------------------------------------

interface ServiceAnchor {
  pos: number;
  /** The matched offer value text (e.g. "$299.95", "$25 off", "10% off anything needed"). */
  text: string;
}

/** Anchors for service-specials pages: flat prices, dollar-off, and
 *  percentage-off phrases. Returns matched text alongside position so we can
 *  inject the exact anchor value into the offer rather than re-searching the
 *  window and risking picking up a different price that happens to appear
 *  earlier in the surrounding text. */
function serviceAnchors(text: string): ServiceAnchor[] {
  const priceRe = /\$\s?[\d,]{1,5}\.\d{2}\b/gi;
  const discountRe = /\$\s?[\d,]{1,5}(?:\.\d{2})?\s*off\b/gi;
  const percentRe = /\d+\s*%\s*off\b[^.!\n]{0,60}/gi;
  const results: ServiceAnchor[] = [];
  let m: RegExpExecArray | null;
  for (const re of [priceRe, discountRe, percentRe]) {
    while ((m = re.exec(text)) !== null) {
      results.push({ pos: m.index, text: m[0].trim() });
    }
  }
  return results.sort((a, b) => a.pos - b.pos);
}

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
 *  from another window covering the same anchor. For service offers the label
 *  (rawText) is included so two different services with the same discount
 *  (e.g. both "10% off") are not collapsed into one row. */
function offerSig(o: ExtractedOffer): string {
  return [
    o.offerType,
    o.vehicleModel ?? "",
    o.monthlyPayment ?? "",
    o.apr ?? "",
    o.termMonths ?? "",
    o.dueAtSigning ?? "",
    o.cashIncentive ?? "",
    o.salePrice ?? "",
    o.mileageAllowance ?? "",
    o.matches.serviceOffer ?? "",
    o.offerType === "service" ? (o.rawText ?? "") : "",
  ].join("|");
}

/** Splits raw HTML into per-card text chunks using DOM block structure.
 *  Tracks nesting depth to find the level where sibling block elements repeat —
 *  that is the offer-card layer on service-specials pages. Returns one text
 *  string per card, or empty array when no repeating card structure is found. */
function splitHtmlIntoCards(html: string): string[] {
  const BLOCK = new Set(['div', 'section', 'article', 'li', 'figure', 'aside']);

  interface Frame { tag: string; start: number; depth: number; }
  const stack: Frame[] = [];
  const blocks: Array<{ depth: number; text: string }> = [];

  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
  let m: RegExpExecArray | null;

  while ((m = tagRe.exec(html)) !== null) {
    if (m[0].slice(-2) === '/>') continue; // self-closing
    const isClose = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (!BLOCK.has(tag)) continue;

    if (!isClose) {
      stack.push({ tag, start: m.index, depth: stack.length });
    } else {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === tag) {
          const { start, depth } = stack[i];
          const end = m.index + m[0].length;
          const text = htmlToText(html.slice(start, end)).trim();
          // Card-sized: long enough to be a full offer, short enough to be one card
          if (text.length >= 60 && text.length <= 4000) {
            blocks.push({ depth, text });
          }
          stack.splice(i);
          break;
        }
      }
    }
  }

  if (blocks.length === 0) return [];

  // A "rich card" has both a price/discount signal AND a recognizable service
  // keyword. Pure price sub-divs (e.g. a <div> containing only "$699.95") have
  // no service keyword and are excluded — preventing a "Regularly $699.95"
  // element from being counted as a second Remote Start offer.
  const hasOfferSignal = (t: string) =>
    /\$[\d,]+|\d+\s*%\s*off\b|free\b|complimentary\b|price match\b/i.test(t);
  const hasServiceKeyword = (t: string) =>
    SERVICE_TYPE_KEYWORDS.some(([kw]) => t.toLowerCase().includes(kw));
  const isRichCard = (t: string) => hasOfferSignal(t) && hasServiceKeyword(t);

  // Use rich-card blocks (price + service keyword) to identify which DOM depth
  // is the offer-card layer — that depth has the most sibling rich cards.
  // Once we know the right depth, return ALL priced blocks at that depth, not
  // just the keyword-matched ones. This captures offers like "BG Drive Line
  // Service" or "BG Fuel/Air Induction" whose text has no recognized service
  // keyword but is clearly a priced offer at the same card depth.
  const richByDepth = new Map<number, number>();
  for (const { depth, text } of blocks) {
    if (!isRichCard(text)) continue;
    richByDepth.set(depth, (richByDepth.get(depth) ?? 0) + 1);
  }

  let bestDepth = -1;
  let bestCount = 0;
  for (const [depth, count] of richByDepth) {
    if (count > bestCount) { bestCount = count; bestDepth = depth; }
  }

  // Need at least 2 rich cards at the winning depth to be confident.
  if (bestDepth < 0 || bestCount < 2) return [];

  // Return all priced blocks (not just keyword-matched) at the card depth.
  return blocks
    .filter(b => b.depth === bestDepth && hasOfferSignal(b.text))
    .map(b => b.text);
}

/** Detects combo ad chunks — a single OCR or text window that contains both
 *  an APR offer and a monthly-payment offer. Image-based ad cards commonly
 *  present two alternatives side-by-side (APR column / lease column) with no
 *  "OR" text between them, so no separator is required. Whenever both fields
 *  appear together the chunk is split into a pure-finance offer (APR only) and
 *  a payment offer (lease if due-at-signing is present, otherwise finance).
 *  Returns the original single offer when only one pricing field is present. */
function splitComboOffer(offer: ExtractedOffer): ExtractedOffer[] {
  if (offer.monthlyPayment === null || offer.apr === null) return [offer];

  const financeOffer: ExtractedOffer = {
    ...offer,
    offerType: "finance",
    monthlyPayment: null,
    dueAtSigning: null,
    mileageAllowance: null,
    matches: Object.fromEntries(
      Object.entries(offer.matches).filter(([k]) => k !== "monthlyPayment" && k !== "dueAtSigning")
    ),
  };

  const paymentOffer: ExtractedOffer = {
    ...offer,
    offerType: offer.dueAtSigning !== null ? "lease" : "finance",
    apr: null,
    matches: Object.fromEntries(
      Object.entries(offer.matches).filter(([k]) => k !== "apr")
    ),
  };

  return [financeOffer, paymentOffer];
}

/** Reads HTML, segments offer cards, and returns one ExtractedOffer per
 *  distinct priced ad on the page. Returns empty array when no signal found. */
export function extractOffers(
  html: string,
  hints: ExtractHints
): ExtractedOffer[] {
  // Service specials: split by DOM card boundaries first — true card isolation
  // with no character windowing. Each offer card in the HTML grid is a sibling
  // block element; splitHtmlIntoCards finds that layer automatically.
  if (hints.missionType === "service_specials") {
    const cards = splitHtmlIntoCards(html);
    if (cards.length > 0) {
      const results: ExtractedOffer[] = [];
      const seen = new Set<string>();
      for (const cardText of cards) {
        const offer = extractOfferFromText(cardText, hints);
        if (!offer) continue;
        const sig = offerSig(offer);
        if (seen.has(sig)) continue;
        seen.add(sig);
        results.push(offer);
      }
      if (results.length > 0) return results;
    }
    // Card structure not detected — fall back to anchor-based windowing.
  }

  const text = htmlToText(html);
  if (!text) return [];

  // Service specials fallback: window around price / discount anchors.
  if (hints.missionType === "service_specials") {
    const anchors = serviceAnchors(text);
    // No service-specific price/discount anchors → page has no service specials.
    // Do NOT fall back to full-page extraction; that picks up vehicle prices,
    // nav links, or other page chrome unrelated to service offers.
    if (anchors.length === 0) return [];
    const results: ExtractedOffer[] = [];
    const seen = new Set<string>();
    for (const anchor of anchors) {
      const chunk = text.slice(
        Math.max(0, anchor.pos - WINDOW_BEFORE),
        Math.min(text.length, anchor.pos + WINDOW_AFTER)
      );
      const offer = extractOfferFromText(chunk, hints);
      if (!offer) continue;
      offer.matches.serviceOffer = anchor.text;
      const sig = offerSig(offer);
      if (seen.has(sig)) continue;
      seen.add(sig);
      results.push(offer);
    }
    return results;
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
    for (const split of splitComboOffer(offer)) {
      const sig = offerSig(split);
      if (seen.has(sig)) continue;
      seen.add(sig);
      results.push(split);
    }
  }

  // All windows duped to each other (e.g. a sticky-header repeating one price) —
  // fall back to a single full-page extraction so we don't lose the offer.
  if (results.length === 0) {
    const offer = extractOfferFromText(text, hints);
    if (!offer) return [];
    const fallbackSeen = new Set<string>();
    return splitComboOffer(offer).filter((s) => {
      const sig = offerSig(s);
      if (fallbackSeen.has(sig)) return false;
      fallbackSeen.add(sig);
      return true;
    });
  }

  return results;
}
