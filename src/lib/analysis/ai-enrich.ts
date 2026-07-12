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
 * text. See src/lib/analysis/ocr-mistral.ts.
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
- offerType: "lease" (a monthly payment the ad calls a lease — the word "lease" by the payment, or a due-at-signing figure, or an annual mileage allowance; due-at-signing is often only in the fine print, so its absence does NOT make it finance), "finance" (APR, or a monthly payment + term with no lease markers), "cash" (rebate/cash incentive OR a raw sale/cash price), "service" (service-department special), or "promotional" (no priced terms).
- Vehicle make/model/trim must be the real advertised vehicle for THIS offer. Use null when not stated — never guess a model from page navigation or headers. The rule-based guess's vehicleModel may already be resolved from an OCR'd ad image (image-only platforms bake the vehicle name into the image rather than the DOM) — trust it unless the page text clearly contradicts it.
- Money as plain numbers (no $ or commas). Term in whole months. APR as a percent number.
- cashIncentive: a discount/rebate dollar amount (e.g. "$1,000 cash back", "$500 off"). salePrice: the raw advertised sale or cash price of the vehicle (e.g. "Sale Price $28,999"). Use null when not present.
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
      return response.parsed_output ?? null;
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
