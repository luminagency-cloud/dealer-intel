import Anthropic from "@anthropic-ai/sdk";
import sharp from "sharp";

/**
 * OCR client (Phase 12 image pass). Reads visible text/layout off an image —
 * nothing more. It does not classify offers or judge what an ad "means"; that
 * stays deterministic (extract.ts) or, for text-only judgment calls, with
 * Claude (ai-enrich.ts). This module never touches the database — runner.ts
 * calls it and persists the result to `ocr_artifacts`.
 *
 * Mistral is the default provider: cheap, fast, and correct on the large
 * majority of dealer ad art. Claude vision is the escalation path for reads
 * Mistral gets visibly wrong — see runOcr.
 */

export interface OcrPage {
  index: number;
  markdown: string;
  text: string;
  dimensions: unknown | null;
  blocks: unknown[];
  /** Diagnostic only (confidence_scores_granularity: "page") — never fed into
   *  classification, just useful for debugging a bad OCR read later. */
  confidence: number | null;
}

export interface OcrArtifact {
  provider: "mistral" | "anthropic";
  model: string;
  imageText: string;
  pages: OcrPage[];
}

const MISTRAL_OCR_URL = "https://api.mistral.ai/v1/ocr";
/** Upper bound on what we send to Mistral. Images within this are sent as-is. */
const MAX_OCR_WIDTH = 1600;
const MAX_OCR_HEIGHT = 7900;
let mistralUnauthorized = false;

/** Converts Mistral's Markdown-oriented OCR response into the plain visible
 * text expected by the deterministic offer extractor. The raw per-page
 * Markdown remains available in `pages` for audit/debugging. */
export function normalizeOcrText(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s{0,3}(?:[-+*]|\d+[.)])\s+/gm, "")
    .replace(/[\*_~`]+/g, "")
    .replace(/\\([\\`*_{\[\]()#+\-.!>])/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Pinned deliberately — do NOT put "mistral-ocr-latest" back here. Measured
 *  Aug 5 2026 against five Anchor Nissan hero ads with the prices read off the
 *  graphics by eye: the ocr-4 line that "latest" now resolves to read a Murano
 *  "$389/MO" as "$399/MO" (a wrong price that looks perfectly confident
 *  downstream), while mistral-ocr-3 read all five ads correctly. Re-measure
 *  before moving this. */
const DEFAULT_OCR_MODEL = "mistral-ocr-3";

function mistralModel(): string {
  return process.env.MISTRAL_OCR_MODEL || DEFAULT_OCR_MODEL;
}

function isTransientNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ECONNREFUSED" || code === "EPIPE") return true;
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error) return isTransientNetworkError(cause);
  return false;
}

/** Retries 429/5xx and transient network errors once with a short backoff.
 *  Never retries 401 — that's a key/config problem, not a transient one. */
async function fetchMistralWithRetry(
  body: string,
  apiKey: string
): Promise<Response> {
  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const start = Date.now();
    let resp: Response;
    try {
      resp = await fetch(MISTRAL_OCR_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body,
      });
    } catch (err) {
      const elapsedMs = Date.now() - start;
      console.warn(
        `[ocr] network error provider=mistral model=${mistralModel()} attempt=${attempt} elapsedMs=${elapsedMs}:`,
        (err as Error).message
      );
      if (attempt < maxAttempts && isTransientNetworkError(err)) {
        await new Promise((r) => setTimeout(r, 1500 * attempt));
        continue;
      }
      throw err;
    }

    const elapsedMs = Date.now() - start;
    if (resp.ok) {
      console.log(`[ocr] ok provider=mistral model=${mistralModel()} status=${resp.status} elapsedMs=${elapsedMs}`);
      return resp;
    }

    if (resp.status === 401) {
      console.error(
        `[ocr] 401 unauthorized provider=mistral model=${mistralModel()} elapsedMs=${elapsedMs} — check MISTRAL_API_KEY, not retrying`
      );
      return resp;
    }

    const preview = (await resp.clone().text().catch(() => "")).slice(0, 300);
    console.warn(
      `[ocr] status=${resp.status} provider=mistral model=${mistralModel()} attempt=${attempt} elapsedMs=${elapsedMs} preview=${preview}`
    );
    if (attempt < maxAttempts && (resp.status === 429 || resp.status >= 500)) {
      await new Promise((r) => setTimeout(r, 1500 * attempt));
      continue;
    }
    return resp;
  }
  // Unreachable — loop always returns or throws — but TS needs a return.
  throw new Error("[ocr] retry loop exhausted without a response");
}

