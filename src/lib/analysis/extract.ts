import type { MissionType, OfferType } from "@/lib/db";
import { parseMileage, deriveAnnualMileage } from "@/lib/report";

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

// Text window cut around each payment anchor for multi-offer segmentation.
// 350 chars before captures vehicle name; after must cover term + the full
// disclaimer reach (extractDisclaimerNear's DISCLAIMER_WINDOW) — a shorter
// value here silently truncates disclaimers before that function ever sees
// them, producing false "no disclaimer" reads on offers with long fine print.
const WINDOW_BEFORE = 350;
const WINDOW_AFTER = 900;

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

/** Given the index just AFTER a `<div …>` open tag, returns the index just
 *  after its matching `</div>`, tracking nested divs. Returns -1 when the close
 *  can't be found (malformed/truncated HTML) so the caller leaves the node in
 *  place rather than deleting to end-of-document. */
function matchingDivEnd(html: string, from: number): number {
  const tagRe = /<(\/?)div\b[^>]*>/gi;
  tagRe.lastIndex = from;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    if (m[0].slice(-2) === "/>") continue; // self-closing
    if (m[1] === "/") {
      if (--depth === 0) return m.index + m[0].length;
    } else {
      depth++;
    }
  }
  return -1;
}

/**
 * Strips a Dealer Teamwork (MPOP) inventory dump out of raw HTML before ANY
 * text extraction. Dealer Teamwork's MPOP widget embeds on dealer sites (DDC
 * and others) and renders the dealer's ENTIRE new-car inventory as per-VIN
 * "New Car Special" cards — each a `.ncs-container` carrying a `data-vin` and a
 * `$X/mo` estimate. On a specials page that is 20–80+ cards; left in place, the
 * offer windower explodes every one into a separate junk "offer" (Colonial
 * Subaru produced ~80). These are auto-generated payment estimates, not
 * advertised specials, so none should ever become an offer row.
 *
 * Keyed on the vendor product markup (`ncs-container` + `data-vin`), which is
 * identical across every Dealer Teamwork client regardless of brand or CMS —
 * verified on both a DDC Subaru site and a non-DDC Honda site. Deliberately NOT
 * keyed on any dealer- or platform-specific token (account slug, `ddc-site`,
 * brand), so it generalizes rather than special-casing one dealer.
 *
 * Only the dump cards are removed; genuine curated offers elsewhere on the page,
 * and DT-free pages (a homepage with no `.ncs-container[data-vin]` cards), are
 * untouched.
 */
export function stripDealerTeamworkDump(html: string): string {
  // Fast path: the MPOP "New Car Special" card class isn't present at all.
  if (!/\bncs-container\b/i.test(html)) return html;

  // Opening <div> whose class list includes `ncs-container`. Quote style and
  // class ordering vary, so match either quote and any surrounding tokens.
  const openRe =
    /<div\b[^>]*\bclass\s*=\s*("|')[^"'>]*\bncs-container\b[^"'>]*\1[^>]*>/gi;
  let out = "";
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(html)) !== null) {
    // The per-VIN `data-vin` on the card element is the inventory-dump tell —
    // it's what turns one card into one "$X/mo" offer. Requiring it (not the
    // class alone) keeps the strip surgical.
    if (!/\bdata-vin\s*=/i.test(m[0])) continue;
    if (m.index < cursor) continue; // inside an already-removed card
    const end = matchingDivEnd(html, openRe.lastIndex);
    if (end < 0) continue; // unbalanced — leave this card rather than over-cut
    out += html.slice(cursor, m.index);
    cursor = end;
    openRe.lastIndex = end;
  }
  out += html.slice(cursor);
  return out;
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

// Plausible cash sale price band — avoids zip codes, trim levels, and
// service coupon amounts being misread as a vehicle price.
const SALE_PRICE_MIN = 5_000;
const SALE_PRICE_MAX = 200_000;

function extractSalePrice(text: string) {
  // "priced at $28,999", "sale price $28,999", "buy this car for $28,999"
  const m =
    firstMatch(
      text,
      /(?:sale\s+price|cash\s+price|priced\s+at|now|internet\s+price|our\s+price)[:\s]*\$\s?([\d,]{4,7})/i
    ) ??
    firstMatch(text, /\$\s?([\d,]{4,7})\s*(?:sale\s+price|cash\s+price|internet\s+price)/i) ??
    firstMatch(text, /\b(?:buy|purchase)\b[^$]{0,80}\bfor\s+\$\s?([\d,]{4,7})/i);
  if (!m) return null;
  const value = parseAmount(m[1]);
  if (value < SALE_PRICE_MIN || value > SALE_PRICE_MAX) return null;
  return { value, match: m[0].trim() };
}

// Template placeholder / abstract offers that dealer CMS themes ship as filler.
// DDC's "Wild Card" coupon is a generic "up to $X off anything" slot, not a
// real advertised service — it must never become an offer row.
const PLACEHOLDER_OFFER_MARKERS = ["wild card", "wildcard"];

/** True when the card text is a CMS placeholder rather than a real offer. */
function isPlaceholderServiceOffer(text: string): boolean {
  const lower = text.toLowerCase();
  return PLACEHOLDER_OFFER_MARKERS.some((mk) => lower.includes(mk));
}

interface ServiceTypePattern {
  pattern: RegExp;
  label: string;
}

