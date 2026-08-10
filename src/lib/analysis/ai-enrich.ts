import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { offerTypeEnum, type OfferType } from "@/lib/db";
import type { ExtractedOffer } from "./extract";

/**
 * Phase 12 — AI-assisted analysis. A SECONDARY pass that improves the
 * rule-based extractor on the hard cases it routes over (the shakeout's
 * multi-offer-per-page vehicle mis-picks, low-confidence classifications,
 * disclaimers the HTML pass missed). Rule-based analysis still handles the
 * routine majority; the offer confidence score is the routing seam (AD: AI is
 * secondary, not the default path).
 *
 * Text-only judgment call — this module never sees an image. When the
 * rule-based guess is missing a vehicle model and a screenshot exists,
 * runner.ts resolves the model deterministically first (Mistral OCR +
 * extract.ts's findKnownModel()) and passes the result in as `ocrModelHint`.
 * The zero-DOM-text "image pass" (image-only platforms like DDC/Dealer.com)
 * also no longer routes through this module — runner.ts OCRs the screenshot
 * with Mistral and runs the same deterministic extractOffers() used for DOM
 * text. See src/lib/analysis/ocr.ts.
 *
 * Gated like the compliance grader: with no ANTHROPIC_API_KEY it's a no-op, so
 * the platform builds and runs unchanged. Drop a key in `.env` to activate.
 * Carries the operator's hard disclaimer rule into the prompt (a disclaimer is
 * tied to a SPECIFIC ad, never the site-wide footer legalese).
 */

/** What the AI pass can correct on a single offer. */
export interface OfferEnrichment {
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
  mileageAllowance: number | null;
  disclaimerText: string | null;
  /** The model's own 0..1 confidence in this corrected offer. */
  confidence: number;
}

export interface EnrichInput {
  /** Flattened visible text of the page the offer was extracted from. */
  pageText: string;
  /** Dealer brand prior (e.g. "Toyota"). */
  brand: string | null;
  /** The rule-based offer being second-guessed. */
  current: ExtractedOffer;
  /** Vehicle model already resolved deterministically from an ad screenshot
   *  (Mistral OCR + findKnownModel()) when the rule-based pass found none —
   *  DDC and similar image-only platforms bake the model name into the ad
   *  graphic rather than the DOM. Null when there was no screenshot, OCR
   *  failed, or no known model was found in the OCR'd text. */
  ocrModelHint: string | null;
}

export interface OfferEnricher {
  /** Returns a corrected offer, or null if the pass is disabled or failed
   *  (caller keeps the rule-based offer). */
  enrich(input: EnrichInput): Promise<OfferEnrichment | null>;
}

/** Default when no API key is configured: AI is off, rule-based stands. */
export class NoopOfferEnricher implements OfferEnricher {
  async enrich(): Promise<OfferEnrichment | null> { return null; }
}

const EnrichmentSchema = z.object({
  offerType: z.enum(
    offerTypeEnum.enumValues as [OfferType, ...OfferType[]]
  ),
  vehicleMake: z.string().nullable(),
  vehicleModel: z.string().nullable(),
  vehicleTrim: z.string().nullable(),
  monthlyPayment: z.number().nullable(),
  apr: z.number().nullable(),
  cashIncentive: z.number().nullable(),
  salePrice: z.number().nullable(),
  termMonths: z.number().int().nullable(),
  dueAtSigning: z.number().nullable(),
  mileageAllowance: z.number().int().nullable(),
  disclaimerText: z.string().nullable(),
  confidence: z.number(),
});