/** Signatures of a read worth one boosted retry. Nothing subtle — an empty
 *  read, or a monthly payment of a few dollars and cents, which no dealer has
 *  ever advertised. Measured Aug 5 2026: a real Ram 1500 hero ad (light grey
 *  numerals over a washed-out photo) read "$479/Mo" as "$4.79/Mo" from the
 *  original bytes and read correctly after a contrast boost. */
export function looksMisread(text: string): boolean {
  if (!text.trim()) return true;
  // The lookahead spares finance disclosures, where a few dollars and cents
  // per month is legitimate: "$8.10 per month per $1,000 financed".
  return /\$\s?\d\.\d{2}\s*\/?\s*(?:per\s+|a\s+)?mo(?:nth)?\b(?!\s*per\s*\$)/i.test(text);
}

/** OCRs an image (screenshot). Mistral first — it is the cheap, accurate
 *  default. A read that `looksMisread` escalates: once to Mistral with boosted
 *  contrast, then to Claude vision. Both escalations are rare by construction
 *  (they only fire on a read that is already visibly wrong), so the expensive
 *  provider never touches the ~99% of ads Mistral reads correctly.
 *
 *  Returns null on total failure — callers keep going without OCR rather than
 *  fail the analysis run. */
export async function runOcr(
  imageBuffer: Buffer,
  mimeType: string = "image/jpeg"
): Promise<OcrArtifact | null> {
  const first = await ocrOnce(imageBuffer, mimeType);
  if (first && !looksMisread(first.imageText)) return first;

  let second: OcrArtifact | null = null;
  if (process.env.MISTRAL_API_KEY && !mistralUnauthorized) {
    try {
      // Contrast only — no grayscale. Measured against real hero ads, grayscale
      // is neutral-to-worse (it cost the "Kia" wordmark on a gold gradient)
      // while the linear stretch is what recovers thin light-on-light numerals.
      const boosted = await sharp(imageBuffer).linear(1.6, -60).png().toBuffer();
      second = await ocrOnce(boosted, "image/png");
      if (second && !looksMisread(second.imageText)) {
        console.log("[ocr] contrast retry recovered a suspect read");
        return second;
      }
    } catch (err) {
      console.warn("[ocr] contrast retry preprocessing failed:", err);
    }
  }

  const claude = await runClaudeOcr(imageBuffer, mimeType);
  if (claude && !looksMisread(claude.imageText)) {
    console.log(`[ocr] claude fallback recovered a suspect read model=${claude.model}`);
    return claude;
  }
  return first ?? second ?? claude;
}

/** Last-resort OCR: Claude vision. Measured Aug 5 2026 on the Ram 1500 hero ad
 *  that defeated Mistral — Claude read "$479/Mo" correctly on the first try,
 *  plus the warranty fine print Mistral rendered as a row of zeros.
 *
 *  A hero ad measures ~300-1300 input tokens plus ~100 output, so roughly
 *  0.4c/image on Sonnet 4.6 and 0.7c on Opus 5 — several times a Mistral page.
 *  That is why it sits behind the `looksMisread` gate instead of running on
 *  every ad. Override the model with ANTHROPIC_OCR_MODEL.
 *
 *  Note this is unreachable when MISTRAL_API_KEY is unset: every caller in
 *  runner.ts gates the whole OCR pass on isMistralConfigured(). Deliberate —
 *  it stops a missing Mistral key from silently routing 100% of images here. */
const DEFAULT_CLAUDE_OCR_MODEL = "claude-opus-5";
const CLAUDE_OCR_PROMPT =
  "Transcribe ALL visible text in this image exactly as printed, including " +
  "fine print, superscripts, and disclaimers. Preserve reading order. Output " +
  "plain text only — no commentary, no summary, no markdown formatting. If the " +
  "image contains no text, output nothing.";

/** Media types the Messages API accepts for image blocks. Anything else (or an
 *  unreadable header) is re-encoded to PNG rather than gambling on a 400. */
const CLAUDE_MEDIA_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
type ClaudeMediaType = (typeof CLAUDE_MEDIA_TYPES)[number];

let anthropicClient: Anthropic | null = null;