// Recognizable service types in priority order. These are deliberately bounded
// patterns instead of substring checks: generic words such as "service" and
// "detail" are page chrome/fine-print vocabulary as often as they are coupon
// titles. A concrete service name is required before a priced block can become
// an offer row.
const SERVICE_TYPE_PATTERNS: ServiceTypePattern[] = [
  {
    pattern: /\boil\s+change\b[^$]{0,80}\btire\s+rotation\b|\btire\s+rotation\b[^$]{0,80}\boil\s+change\b/i,
    label: "Oil Change & Tire Rotation",
  },
  { pattern: /\boil\s*(?:&|and)\s*filter\b/i, label: "Oil & Filter Change" },
  { pattern: /\boil\s+change\b/i, label: "Oil Change" },
  { pattern: /\bremote\s+start(?:er)?\b/i, label: "Remote Start" },
  { pattern: /\bin[ -]?cabin\s+microfilter\b|\bcabin\s+microfilter\b|\bmicrofilter\b/i, label: "Cabin Microfilter" },
  { pattern: /\bcabin\s+air\s+filter\b/i, label: "Cabin Air Filter" },
  { pattern: /\bengine\s+air\s+filter\b/i, label: "Engine Air Filter" },
  { pattern: /\bair\s+filter\b/i, label: "Air Filter" },
  { pattern: /\bbrake\s+pad(?:s)?\b|\bbrake\s+rotor(?:s)?\b|\brotor(?:s)?\b/i, label: "Brake Pads & Rotors" },
  { pattern: /\bbrake(?:s|\s+service)?\b/i, label: "Brake Service" },
  { pattern: /\btire\s+rotation\b/i, label: "Tire Rotation" },
  { pattern: /\bwheel\s+alignment\b|\balignment\b/i, label: "Alignment" },
  { pattern: /\bcoolant\s+flush\b/i, label: "Coolant Flush" },
  { pattern: /\bcoolant\b|\bcooling\s+system\b/i, label: "Coolant Service" },
  { pattern: /\btransmission\s+flush\b/i, label: "Transmission Flush" },
  { pattern: /\btransmission\b|\bdrive\s*line\b|\bdriveline\b/i, label: "Transmission / Driveline Service" },
  { pattern: /\bfuel(?:\s*\/\s*air)?\s+induction\b|\bfuel\s+system\b/i, label: "Fuel System Service" },
  { pattern: /\bpower\s+steering\b/i, label: "Power Steering Service" },
  { pattern: /\bdifferential\b/i, label: "Differential Service" },
  { pattern: /\bspark\s+plug(?:s)?\b/i, label: "Spark Plugs" },
  { pattern: /\b(?:battery|batteries)\b/i, label: "Battery" },
  { pattern: /\bwiper(?:\s+blade)?s?\b/i, label: "Wiper Blades" },
  { pattern: /\bmulti[ -]?point\s+inspection\b/i, label: "Multi-Point Inspection" },
  { pattern: /\bstate\s+inspection\b|\bsafety\s+inspection\b/i, label: "Inspection" },
  { pattern: /\bfactory[- ](?:required|scheduled)\s+(?:service|maintenance)\b/i, label: "Factory-Scheduled Maintenance" },
  { pattern: /\baccessor(?:y|ies)\b[^.]{0,40}\binstall(?:ation|ed)?\b/i, label: "Accessory Installation" },
  {
    pattern: /\b(?:full|complete|express|interior|exterior|vehicle|auto|car|premium|deluxe|platinum)\s+(?:vehicle\s+)?detail(?:ing)?\b|\bdetail(?:ing)?\s+(?:service|package)\b/i,
    label: "Vehicle Detailing",
  },
];

const MAX_SERVICE_LABEL_DISTANCE = 180;

function buildServiceLabel(
  chunkText: string,
  offerAnchor?: string | null
): string | null {
  const anchorStart = offerAnchor ? chunkText.indexOf(offerAnchor) : -1;
  const anchorEnd = anchorStart >= 0 ? anchorStart + offerAnchor!.length : -1;
  let best: { distance: number; priority: number; label: string } | null = null;

  for (const [priority, { pattern, label }] of SERVICE_TYPE_PATTERNS.entries()) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    const matcher = new RegExp(pattern.source, flags);
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(chunkText)) !== null) {
      if (anchorStart < 0) return label;
      const matchEnd = match.index + match[0].length;
      const distance =
        matchEnd < anchorStart
          ? anchorStart - matchEnd
          : match.index > anchorEnd
            ? match.index - anchorEnd
            : 0;
      if (
        distance <= MAX_SERVICE_LABEL_DISTANCE &&
        (!best || distance < best.distance || (distance === best.distance && priority < best.priority))
      ) {
        best = { distance, priority, label };
      }
    }
  }
  return best?.label ?? null;
}

/** A concrete, recognizable service appears somewhere in the text. Used to
 * gate the fallback anchor path so a discount in page chrome, an address block,
 * or legal boilerplate is never promoted to an offer. */
function hasServiceContext(text: string): boolean {
  return buildServiceLabel(text) !== null;
}