const SYSTEM_PROMPT = `You extract a single automotive dealer ADVERTISED OFFER from the visible text of a dealership web page. A rule-based extractor has already produced a first guess; correct it.

Rules:
- Identify the ONE offer the rule-based guess is anchored on (matched by its monthly payment / price), not every offer on the page. Multi-offer pages are why this is hard — keep the vehicle, payment, term, APR, cash, and due-at-signing consistent with that single ad.
- offerType: "lease" (a monthly payment the ad calls a lease — the word "lease" by the payment, or a due-at-signing figure, or an annual mileage allowance; due-at-signing is often only in the fine print, so its absence does NOT make it finance), "finance" (APR, or a monthly payment + term with no lease markers), "cash" (an explicitly advertised purchase/sale price), "service" (service-department special), or "promotional" (no priced terms). Customer cash, bonus cash, rebates, and discounts are NOT cash offers.
- Vehicle make/model/trim must be the real advertised vehicle for THIS offer. Use null when not stated — never guess a model from page navigation or headers. The rule-based guess's vehicleModel may already be resolved from an OCR'd ad image (image-only platforms bake the vehicle name into the image rather than the DOM) — trust it unless the page text clearly contradicts it.
- Money as plain numbers (no $ or commas). Term in whole months. APR as a percent number.
- cashIncentive: always null. Customer cash, bonus cash, rebates, and discounts must not be attached to lease/finance offers or emitted as standalone offers. salePrice: the explicitly advertised purchase price of the vehicle (e.g. "Sale Price $28,999" or "Buy this car for $28,999"). Use null when not present.
- mileageAllowance: for lease offers, the annual mileage allowance in miles/year (e.g. "10,000 miles per year" → 10000). Use null when not a lease or not stated.
- DISCLAIMER (hard rule): the disclaimer is the fine print tied to THIS specific ad (it sits with the offer, e.g. "MSRP $X. Lease for $Y/mo, $Z due at signing..."). It is NEVER the site-wide footer legalese (Terms of Use, Privacy, ©, "do not sell"). Use null if no ad-specific disclaimer is present.
- confidence: your 0..1 confidence in this corrected offer.`;

/** Calls Claude with structured output to re-extract a low-confidence offer. */
export class ClaudeOfferEnricher implements OfferEnricher {
  private client = new Anthropic();
  private model = process.env.ANALYSIS_AI_MODEL ?? "claude-opus-4-8";
  /** Page text is capped so a single hard case can't blow up cost/latency. */
  private maxPageChars = Number(process.env.ANALYSIS_AI_MAX_PAGE_CHARS ?? 8000);

  async enrich(input: EnrichInput): Promise<OfferEnrichment | null> {
    const pageText = input.pageText.slice(0, this.maxPageChars);
    const resolvedVehicleModel = input.current.vehicleModel ?? input.ocrModelHint;
    const current = {
      offerType: input.current.offerType,
      vehicle: [
        input.current.vehicleMake,
        resolvedVehicleModel,
        input.current.vehicleTrim,
      ]
        .filter(Boolean)
        .join(" "),
      monthlyPayment: input.current.monthlyPayment,
      apr: input.current.apr,
      cashIncentive: input.current.cashIncentive,
      salePrice: input.current.salePrice,
      termMonths: input.current.termMonths,
      dueAtSigning: input.current.dueAtSigning,
      mileageAllowance: input.current.mileageAllowance,
      anchorText: input.current.rawText,
    };

    const textContent =
      `Dealer brand: ${input.brand ?? "unknown"}\n\n` +
      `Rule-based guess:\n${JSON.stringify(current)}\n\n` +
      `Page text:\n${pageText}`;

    try {
      const response = await this.client.messages.parse({
        model: this.model,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: textContent }],
        output_config: { format: zodOutputFormat(EnrichmentSchema) },
      });
      const parsed = response.parsed_output;
      if (!parsed) return null;
      // Enforce product taxonomy even if the model follows older automotive
      // conventions: incentives never become or decorate a cash offer.
      return {
        ...parsed,
        offerType:
          parsed.offerType === "cash" && parsed.salePrice === null
            ? "promotional"
            : parsed.offerType,
        cashIncentive: null,
      };
    } catch (err) {
      console.error("AI offer enrichment failed:", err);
      return null;
    }
  }
}

/** Returns the Claude enricher when a key is configured, else the no-op. The
 *  real model only runs when the operator opts in (AD: AI is secondary). */
export function getOfferEnricher(): OfferEnricher {
  return process.env.ANTHROPIC_API_KEY
    ? new ClaudeOfferEnricher()
    : new NoopOfferEnricher();
}

/** Below this rule-based confidence an offer is routed to the AI pass. */
export function aiConfidenceThreshold(): number {
  return Number(process.env.ANALYSIS_AI_CONFIDENCE_THRESHOLD ?? 0.5);
}

// --- AI verifier (confirm/drop) ------------------------------------------
//
// A DIFFERENT job from the enricher. The enricher CORRECTS fields on offers it
// thinks are salvageable. The verifier JUDGES whether a borderline offer is real
// at all, and returns a calibrated confidence — it never rewrites fields. It's
// aimed at the "decision band" straddling the publish floor (the rows the cutoff
// actually turns on), which the enricher's <0.5-or-null-model gate skips. Used
// on demand: the operator runs it over a run's band offers, and the verdict
// replaces the shaky completeness proxy with a judgment on exactly those rows.

