import sharp from "sharp";

/**
 * Mistral OCR client (Phase 12 image pass). Reads visible text/layout off an
 * image — nothing more. It does not classify offers or judge what an ad
 * "means"; that stays deterministic (extract.ts) or, for text-only judgment
 * calls, with Claude (ai-enrich.ts). This module never touches the database —
 * runner.ts calls it and persists the result to `ocr_artifacts`.
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
  provider: "mistral";
  model: string;
  imageText: string;
  pages: OcrPage[];
}

const MISTRAL_OCR_URL = "https://api.mistral.ai/v1/ocr";
let mistralUnauthorized = false;

function mistralModel(): string {
  return process.env.MISTRAL_OCR_MODEL || "mistral-ocr-latest";
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
        `[ocr-mistral] network error provider=mistral model=${mistralModel()} attempt=${attempt} elapsedMs=${elapsedMs}:`,
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
      console.log(`[ocr-mistral] ok provider=mistral model=${mistralModel()} status=${resp.status} elapsedMs=${elapsedMs}`);
      return resp;
    }

    if (resp.status === 401) {
      console.error(
        `[ocr-mistral] 401 unauthorized provider=mistral model=${mistralModel()} elapsedMs=${elapsedMs} — check MISTRAL_API_KEY, not retrying`
      );
      return resp;
    }

    const preview = (await resp.clone().text().catch(() => "")).slice(0, 300);
    console.warn(
      `[ocr-mistral] status=${resp.status} provider=mistral model=${mistralModel()} attempt=${attempt} elapsedMs=${elapsedMs} preview=${preview}`
    );
    if (attempt < maxAttempts && (resp.status === 429 || resp.status >= 500)) {
      await new Promise((r) => setTimeout(r, 1500 * attempt));
      continue;
    }
    return resp;
  }
  // Unreachable — loop always returns or throws — but TS needs a return.
  throw new Error("[ocr-mistral] retry loop exhausted without a response");
}

/** OCRs an image (screenshot) with Mistral. Returns null on any failure —
 *  callers keep going without OCR rather than fail the analysis run. */
export async function runMistralOcr(
  imageBuffer: Buffer,
  mimeType: string = "image/jpeg"
): Promise<OcrArtifact | null> {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) return null;
  if (mistralUnauthorized) return null;

  let imageBase64: string;
  try {
    const resized = await sharp(imageBuffer)
      .resize({ width: 1600, height: 7900, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    imageBase64 = resized.toString("base64");
  } catch (err) {
    console.error("[ocr-mistral] image resize failed:", err);
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
          "[ocr-mistral] disabling OCR for this server process after 401 unauthorized; fix MISTRAL_API_KEY and restart the app"
        );
      }
      console.error(`[ocr-mistral] request failed status=${resp.status} model=${model}: ${text.slice(0, 300)}`);
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
      imageText: pages.map((p) => p.markdown || p.text).filter(Boolean).join("\n\n"),
      pages,
    };
  } catch (err) {
    console.error(`[ocr-mistral] OCR call threw model=${model}:`, err);
    return null;
  }
}
