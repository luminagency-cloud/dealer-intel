import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import sharp from "sharp";
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
  /** Ad screenshot bytes (PNG). Provided when the vehicle model is absent from
   *  text — DDC and similar image-only platforms bake the model name into the
   *  ad graphic rather than the DOM, so the rule-based pass can't read it. */
  screenshotBuffer?: Buffer | null;
}

export interface OfferEnricher {
  /** Returns a corrected offer, or null if the pass is disabled or failed
   *  (caller keeps the rule-based offer). */
  enrich(input: EnrichInput): Promise<OfferEnrichment | null>;
  /** Extracts ALL offers from a pure-image screenshot. Returns [] when the
   *  image contains no offers or the pass is disabled. */
  extractAllFromImage(screenshotBuffer: Buffer, brand: string | null): Promise<OfferEnrichment[]>;
}

/** Default when no API key is configured: AI is off, rule-based stands. */
export class NoopOfferEnricher implements OfferEnricher {
  async enrich(): Promise<OfferEnrichment | null> { return null; }
  async extractAllFromImage(): Promise<OfferEnrichment[]> { return []; }
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

const SYSTEM_PROMPT = `You extract a single automotive dealer ADVERTISED OFFER from the visible text (and optional screenshot) of a dealership web page. A rule-based extractor has already produced a first guess; correct it.

Rules:
- Identify the ONE offer the rule-based guess is anchored on (matched by its monthly payment / price), not every offer on the page. Multi-offer pages are why this is hard — keep the vehicle, payment, term, APR, cash, and due-at-signing consistent with that single ad.
- offerType: "lease" (monthly payment + due at signing), "finance" (APR or payment+term), "cash" (rebate/cash incentive), "service" (service-department special), or "promotional" (no priced terms).
- Vehicle make/model/trim must be the real advertised vehicle for THIS offer. Use null when not stated — never guess a model from page navigation or headers. When a screenshot is provided, look for the model name in the ad graphic — image-only platforms (e.g. DDC/Dealer.com) bake the vehicle name into the image rather than the DOM text.
- Money as plain numbers (no $ or commas). Term in whole months. APR as a percent number.
- DISCLAIMER (hard rule): the disclaimer is the fine print tied to THIS specific ad (it sits with the offer, e.g. "MSRP $X. Lease for $Y/mo, $Z due at signing..."). It is NEVER the site-wide footer legalese (Terms of Use, Privacy, ©, "do not sell"). Use null if no ad-specific disclaimer is present.
- confidence: your 0..1 confidence in this corrected offer.`;

const BULK_IMAGE_SYSTEM_PROMPT = `You extract ALL automotive dealer ADVERTISED OFFERS visible in a screenshot image. The page produced no DOM text, so the image is the only source.

Rules:
- Extract EVERY distinct offer visible in the image — there may be 1 to 10+ offers on a single page graphic.
- offerType: "lease" (monthly payment + due at signing), "finance" (APR or payment+term), "cash" (rebate/cash incentive), "service" (service-department special), or "promotional" (no priced terms).
- Vehicle make/model/trim: read from the image. Use null when not stated — never guess.
- Money as plain numbers (no $ or commas). Term in whole months. APR as a percent number.
- DISCLAIMER (hard rule): the fine print tied to THIS specific ad. NEVER site-wide footer legalese (Terms of Use, Privacy, ©). Use null if no ad-specific disclaimer is present.
- confidence: your 0..1 confidence in each extracted offer.
- If the image contains no offers (e.g. it is a banner or navigation), return an empty array.`;

const BulkExtractionSchema = z.object({
  offers: z.array(
    z.object({
      offerType: z.enum(offerTypeEnum.enumValues as [OfferType, ...OfferType[]]),
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
    })
  ),
});

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

    const textContent =
      `Dealer brand: ${input.brand ?? "unknown"}\n\n` +
      `Rule-based guess:\n${JSON.stringify(current)}\n\n` +
      `Page text:\n${pageText}`;

    // Include the ad screenshot when provided. Resize to fit within Claude's
    // 8000px per-dimension limit — full-page Playwright captures can be 15 000px+ tall.
    let imageBase64: string | null = null;
    if (input.screenshotBuffer && input.screenshotBuffer.length > 0) {
      try {
        const resized = await sharp(input.screenshotBuffer)
          .resize({ width: 1200, height: 7900, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toBuffer();
        imageBase64 = resized.toString("base64");
      } catch {
        // Non-fatal — fall back to text-only enrichment.
      }
    }
    const useImage = imageBase64 !== null;

    try {
      const response = await this.client.messages.parse({
        model: this.model,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: useImage
              ? [
                  {
                    type: "image" as const,
                    source: {
                      type: "base64" as const,
                      media_type: "image/jpeg" as const,
                      data: imageBase64!,
                    },
                  },
                  { type: "text" as const, text: textContent },
                ]
              : textContent,
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

  async extractAllFromImage(screenshotBuffer: Buffer, brand: string | null): Promise<OfferEnrichment[]> {
    let imageBase64: string | null = null;
    try {
      const resized = await sharp(screenshotBuffer)
        .resize({ width: 1200, height: 7900, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
      imageBase64 = resized.toString("base64");
    } catch {
      return [];
    }
    try {
      const response = await this.client.messages.parse({
        model: this.model,
        max_tokens: 4096,
        system: BULK_IMAGE_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image" as const,
                source: { type: "base64" as const, media_type: "image/jpeg" as const, data: imageBase64 },
              },
              { type: "text" as const, text: `Dealer brand: ${brand ?? "unknown"}. Extract all offers visible in this image.` },
            ],
          },
        ],
        output_config: { format: zodOutputFormat(BulkExtractionSchema) },
      });
      return response.parsed_output?.offers ?? [];
    } catch (err) {
      console.error("AI bulk image extraction failed:", err);
      return [];
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