/** The verifier's ruling on one offer. Confirm/drop only — no field edits. */
export interface OfferVerdict {
  /** True if this is a genuinely advertised offer, correctly extracted. */
  real: boolean;
  /** Calibrated P(this is a correct, real advertised offer), 0..1. */
  calibratedConfidence: number;
  /** One-line justification, surfaced to the operator. */
  reason: string;
}

export interface VerifyInput {
  /** Full visible text of the page the offer came from. */
  pageText: string;
  brand: string | null;
  /** The stored offer being judged (fields as persisted). */
  offer: {
    offerType: OfferType;
    vehicle: string | null;
    monthlyPayment: number | null;
    apr: number | null;
    cashIncentive: number | null;
    salePrice: number | null;
    termMonths: number | null;
    dueAtSigning: number | null;
    disclaimerText: string | null;
    rawText: string | null;
  };
}

export interface OfferVerifier {
  /** Returns a verdict, or null if the pass is disabled or errored (caller
   *  leaves the offer untouched). */
  verify(input: VerifyInput): Promise<OfferVerdict | null>;
}

export class NoopOfferVerifier implements OfferVerifier {
  async verify(): Promise<OfferVerdict | null> { return null; }
}

const VerdictSchema = z.object({
  real: z.boolean(),
  calibratedConfidence: z.number(),
  reason: z.string(),
});

const VERIFY_SYSTEM_PROMPT = `You AUDIT a single automotive dealer offer that a rule-based extractor pulled from a dealership web page. Your job is to JUDGE, not to rewrite: decide whether this is a REAL advertised offer, correctly extracted as it appears on the page.

Return:
- real: true if the offer is genuinely advertised on this page AND the extracted fields are consistent with what the page says; false otherwise.
- calibratedConfidence: your probability (0..1) that this is a correct, real advertised offer. Be honestly calibrated — 0.9 means you'd expect 9 of 10 like this to be correct. Reserve >0.85 for clear-cut cases and <0.3 for clear rejects.
- reason: one short line an operator can read.

Mark real=false when the "offer" is actually:
- Footer / legal / disclaimer boilerplate mistaken for an offer (per-state doc-fee lists, "reasonable effort has been made", terms of use).
- A per-VIN inventory auto-estimate — a generic "$X/mo" tied to a specific stock number from an inventory widget, not a curated advertised special.
- Numbers stitched from unrelated parts of the page (a payment from one ad, a model from site navigation).
- Not an actual advertised offer at all (no real terms).

A PARTIAL extraction is still real if what was extracted is correct — a missing cash amount or term does not make a genuine ad fake. Judge only what you were given against the page text; do not invent or change any field value.`;

export class ClaudeOfferVerifier implements OfferVerifier {
  private client = new Anthropic();
  private model = process.env.ANALYSIS_AI_MODEL ?? "claude-opus-4-8";
  private maxPageChars = Number(process.env.ANALYSIS_AI_MAX_PAGE_CHARS ?? 8000);

  async verify(input: VerifyInput): Promise<OfferVerdict | null> {
    const pageText = input.pageText.slice(0, this.maxPageChars);
    const textContent =
      `Dealer brand: ${input.brand ?? "unknown"}\n\n` +
      `Extracted offer:\n${JSON.stringify(input.offer)}\n\n` +
      `Page text:\n${pageText}`;

    try {
      const response = await this.client.messages.parse({
        model: this.model,
        max_tokens: 512,
        system: VERIFY_SYSTEM_PROMPT,
        messages: [{ role: "user", content: textContent }],
        output_config: { format: zodOutputFormat(VerdictSchema) },
      });
      return response.parsed_output ?? null;
    } catch (err) {
      console.error("AI offer verification failed:", err);
      return null;
    }
  }
}

/** Claude verifier when a key is configured, else the no-op. */
export function getOfferVerifier(): OfferVerifier {
  return process.env.ANTHROPIC_API_KEY
    ? new ClaudeOfferVerifier()
    : new NoopOfferVerifier();
}

// --- Service-coupon verifier (confirm/drop) ------------------------------
//
// The service-shaped sibling of ClaudeOfferVerifier, and for the same reason:
// judge a borderline row rather than rewrite it. It exists because an image
// coupon whose OCR read disagrees with its alt text scores 0.50 (`mismatch`),
// under the publish floor, and neither routing condition in runner.ts reaches
// it — the null-model condition is deliberately guarded off for service (a
// service offer's model is always null by construction) and the enricher's
// prompt is entirely lease/finance/vehicle, so it would rewrite a coupon into
// a vehicle offer. This verifier only ever answers "is the kept OCR read the
// offer this coupon advertises?" and returns the same OfferVerdict.