async function runClaudeOcr(
  imageBuffer: Buffer,
  mimeType: string
): Promise<OcrArtifact | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const model = process.env.ANTHROPIC_OCR_MODEL || DEFAULT_CLAUDE_OCR_MODEL;

  let body: Buffer;
  let mediaType: ClaudeMediaType;
  try {
    const prepared = await prepareImage(imageBuffer, mimeType);
    if (CLAUDE_MEDIA_TYPES.includes(prepared.mimeType as ClaudeMediaType)) {
      body = prepared.body;
      mediaType = prepared.mimeType as ClaudeMediaType;
    } else {
      body = await sharp(prepared.body).png().toBuffer();
      mediaType = "image/png";
    }
  } catch (err) {
    console.error("[ocr] claude image preprocessing failed:", err);
    return null;
  }

  const start = Date.now();
  try {
    anthropicClient ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropicClient.messages.create({
      model,
      max_tokens: 4096,
      // Transcription needs no deliberation, and low effort is the cheap lever
      // that keeps thinking on — disabling it entirely risks leaking internal
      // tags into the very text we are about to parse as ad copy.
      output_config: { effort: "low" },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType, data: body.toString("base64") },
            },
            { type: "text", text: CLAUDE_OCR_PROMPT },
          ],
        },
      ],
    });
    if (response.stop_reason === "refusal") {
      console.warn(`[ocr] claude declined the image model=${model}`);
      return null;
    }
    const imageText = normalizeOcrText(
      response.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("")
    );
    console.log(
      `[ocr] ok provider=anthropic model=${model} elapsedMs=${Date.now() - start} ` +
        `in=${response.usage.input_tokens} out=${response.usage.output_tokens}`
    );
    return {
      provider: "anthropic",
      model,
      imageText,
      pages: [
        { index: 0, markdown: imageText, text: imageText, dimensions: null, blocks: [], confidence: null },
      ],
    };
  } catch (err) {
    console.error(`[ocr] claude call threw model=${model}:`, err);
    return null;
  }
}

/** Shrinks oversized images (tall full-page screenshots) and reports the media
 *  type of the bytes actually returned. Images that already fit are passed
 *  through untouched: the q85 JPEG round-trip we used to apply unconditionally
 *  is lossy on exactly the small print that matters — it cost us a whole
 *  "$2,999 Total Due at signing" line on a real dealer ad that OCRs fine
 *  untouched. */
async function prepareImage(
  imageBuffer: Buffer,
  mimeType: string
): Promise<{ body: Buffer; mimeType: string }> {
  const meta = await sharp(imageBuffer).metadata();
  const oversized =
    (meta.width ?? 0) > MAX_OCR_WIDTH || (meta.height ?? 0) > MAX_OCR_HEIGHT;
  if (oversized) {
    const resized = await sharp(imageBuffer)
      .resize({ width: MAX_OCR_WIDTH, height: MAX_OCR_HEIGHT, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    return { body: resized, mimeType: "image/jpeg" };
  }
  return { body: imageBuffer, mimeType: meta.format ? `image/${meta.format}` : mimeType };
}

async function ocrOnce(
  imageBuffer: Buffer,
  mimeType: string = "image/jpeg"
): Promise<OcrArtifact | null> {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) return null;
  if (mistralUnauthorized) return null;

  let imageBase64: string;
  try {
    // The data URI must describe the bytes actually sent, not the caller's
    // default — prepareImage only re-encodes when it has to.
    const prepared = await prepareImage(imageBuffer, mimeType);
    imageBase64 = prepared.body.toString("base64");
    mimeType = prepared.mimeType;
  } catch (err) {
    console.error("[ocr] image preprocessing failed:", err);
    return null;
  }

  const model = mistralModel();
  const body = JSON.stringify({
    model,
    document: {
      type: "image_url",
      image_url: `data:${mimeType};base64,${imageBase64}`,
    },
    include_blocks: true,
    include_image_base64: false,
    confidence_scores_granularity: "page",
    table_format: "markdown",
  });

  try {
    const resp = await fetchMistralWithRetry(body, apiKey);
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      if (resp.status === 401) {
        mistralUnauthorized = true;
        console.error(
          "[ocr] disabling OCR for this server process after 401 unauthorized; fix MISTRAL_API_KEY and restart the app"
        );
      }
      console.error(`[ocr] request failed status=${resp.status} model=${model}: ${text.slice(0, 300)}`);
      return null;
    }

    const json = (await resp.json()) as {
      pages?: Array<{
        index?: number;
        markdown?: string;
        text?: string;
        dimensions?: unknown;
        blocks?: unknown[];
        confidence_score?: number;
        confidence?: number;
      }>;
    };

    const pages: OcrPage[] = (json.pages ?? []).map((page, index) => ({
      index: Number.isFinite(page.index) ? (page.index as number) : index,
      markdown: page.markdown || "",
      text: page.text || page.markdown || "",
      dimensions: page.dimensions ?? null,
      blocks: Array.isArray(page.blocks) ? page.blocks : [],
      confidence: page.confidence_score ?? page.confidence ?? null,
    }));

    return {
      provider: "mistral",
      model,
      imageText: normalizeOcrText(
        pages.map((p) => p.markdown || p.text).filter(Boolean).join("\n\n")
      ),
      pages,
    };
  } catch (err) {
    console.error(`[ocr] OCR call threw model=${model}:`, err);
    return null;
  }
}
