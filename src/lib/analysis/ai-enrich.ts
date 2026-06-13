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
  termMonths: number | null;
  dueAtSigning: number | null;
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
}

export interface OfferEnricher {
  /** Returns a corrected offer, or null if the pass is disabled or failed
   *  (caller keeps the rule-based offer). */
  enrich(input: EnrichInput): Promise<OfferEnrichment | null>;
}

/** Default when no API key is configured: AI is off, rule-based stands. */
export class NoopOfferEnricher implements OfferEnricher {
  async enrich(): Promise<OfferEnrichment | null> {
    return null;
  }
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
  termMonths: z.number().int().nullable(),
  dueAtSigning: z.number().nullable(),
  disclaimerText: z.string().nullable(),
  confidence: z.number(),
});

const SYSTEM_PROMPT = `You extract a single automotive dealer ADVERTISED OFFER from the visible text of a dealership web page. A rule-based extractor has already produced a first guess; correct it.

Rules:
- Identify the ONE offer the rule-based guess is anchored on (matched by its monthly payment / price), not every offer on the page. Multi-offer pages are why this is hard — keep the vehicle, payment, term, APR, cash, and due-at-signing consistent with that single ad.
- offerType: "lease" (monthly payment + due at signing), "finance" (APR or payment+term), "cash" (rebate/cash incentive), "service" (service-department special), or "promotional" (no priced terms).
- Vehicle make/model/trim must be the real advertised vehicle for THIS offer. Use null when not stated — never guess a model from page navigation or headers.
- Money as plain numbers (no $ or commas). Term in whole months. APR as a percent number.
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
    const current = {
      offerType: input.current.offerType,
      vehicle: [
        input.current.vehicleMake,
        input.current.vehicleModel,
        input.current.vehicleTrim,
      ]
        .filter(Boolean)
        .join(" "),
      monthlyPayment: input.current.monthlyPayment,
      apr: input.current.apr,
      cashIncentive: input.current.cashIncentive,
      termMonths: input.current.termMonths,
      dueAtSigning: input.current.dueAtSigning,
      anchorText: input.current.rawText,
    };

    try {
      const response = await this.client.messages.parse({
        model: this.model,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content:
              `Dealer brand: ${input.brand ?? "unknown"}\n\n` +
              `Rule-based guess (low confidence):\n${JSON.stringify(current)}\n\n` +
              `Page text:\n${pageText}`,
          },
        ],
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