export interface CouponVerifyInput {
  brand: string | null;
  /** Service label the extractor gave the coupon ("Brake Service"). */
  label: string | null;
  /** The offer value read off the graphic — the one the stored offer keeps. */
  ocrValue: string;
  /** The same coupon's alt-text value, which disagreed. */
  altValue: string;
  /** The full reads those two values came from, for context. */
  ocrText: string | null;
  altText: string | null;
}

export interface CouponVerifier {
  /** Returns a verdict on the OCR read, or null if the pass is disabled or
   *  errored (caller leaves the coupon's rule-based 0.50 alone). */
  verify(input: CouponVerifyInput): Promise<OfferVerdict | null>;
}

export class NoopCouponVerifier implements CouponVerifier {
  async verify(): Promise<OfferVerdict | null> { return null; }
}

const COUPON_VERIFY_SYSTEM_PROMPT = `You AUDIT one automotive dealer SERVICE COUPON that was read two ways that disagree. The coupon is a graphic: OCR of that graphic produced one offer value, and the image's alt text produced a different one. The stored offer keeps the OCR read, because the graphic is what a customer actually sees, while alt text is accessibility metadata that goes stale or gets copied from another coupon.

JUDGE the OCR read. Do not rewrite it, do not propose a third value, and do not merge the two readings.

Return:
- real: true if the OCR read is the offer this coupon actually advertises; false if the coupon's own text does not support it — the value was misread from the graphic, stitched together from two coupons sharing one image, or is some other number on the graphic (a price, a phone number, an expiry) while the alt text carries the real offer.
- calibratedConfidence: your probability (0..1) that the OCR read is correct. Be honestly calibrated — 0.9 means you'd expect 9 of 10 like this to be correct. Reserve >0.85 for clear-cut cases and <0.3 for clear rejects.
- reason: one short line an operator can read, saying which read you trusted and why.

Disagreement alone does not make the OCR read wrong: a generic or stale alt text ("Service Special", last month's price) against a coherent OCR read is a CONFIRM.`;

/** How much of each read is sent — a coupon graphic's text is short, and the
 *  cap keeps one bad OCR blob from blowing up cost. */
const COUPON_TEXT_CHARS = 2000;

export class ClaudeCouponVerifier implements CouponVerifier {
  private client = new Anthropic();
  private model = process.env.ANALYSIS_AI_MODEL ?? "claude-opus-4-8";

  async verify(input: CouponVerifyInput): Promise<OfferVerdict | null> {
    const textContent =
      `Dealer brand: ${input.brand ?? "unknown"}\n` +
      `Service: ${input.label ?? "unknown"}\n\n` +
      `OCR read (kept): ${input.ocrValue}\n` +
      `Alt-text read (disagrees): ${input.altValue}\n\n` +
      `Full OCR text of the coupon graphic:\n${(input.ocrText ?? "").slice(0, COUPON_TEXT_CHARS)}\n\n` +
      `Full alt text:\n${(input.altText ?? "").slice(0, COUPON_TEXT_CHARS)}`;

    try {
      const response = await this.client.messages.parse({
        model: this.model,
        max_tokens: 512,
        system: COUPON_VERIFY_SYSTEM_PROMPT,
        messages: [{ role: "user", content: textContent }],
        output_config: { format: zodOutputFormat(VerdictSchema) },
      });
      return response.parsed_output ?? null;
    } catch (err) {
      console.error("AI coupon verification failed:", err);
      return null;
    }
  }
}

/** Claude coupon verifier when a key is configured, else the no-op. */
export function getCouponVerifier(): CouponVerifier {
  return process.env.ANTHROPIC_API_KEY
    ? new ClaudeCouponVerifier()
    : new NoopCouponVerifier();
}

/** The decision band [lo, hi) the on-demand verifier operates on — offers whose
 *  rule-based confidence straddles the publish floor. Offers below `lo` are left
 *  as dropped (no rescue) and offers at/above `hi` are left as trusted. */
export function verifyBand(): [number, number] {
  const lo = Number(process.env.ANALYSIS_VERIFY_BAND_LO ?? 0.45);
  const hi = Number(process.env.ANALYSIS_VERIFY_BAND_HI ?? 0.65);
  return [lo, hi];
}