/** Collapses whitespace and title-normalizes a captured benefit string. */
function normalizeOfferValue(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// A service coupon only counts as a real offer if it represents real money.
// Percentage discounts below this are noise ("10% off because you have a
// pulse") — a quality bar, tune here. 20%+ stays; 10%/15% are dropped.
const SERVICE_MIN_PERCENT = 20;

/** Captures the SERVICE OFFER VALUE — but only when it's a real offer.
 *
 *  The bar (operator's rule): a service coupon counts only if it carries real
 *  money — a concrete dollar figure, a percentage discount of at least
 *  SERVICE_MIN_PERCENT, or a quantity bundle ("buy 3 get 1 free", "3 for 1").
 *  Deliberately EXCLUDED as non-offers (return null so no row is produced):
 *    - sub-threshold percentages (10%, 15%),
 *    - standalone free / complimentary services ("free brake inspection"),
 *    - price-match guarantees ("120% price match").
 *
 *  The "what" (Oil Change, Brake Service…) is the label, produced separately by
 *  buildServiceLabel(). This returns just the benefit, normalized.
 *
 *  Returns null when the text has no qualifying offer. */
function extractServiceOfferText(text: string): string | null {
  // Quantity bundle — real savings. Checked first so "buy 3 get 1 free" isn't
  // mistaken for a standalone freebie (which would be dropped).
  let m = text.match(
    /buy\s+\d+\s+(?:get|and)\s+\d*\s*(?:free|half\s+off|\d+\s*%\s*off|\$[\d,]+\s*off)/i
  );
  if (m) return normalizeOfferValue(m[0]);
  m = text.match(/\b\d+\s+for\s+\$?\d+\b/i); // "3 for 1", "4 for $99"
  if (m) return normalizeOfferValue(m[0]);

  // Percentage discount — only SERVICE_MIN_PERCENT and up. A smaller one is NOT
  // returned here; keep scanning for a dollar figure before giving up (a coupon
  // could pair "10% off" with a real "$30 off").
  const pct = text.match(/(\d+)\s*%\s*off\b/i);
  if (pct && Number(pct[1]) >= SERVICE_MIN_PERCENT) return normalizeOfferValue(pct[0]);

  // Dollar discount.
  m = text.match(/\$\s?[\d,]+(?:\.\d{2})?\s*off\b/i);
  if (m) return normalizeOfferValue(m[0]);
  m = text.match(/save\s+(?:up\s+to\s+)?\$[\d,]+(?:\.\d{2})?/i);
  if (m) return normalizeOfferValue(m[0]);

  // Flat coupon price — decimal cents only ("$24.95", "$299.95"), which is how
  // service coupons are priced. Bare integers ("$399") stay excluded: that is
  // doc-fee / MSRP / tax-figure noise that must never be read as an offer.
  m = text.match(/\$\s?[\d,]{1,5}\.\d{2}\b/);
  if (m) return normalizeOfferValue(m[0]);

  // Everything else — sub-20% percentages, free/complimentary, price-match — is
  // a nice-to-have, not a quality offer.
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

// Vehicle-pricing / legal footer boilerplate that dealer CMS themes render in
// the same Bootstrap grid (container-fluid > row > col-sm) as service-special
// cards. That shared depth lets a footer block ride into the service-card layer
// (see splitHtmlIntoCards), and its per-state doc-fee list carries cents-bearing
// figures (e.g. "Illinois $377.63") that slip past the decimal-cents filter meant
// to reject bare-integer doc fees. None of these phrases ever appears on a real
// service coupon, so their presence disqualifies the block outright.
const DISCLAIMER_BOILERPLATE_MARKERS = [
  "reasonable effort has been made",
  "absolute accuracy cannot be guaranteed",
  "subject to prior sale",
  "doc fee",
  "documentary fee",
  "factory rebate",
  "suggested retail price",
];

/** True when the block is site-wide legal / vehicle-pricing footer boilerplate
 *  rather than an advertised service coupon. Trips on either the disclaimer
 *  markers above or the site-wide terms markers (copyright, privacy, ©, …). */
function isDisclaimerBoilerplate(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    DISCLAIMER_BOILERPLATE_MARKERS.some((mk) => lower.includes(mk)) ||
    SITEWIDE_TERMS_MARKERS.some((mk) => lower.includes(mk))
  );
}

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
  // Must not exceed WINDOW_AFTER — the caller's per-offer chunk only has that
  // many chars past the anchor in the first place, so a larger value here
  // would just silently truncate at the chunk boundary instead of raising an
  // out-of-bounds error, hiding a future drift between the two constants.
  const window = text.slice(anchorIndex, anchorIndex + WINDOW_AFTER);
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

/** True when "lease" appears right next to the monthly-payment anchor. A
 *  payment described as a lease IS a lease even when the "$X due at signing"
 *  figure lives only in the disclaimer fine print (or is omitted from the ad) —
 *  which is how most dealers write lease ads. Scoped tightly to the payment so a
 *  stray "lease" elsewhere on the page can't reclassify a finance offer. */
function hasLeaseKeywordNear(text: string, paymentMatch: string | null): boolean {
  if (!paymentMatch) return false;
  const idx = text.indexOf(paymentMatch);
  if (idx < 0) return false;
  const window = text.slice(
    Math.max(0, idx - 160),
    idx + paymentMatch.length + 160
  );
  return /\blease/i.test(window);
}

function classify(
  fields: {
    monthlyPayment: number | null;
    apr: number | null;
    cashIncentive: number | null;
    salePrice: number | null;
    termMonths: number | null;
    dueAtSigning: number | null;
  },
  hints: ExtractHints,
  // A monthly-payment offer that carries a lease marker — the literal word
  // "lease" beside the payment, or an annual mileage allowance (finance deals
  // never cap mileage). Lets us catch leases that don't spell out due-at-signing.
  leaseSignal: boolean
): OfferType {
  if (hints.missionType === "service_specials") return "service";
  // A monthly payment is a lease when it carries due-at-signing OR any other
  // lease marker. Without this, leases that keep due-at-signing in the fine
  // print fall through to finance (payment+term) or promotional (payment only).
  if (
    fields.monthlyPayment !== null &&
    (fields.dueAtSigning !== null || leaseSignal)
  ) {
    return "lease";
  }
  if (fields.apr !== null) return "finance";
  if (fields.monthlyPayment !== null && fields.termMonths !== null) {
    return "finance";
  }
  // "Cash" means an advertised purchase price, not manufacturer/customer-cash
  // money. Rebates are alternative incentives and must not create a report row.
  if (fields.salePrice !== null) return "cash";
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

/** Provenance prior on a vehicle offer's rule-based confidence: WHERE an offer
 *  was found predicts how likely it is to be a real, correctly-parsed advertised
 *  offer, independent of how many fields parsed. A dedicated finance/specials
 *  page states full terms (baseline trust, 1.0); homepage tiles and promo
 *  banners are teasers that routinely carry partial or gloss offers, so they are
 *  discounted. Penalize-only by design — the factor is never > 1, so provenance
 *  can lower a weak-source score but can never inflate a thin or wrong one into
 *  a confident offer (see extraction hard rules: a fabricated/noisy offer is
 *  worse than a missing one). Service confidence is computed separately and is
 *  not routed through here. */
function missionProvenanceFactor(mission: MissionType): number {
  switch (mission) {
    case "finance_offers":
      return 1;
    case "service_specials":
      return 1;
    case "homepage_offers":
      return 0.85;
    case "promotional_banners":
      return 0.8;
    default:
      return 1;
  }
}

/** Core extraction pass over an already-stripped text chunk (either a
 *  full-page text for service/fallback, or a per-offer window). Returns null
 *  when the chunk has no priced signal. */
function extractOfferFromText(
  text: string,
  hints: ExtractHints,
  serviceAnchorText?: string
): ExtractedOffer | null {
  const payment = extractMonthlyPayment(text);
  const apr = extractApr(text);
  const term = extractTerm(text);
  const due = extractDueAtSigning(text);
  const salePrice = extractSalePrice(text);

  const isService = hints.missionType === "service_specials";
  // Mileage allowance is a lease-specific supplement, not a classification
  // signal — a stray "X miles per year" shouldn't itself make a chunk look
  // like a priced offer, so it's kept out of `fields`/signalCount below.
  // Explicit "X per year" first; then, as a fallback, derive the annual cap
  // from a whole-term total ("36 months, 22,500 miles" → 7,500/yr). The
  // derivation only divides figures above 15k/yr, so a bare annual like
  // "10k miles" is never touched — see deriveAnnualMileage.
  const mileageAllowance = isService
    ? null
    : parseMileage(text) ?? deriveAnnualMileage(text, term?.value ?? null);
  // Service offer text is captured as a human-readable string (e.g. "$25 Off",
  // "25% Off", "Complimentary") — no numeric parse, so a percentage isn't
  // stored as a dollar amount and free/complimentary offers round-trip cleanly.
  const serviceOfferText = isService
    ? (serviceAnchorText ?? extractServiceOfferText(text))
    : null;

  // A service coupon is shop work with a discount — NEVER a lease/finance/cash
  // vehicle offer. Payment, APR, term, due-at-signing, cash, and sale price are
  // vehicle-offer fields; forcing them null on service stops a stray "12 month
  // warranty" becoming a lease term or a warranty dollar figure becoming cash.
  const fields = {
    monthlyPayment: isService ? null : (payment?.value ?? null),
    apr: isService ? null : (apr?.value ?? null),
    // Service never populates cashIncentive/salePrice — the offer lives in matches.serviceOffer.
    // Customer/bonus cash is not a standalone advertised purchase price and is
    // not part of a lease or APR offer. Keep this legacy field empty for newly
    // extracted offers; a cash offer is represented by salePrice.
    cashIncentive: null,
    salePrice: isService ? null : (salePrice?.value ?? null),
    termMonths: isService ? null : (term?.value ?? null),
    dueAtSigning: isService ? null : (due?.value ?? null),
  };

  const signalCount = Object.values(fields).filter((v) => v !== null).length;
  const hasServiceSignal = Boolean(serviceOfferText);
  if (signalCount === 0 && !hasServiceSignal) return null;

  // Drop CMS placeholder coupons ("Wild Card up to $X off anything") — they are
  // filler slots, not advertised services. Only applies to the service path.
  if (isService && isPlaceholderServiceOffer(text)) return null;

  // Footer/legal boilerplate that shares the service-card DOM depth must never
  // become a coupon — its doc-fee figures aren't real service prices.
  if (isService && isDisclaimerBoilerplate(text)) return null;

  // A monetary value by itself does not tell us what is being offered. Require
  // a concrete service type; this rejects address/phone blocks, generic
  // "Service" cards, bare "Detail", and descriptive prose while canonicalizing
  // known work such as an in-cabin microfilter replacement.
  const serviceLabel = isService
    ? buildServiceLabel(text, serviceOfferText)
    : null;
  if (isService && !serviceLabel) return null;

  // A payment offer is a lease when the ad calls it one or caps annual mileage —
  // both are lease-only markers, so classify treats them like an explicit
  // due-at-signing figure.
  const leaseSignal =
    !isService &&
    fields.monthlyPayment !== null &&
    (mileageAllowance !== null || hasLeaseKeywordNear(text, payment?.match ?? null));

  const offerType = classify(fields, hints, leaseSignal);

  // For service, use the offer text itself as the anchor so anchorIndex points
  // near the coupon value (used by extractDisclaimerNear).
  const anchor = isService
    ? serviceOfferText
    : (payment?.match ?? salePrice?.match ?? apr?.match ?? null);
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
  // Disclaimers are ad fine print for priced VEHICLE offers. Service coupons
  // don't carry ad-specific disclaimers we report on (hard rule: no disclaimer
  // text on service ads), so never attach one.
  const disclaimer = isService ? null : extractDisclaimerNear(text, anchorIndex);

  const matches: Record<string, string> = {};
  // Vehicle-offer field matches — omitted entirely on service so the drill-down
  // JSON can't imply a lease term / APR the offer doesn't have.
  if (!isService && payment) matches.monthlyPayment = payment.match;
  if (!isService && apr) matches.apr = apr.match;
  if (!isService && term) matches.termMonths = term.match;
  if (!isService && due) matches.dueAtSigning = due.match;
  if (!isService && salePrice) matches.salePrice = salePrice.match;
  if (serviceOfferText) matches.serviceOffer = serviceOfferText;

  // Service: label = "what's it for" (Oil Change, Brake Service…);
  // offer value lives in matches.serviceOffer ("$25 Off", "25% Off", "Complimentary").
  const rawText = isService
    ? serviceLabel
    : contextAround(text, anchor);

  // Service confidence: a clean monetary signal plus a required, recognized
  // service label earns 0.8. A well-extracted service offer therefore clears
  // the AI threshold (0.5) and
  // skips the vehicle-oriented AI pass, which has no business rewriting it.
  //
  // Vehicle confidence: completeness (how many fields parsed) TIMES a provenance
  // prior (how trustworthy the source page is). A homepage tile is a teaser —
  // the same field count means less there than on a dedicated finance/specials
  // page where the real advertised terms live. The prior only ever discounts a
  // weak source, never inflates a strong one, so it cannot launder a thin or
  // wrong extraction into a confident offer (hard rule: trustworthy > complete).
  // A priced vehicle offer (lease/finance/cash) whose model we couldn't pin down
  // is inherently less trustworthy — the ad names a vehicle we failed to
  // identify, so it must never read as fully confident no matter how many other
  // fields parsed (hard rule: trustworthy > complete). Penalize-only, like the
  // provenance prior. Finance offers with no model are dropped outright
  // downstream; this keeps a make-only lease/cash offer from posing as certain.
  const PRICED_VEHICLE_TYPES: OfferType[] = ["lease", "finance", "cash"];
  const missingModelPenalty =
    !isService && PRICED_VEHICLE_TYPES.includes(offerType) && !vehicle.model
      ? 0.75
      : 1;
  const confidence = isService
    ? (hasServiceSignal && serviceLabel ? 0.8 : 0)
    : Math.min(
        1,
        (0.2 * signalCount +
          // An explicit advertised purchase price is itself the complete core
          // term of a cash-purchase offer, so score it more strongly than one
          // supplemental lease/finance field.
          (fields.salePrice !== null ? 0.3 : 0) +
          (vehicle.make ? 0.1 : 0) +
          (disclaimer ? 0.1 : 0)) *
          missionProvenanceFactor(hints.missionType) *
          missingModelPenalty
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

/** Anchors for service-specials pages: dollar-off and percentage-off phrases ONLY.
 *  Flat prices ($X.XX) are excluded because they match too much noise:
 *  doc fees ($399, $499), state-specific charges, tax info, MSRP, etc.
 *  Service offers MUST have explicit discount/off language.
 *  Returns matched text alongside position so we can inject the exact anchor
 *  value into the offer rather than re-searching the window and risking
 *  picking up a different value that happens to appear earlier. */
function serviceAnchors(text: string): ServiceAnchor[] {
  // Match the discount phrase ONLY — no trailing description. The anchor text
  // becomes the offer value, so it must be clean ("$10 Off"), never
  // "15% off CLAIM OFFER SCHEDULE SERVICE". Only keeper discounts anchor here:
  // dollar-off (any) and percentage-off at/above the quality threshold. A
  // sub-threshold "10% off" isn't an offer, so it doesn't seed a window.
  const discountRe = /\$\s?[\d,]{1,5}(?:\.\d{2})?\s*off\b/gi;
  const percentRe = /(\d+)\s*%\s*off\b/gi;
  const results: ServiceAnchor[] = [];
  let m: RegExpExecArray | null;
  while ((m = discountRe.exec(text)) !== null) {
    results.push({ pos: m.index, text: normalizeOfferValue(m[0]) });
  }
  while ((m = percentRe.exec(text)) !== null) {
    if (Number(m[1]) >= SERVICE_MIN_PERCENT) {
      results.push({ pos: m.index, text: normalizeOfferValue(m[0]) });
    }
  }
  return results.sort((a, b) => a.pos - b.pos);
}

/** A service coupon rendered as an image (DDC/Dealer.com). `data-image-url`
 *  marks the coupon graphic — vehicle thumbnails and logos don't carry it — so
 *  it cleanly selects the coupons to OCR. `alt` is the paired accessibility
 *  text used as a cross-check on the OCR read. */
export interface ServiceCouponImage {
  alt: string | null;
  imageUrl: string;
}

/** Finds coupon images on a service-specials page. Selects `<img>` tags with a
 *  `data-image-url` (the Dealer.com coupon-graphic marker) and pairs each with
 *  its `alt`. The image is what customers see (OCR reads it, primary); alt is
 *  the cross-check. Deduped by URL. */
export function findServiceCouponImages(html: string): ServiceCouponImage[] {
  const out: ServiceCouponImage[] = [];
  const seen = new Set<string>();
  const imgRe = /<img\b[^>]*>/gi;
  let tag: RegExpExecArray | null;
  while ((tag = imgRe.exec(html)) !== null) {
    const t = tag[0];
    const urlM = t.match(/\bdata-image-url=(?:"([^"]*)"|'([^']*)')/i);
    if (!urlM) continue;
    let url = (urlM[1] ?? urlM[2] ?? "").trim();
    if (!url) continue;
    if (url.startsWith("//")) url = "https:" + url;
    if (!/^https?:/i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const altM = t.match(/\balt=(?:"([^"]*)"|'([^']*)')/i);
    const alt = altM ? htmlToText(altM[1] ?? altM[2] ?? "") : "";
    out.push({ alt: alt.length >= 3 ? alt : null, imageUrl: url });
  }
  return out;
}

/** Normalizes a service offer value to a comparable token so OCR and alt reads
 *  can be checked for agreement. Dollar amounts compare on whole dollars
 *  ("$599.95" ≈ "$599"); percentages on the number; free/complimentary collapse. */
function normalizeValueForMatch(v: string | undefined): string {
  if (!v) return "";
  const s = v.toLowerCase();
  const pct = s.match(/(\d+)\s*%/);
  if (pct) return `pct:${pct[1]}`;
  if (/complimentary|free/.test(s)) return "free";
  const dol = s.match(/\$\s?([\d,]+)/);
  if (dol) return `usd:${dol[1].replace(/,/g, "")}`;
  if (/price\s*match/.test(s)) return "pricematch";
  return s.replace(/\s+/g, " ").trim();
}

/** Two reads describe the same offer when their normalized values agree. */
function fuzzyOfferMatch(a: ExtractedOffer, b: ExtractedOffer): boolean {
  const va = normalizeValueForMatch(a.matches.serviceOffer);
  const vb = normalizeValueForMatch(b.matches.serviceOffer);
  return va !== "" && va === vb;
}

/** Reconciles the OCR read of a coupon image (primary — it's the live graphic
 *  customers see) against its alt text (cross-check — accessibility metadata
 *  that can drift). Sets confidence and a `verify` marker consumed by the UI:
 *   - corroborated: OCR + alt agree            → 0.85, trusted
 *   - mismatch:     they disagree              → 0.50, keep OCR, flag for a look
 *   - ocr_only:     OCR read it, no usable alt → 0.60
 *   - alt_only:     OCR blank, alt had it      → 0.50, weakest (stale-prone)
 *  Returns null when neither read yields an offer. */
export function reconcileServiceCoupon(
  ocrText: string | null,
  altText: string | null,
  hints: ExtractHints
): ExtractedOffer | null {
  const ocrOffer = ocrText && ocrText.trim() ? extractOfferFromText(ocrText, hints) : null;
  const altOffer = altText && altText.trim() ? extractOfferFromText(altText, hints) : null;
  if (!ocrOffer && !altOffer) return null;

  if (ocrOffer && altOffer) {
    if (fuzzyOfferMatch(ocrOffer, altOffer)) {
      ocrOffer.confidence = 0.85;
      ocrOffer.matches.verify = "corroborated";
      return ocrOffer;
    }
    ocrOffer.confidence = 0.5;
    ocrOffer.matches.verify = "mismatch";
    ocrOffer.matches.ocrValue = ocrOffer.matches.serviceOffer ?? "";
    ocrOffer.matches.altValue = altOffer.matches.serviceOffer ?? "";
    return ocrOffer;
  }
  if (ocrOffer) {
    ocrOffer.confidence = 0.6;
    ocrOffer.matches.verify = "ocr_only";
    return ocrOffer;
  }
  altOffer!.confidence = 0.5;
  altOffer!.matches.verify = "alt_only";
  return altOffer!;
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
 *  current-model payment). Vehicle model IS part of the key: a Rogue and a
 *  Murano that happen to share payment/APR/term must stay separate rows, so
 *  collapsing on model would be wrong. (Consequence: the same real-world offer
 *  extracted twice with a model resolved in one window and null in the other
 *  survives as two rows — that near-duplicate is pruned later by the publish
 *  confidence floor, not here.) For service offers the label (rawText) is
 *  included so two different services with the same discount (e.g. both
 *  "10% off") are not collapsed into one row. */
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

interface HtmlBlock {
  depth: number;
  text: string;
}

/** Collects the visible text of bounded DOM blocks while preserving nesting
 * depth. The later selectors use repeated blocks at one depth as the card
 * layer, keeping offer fields inside their real HTML container. */
function collectHtmlBlocks(html: string): HtmlBlock[] {
  const BLOCK = new Set(['div', 'section', 'article', 'li', 'figure', 'aside']);

  interface Frame { tag: string; start: number; depth: number; }
  const stack: Frame[] = [];
  const blocks: HtmlBlock[] = [];

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

  return blocks;
}

/** Splits raw HTML into per-card text chunks using DOM block structure.
 *  Tracks nesting depth to find the level where sibling block elements repeat —
 *  that is the offer-card layer on service-specials pages. Returns one text
 *  string per card, or empty array when no repeating card structure is found. */
function splitHtmlIntoCards(html: string): string[] {
  const blocks = collectHtmlBlocks(html);
  if (blocks.length === 0) return [];

  // A "rich card" has both a price/discount signal AND a recognizable service
  // keyword. Pure price sub-divs (e.g. a <div> containing only "$699.95") have
  // no service keyword and are excluded — preventing a "Regularly $699.95"
  // element from being counted as a second Remote Start offer.
  const hasOfferSignal = (t: string) =>
    /\$[\d,]+|\d+\s*%\s*off\b|free\b|complimentary\b|price match\b/i.test(t);
  const isRichCard = (t: string) => hasOfferSignal(t) && hasServiceContext(t);

  // Use rich-card blocks (price + service keyword) to identify which DOM depth
  // is the offer-card layer — that depth has the most sibling rich cards.
  // Once we know the right depth, return all priced blocks at that depth. The
  // shared extraction gate still requires a concrete service type from each
  // individual block, so nested address or generic text blocks are discarded.
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

/** Finds repeated vehicle-offer cards before page text is flattened. A vehicle
 * card must name a known model and carry a payment, APR, or advertised purchase
 * price. The shortest repeated level wins ties, which selects the innermost
 * complete card instead of a row/container that holds multiple cards. */
function splitHtmlIntoVehicleCards(html: string): string[] {
  const blocks = collectHtmlBlocks(html);
  if (blocks.length === 0) return [];

  const hasVehicleOfferSignal = (text: string) =>
    /\$\s?[\d,]{2,7}\s*(?:\/|per\s+|a\s+)?\s*(?:mo(?:nthly)?\b|month\b)/i.test(text) ||
    /[\d]+(?:\.\d+)?\s*%\s*(?:APR\b|financing\b|annual percentage rate\b)/i.test(text) ||
    extractSalePrice(text) !== null;
  const isVehicleCard = (text: string) =>
    findKnownModel(text) !== null && hasVehicleOfferSignal(text);

  const byDepth = new Map<number, string[]>();
  for (const { depth, text } of blocks) {
    if (!isVehicleCard(text)) continue;
    const values = byDepth.get(depth) ?? [];
    if (!values.includes(text)) values.push(text);
    byDepth.set(depth, values);
  }

  let best: string[] = [];
  let bestAverageLength = Number.POSITIVE_INFINITY;
  for (const values of byDepth.values()) {
    if (values.length < 2) continue;
    const averageLength = values.reduce((sum, text) => sum + text.length, 0) / values.length;
    if (
      values.length > best.length ||
      (values.length === best.length && averageLength < bestAverageLength)
    ) {
      best = values;
      bestAverageLength = averageLength;
    }
  }

  return best;
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
    // Keep the lease call the combo chunk already earned (due-at-signing, a
    // lease keyword, or a mileage allowance); only a bare payment is finance.
    offerType:
      offer.offerType === "lease" || offer.dueAtSigning !== null
        ? "lease"
        : "finance",
    apr: null,
    matches: Object.fromEntries(
      Object.entries(offer.matches).filter(([k]) => k !== "apr")
    ),
  };

  return [financeOffer, paymentOffer];
}

function extractTermAfterAnchor(text: string, anchor: string): { value: number; match: string } | null {
  const re = new RegExp(
    `${escapeRe(anchor)}\\s+(?:financing\\s+)?for\\s+(\\d{2,3})\\s*[- ]?\\s*(?:months?|mos?)\\b`,
    "i"
  );
  const match = text.match(re);
  if (!match) return null;
  const value = Number(match[1]);
  if (value < 12 || value > 96) return null;
  const termMatch = match[0].match(/\d{2,3}\s*[- ]?\s*(?:months?|mos?)\b/i);
  return { value, match: termMatch?.[0] ?? `${value} months` };
}

/** One repeated DOM card is one vehicle promotion. It may advertise two real
 * alternatives (lease payment and APR), so split those alternatives once and
 * resolve each term against its own anchor. Customer-cash copy is deliberately
 * ignored; it is neither an advertised purchase price nor part of either row. */
function extractVehicleOffersFromCard(
  text: string,
  hints: ExtractHints
): ExtractedOffer[] {
  const offer = extractOfferFromText(text, hints);
  if (!offer) return [];

  const results = splitComboOffer(offer);
  const payment = extractMonthlyPayment(text);
  const apr = extractApr(text);

  for (const result of results) {
    const anchoredTerm =
      result.monthlyPayment !== null && payment
        ? extractTermAfterAnchor(text, payment.match)
        : result.apr !== null && apr
          ? extractTermAfterAnchor(text, apr.match)
          : null;
    if (anchoredTerm) {
      result.termMonths = anchoredTerm.value;
      result.matches.termMonths = anchoredTerm.match;
    }
    if (result.apr !== null && apr) {
      result.rawText = contextAround(text, apr.match);
    }
  }

  return results;
}

/** Captured disclaimer modals are already one bounded promotion, even though
 * they arrive as plain text rather than repeated HTML cards. Treat the whole
 * disclosure as a single card so lease and APR alternatives inherit the term
 * adjacent to their own anchor instead of borrowing a neighboring term from a
 * generic sliding text window. */
export function extractOffersFromDisclosure(
  text: string,
  hints: ExtractHints
): ExtractedOffer[] {
  return extractVehicleOffersFromCard(htmlToText(text), hints);
}

/** One downloaded ad image is also a bounded promotion. Parse its OCR as one
 * card so side-by-side APR and lease alternatives keep the term nearest their
 * own value instead of borrowing the other alternative's term. */
export function extractOffersFromOcrImage(
  text: string,
  hints: ExtractHints
): ExtractedOffer[] {
  return extractVehicleOffersFromCard(htmlToText(text), hints);
}

/** Extracts vehicle offers from one already-bounded text scope. On structured
 * pages the scope is one DOM card; only the fallback path receives full-page
 * text. Keeping this helper card-local prevents neighboring models and terms
 * from being stitched into the same offer. */
function extractVehicleOffersFromText(
  text: string,
  hints: ExtractHints
): ExtractedOffer[] {
  if (!text) return [];

  const positions = offerAnchorPositions(text);

  // No payment/APR anchors — try once for an advertised purchase price.
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

  if (results.length > 0) return results;

  const offer = extractOfferFromText(text, hints);
  if (!offer) return [];
  const fallbackSeen = new Set<string>();
  return splitComboOffer(offer).filter((split) => {
    const sig = offerSig(split);
    if (fallbackSeen.has(sig)) return false;
    fallbackSeen.add(sig);
    return true;
  });
}

/** Reads HTML, segments offer cards, and returns one ExtractedOffer per
 *  distinct priced ad on the page. Returns empty array when no signal found. */
export function extractOffers(
  html: string,
  hints: ExtractHints
): ExtractedOffer[] {
  // Drop any Dealer Teamwork (MPOP) inventory dump before ANY text extraction —
  // its per-VIN cards would otherwise explode into dozens of junk offers. No-op
  // on non-DT input (raw text, OCR reads) since the card markup won't match.
  const cleanHtml = stripDealerTeamworkDump(html);

  // Service specials — DOM/text extraction only. This is the trusted path:
  //   1. DOM offer cards            — Dealer Inspire grids, DOM-text specials
  //   2. discount-anchor windowing  — last-resort fallback for loose text
  // Image coupons (DDC/Dealer.com), which have no DOM text, are handled
  // separately by the runner: it OCRs each coupon graphic and reconciles it
  // against the alt via reconcileServiceCoupon(). So when this returns empty for
  // a service page, the runner falls through to that OCR pass.
  if (hints.missionType === "service_specials") {
    const results: ExtractedOffer[] = [];
    const seen = new Set<string>();
    const push = (offer: ExtractedOffer | null) => {
      if (!offer) return;
      const sig = offerSig(offer);
      if (seen.has(sig)) return;
      seen.add(sig);
      results.push(offer);
    };

    // 1. DOM offer cards — visible, maintained ad copy.
    for (const cardText of splitHtmlIntoCards(cleanHtml)) {
      push(extractOfferFromText(cardText, hints));
    }

    // 2. Fallback: only when cards found nothing. Window around each discount
    //    anchor, requiring a recognized service nearby so a stray "$10 off" or
    //    legal figure can't hallucinate a coupon.
    if (results.length === 0) {
      const svcText = htmlToText(cleanHtml);
      for (const anchor of serviceAnchors(svcText)) {
        const chunk = svcText.slice(
          Math.max(0, anchor.pos - WINDOW_BEFORE),
          Math.min(svcText.length, anchor.pos + WINDOW_AFTER)
        );
        if (!hasServiceContext(chunk)) continue;
        const offer = extractOfferFromText(chunk, hints, anchor.text);
        if (!offer) continue;
        offer.matches.serviceOffer = anchor.text;
        push(offer);
      }
    }

    return results;
  }

  const results: ExtractedOffer[] = [];
  const seen = new Set<string>();
  const push = (offer: ExtractedOffer) => {
    const sig = offerSig(offer);
    if (seen.has(sig)) return;
    seen.add(sig);
    results.push(offer);
  };

  // Structured vehicle-special pages: extract each repeated DOM card in
  // isolation. Balise/DealerOn cards, for example, keep the complete offer in a
  // card__coupon/card__body block even though the whole page contains siblings.
  const cards = splitHtmlIntoVehicleCards(cleanHtml);
  if (cards.length > 0) {
    for (const cardText of cards) {
      for (const offer of extractVehicleOffersFromCard(cardText, hints)) push(offer);
    }
    return results;
  }

  // Loose-text/image OCR fallback when the source has no repeated DOM cards.
  return extractVehicleOffersFromText(htmlToText(cleanHtml), hints);
}
