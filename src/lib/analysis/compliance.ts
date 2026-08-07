import sharp from "sharp";
import type { OfferType } from "@/lib/db";
import { getEnv, isAdScoreConfigured } from "@/lib/env";
import { isTransientNetworkError } from "./net";

/**
 * Compliance grading (Phase 9). All compliance logic lives in an external
 * service — this platform sends evidence + disclaimer + ad type and stores the
 * grade that comes back. We code against an interface so implementations swap
 * without touching the analysis runner.
 */

export interface ComplianceRequest {
  evidenceId: string;
  offerType: OfferType;
  disclaimerText: string | null;
  adText: string | null;
  /** Dealer display name for AdScore metadata. */
  dealerName: string | null;
  /** Two-letter state codes this dealer operates in (drives ruleset). */
  marketStates: string[];
  /** Raw PNG bytes of the page screenshot; grader resizes before sending. */
  screenshotBuffer: Buffer | null;
}

export interface ComplianceGradeResult {
  grade: string;
  details: Record<string, unknown>;
}

/** Sentinel grade for "the grader could not produce a real result." Used when
 *  an AdScore call fails or required inputs are missing — we never fabricate a
 *  letter grade in that case (a fake "A" is worse than an honest error). This
 *  is filtered out of client-facing reports and rendered distinctly in admin. */
export const COMPLIANCE_ERROR_GRADE = "Err";

function errorResult(
  reason: string,
  extra: Record<string, unknown> = {}
): ComplianceGradeResult {
  return {
    grade: COMPLIANCE_ERROR_GRADE,
    details: { error: true, reason, ...extra },
  };
}

/**
 * Structured error contract returned by AdScore's gradeAd endpoint. Every
 * failure carries success/error/requestId; newer failures also add
 * code/retryable/details. Callers branch on `code`, not the human `error`.
 */
interface AdScoreErrorBody {
  success?: boolean;
  error?: string;
  requestId?: string;
  code?: string;
  retryable?: boolean;
  details?: {
    phase?: string;
    provider?: string;
    upstreamStatus?: number;
    upstreamMessage?: string;
  };
}

type AdScoreFailure = { status: number; text: string; body: AdScoreErrorBody | null };

/** Transient provider codes — back off and retry. */
const RETRYABLE_ADSCORE_CODES = new Set([
  "OBSERVATION_PROVIDER_UNAVAILABLE",
  "OBSERVATION_PROVIDER_RATE_LIMITED",
  "OBSERVATION_PROVIDER_TIMEOUT",
  "OBSERVATION_PROVIDER_INVALID_RESPONSE",
]);

/** Backend config/auth codes — these fail identically for every ad in the run,
 *  so once we see one we short-circuit the remaining ads instead of retrying. */
const FATAL_BACKEND_ADSCORE_CODES = new Set([
  "OBSERVATION_PROVIDER_AUTH_FAILED",
  "OBSERVATION_PROVIDER_NOT_CONFIGURED",
]);

/** Provider rejected this specific payload — retry once with the image removed. */
const REJECTED_PAYLOAD_ADSCORE_CODE = "OBSERVATION_PROVIDER_REJECTED_REQUEST";

const BACKOFF_BASE_MS = 1000;
const MAX_BACKOFF_RETRIES = 2;

function parseAdScoreError(text: string): AdScoreErrorBody | null {
  try {
    const json = JSON.parse(text) as unknown;
    return json && typeof json === "object" ? (json as AdScoreErrorBody) : null;
  } catch {
    return null;
  }
}

/** Turn an AdScore failure into an Err grade, preserving the structured error
 *  contract (code / retryable / details) so the UI drill-down and any future
 *  code-based handling have everything the API returned. */
function buildApiErrorResult(
  failure: AdScoreFailure,
  extra: Record<string, unknown>
): ComplianceGradeResult {
  const { status, text, body } = failure;
  return errorResult(
    body?.error ?? `AdScore gradeAd returned ${status} and could not grade this ad.`,
    {
      stage: "api_error",
      status,
      code: body?.code ?? null,
      retryable: body?.retryable ?? null,
      requestId: body?.requestId ?? null,
      phase: body?.details?.phase ?? null,
      provider: body?.details?.provider ?? null,
      upstreamStatus: body?.details?.upstreamStatus ?? null,
      upstreamMessage: body?.details?.upstreamMessage ?? null,
      providerError: text,
      ...extra,
    }
  );
}

export interface ComplianceGrader {
  grade(input: ComplianceRequest): Promise<ComplianceGradeResult>;
}

// ---------------------------------------------------------------------------
// Stub grader — deterministic placeholder, no external call
// ---------------------------------------------------------------------------

export class StubComplianceGrader implements ComplianceGrader {
  async grade(input: ComplianceRequest): Promise<ComplianceGradeResult> {
    const hasDisclaimer = Boolean(input.disclaimerText?.trim());
    const isPriced =
      input.offerType === "lease" ||
      input.offerType === "finance" ||
      input.offerType === "cash";

    let grade: string;
    let reason: string;
    if (!isPriced) {
      grade = "A";
      reason = "Non-priced promotional content; no disclaimer requirement.";
    } else if (hasDisclaimer) {
      grade = "A";
      reason = "Priced offer carries a disclaimer.";
    } else {
      grade = "F";
      reason = "Priced offer with no disclaimer detected.";
    }

    return {
      grade,
      details: { stub: true, reason, offerType: input.offerType, hasDisclaimer },
    };
  }
}

// ---------------------------------------------------------------------------
// AdScore grader — real external compliance API
// ---------------------------------------------------------------------------

/** Resize a raw PNG/JPEG to 1200×1600 max (JPEG 75%) for AdScore.
 *  A compliance grader only needs the ad card — not a full-page capture. */
async function prepareImage(
  buf: Buffer
): Promise<{ data: string; mimeType: "image/jpeg" }> {
  const resized = await sharp(buf)
    .resize({ width: 1200, height: 1600, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 75 })
    .toBuffer();
  return { data: resized.toString("base64"), mimeType: "image/jpeg" };
}

export class AdScoreComplianceGrader implements ComplianceGrader {
  private readonly baseUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private batchId: string | null = null;
  private batchPromise: Promise<string> | null = null;
  /** Set once the backend reports a run-wide config/auth failure; subsequent
   *  ads short-circuit to Err instead of re-calling an endpoint we know is dead. */
  private fatalBackend: AdScoreFailure | null = null;

  constructor(private readonly runId: string) {
    const env = getEnv();
    this.baseUrl = env.ADGRADER_BASE_URL!;
    this.clientId = env.ADGRADER_CLIENT_ID!;
    this.clientSecret = env.ADGRADER_CLIENT_SECRET!;
  }

  private authHeaders() {
    return {
      "Content-Type": "application/json",
      "x-adgrader-client-id": this.clientId,
      "x-adgrader-client-secret": this.clientSecret,
    };
  }

  private ensureBatch(): Promise<string> {
    if (!this.batchPromise) {
      this.batchPromise = (async () => {
        const resp = await fetchWithRetry(
          `${this.baseUrl}/api/external/v1/requestBatchId`,
          {
            method: "POST",
            headers: this.authHeaders(),
            body: JSON.stringify({ batchName: `dealer-intel run ${this.runId}` }),
          }
        );
        if (!resp.ok) {
          throw new Error(
            `AdScore requestBatchId failed: ${resp.status} ${await resp.text()}`
          );
        }
        const json = (await resp.json()) as { batchId: string };
        this.batchId = json.batchId;
        return json.batchId;
      })();
    }
    return this.batchPromise;
  }

  private async callGradeAd(
    input: ComplianceRequest,
    batchId: string,
    withImage: boolean
  ): Promise<Response> {
    const baseBody: Record<string, unknown> = {
      rawText: input.adText ?? undefined,
      disclaimerText: input.disclaimerText ?? undefined,
      metadata: {
        batchId,
        dealerName: input.dealerName ?? "Unknown Dealer",
        originalFileName: `evidence-${input.evidenceId}.jpg`,
        selectedMarketStates: input.marketStates,
      },
    };

    if (withImage && input.screenshotBuffer) {
      const { data: imageBase64, mimeType: imageMimeType } = await prepareImage(
        input.screenshotBuffer
      );
      baseBody.imageBase64 = imageBase64;
      baseBody.imageMimeType = imageMimeType;
    }

    return fetchWithRetry(`${this.baseUrl}/api/external/v1/gradeAd`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify(baseBody),
    });
  }

  async grade(input: ComplianceRequest): Promise<ComplianceGradeResult> {
    try {
      return await this._grade(input);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[compliance] grade() threw for evidence ${input.evidenceId} — recording Err:`, err);
      return errorResult(`Grader raised an unexpected error: ${message}`, {
        stage: "exception",
      });
    }
  }

  private async _grade(input: ComplianceRequest): Promise<ComplianceGradeResult> {
    // AdScore requires both an image and a market state. When either is missing
    // we can't get a real grade, so we record Err rather than inventing one.
    // Log so the gap is visible in server output.
    if (!input.screenshotBuffer) {
      console.warn(
        `[compliance] no screenshot for evidence ${input.evidenceId} — recording Err`
      );
      return errorResult(
        "No screenshot was captured for this evidence, so AdScore (which requires an image) was not run.",
        { stage: "missing_screenshot" }
      );
    }
    if (input.marketStates.length === 0) {
      console.warn(
        `[compliance] no market states for evidence ${input.evidenceId} — recording Err`
      );
      return errorResult(
        "No market states are configured for this dealer, so an AdScore ruleset could not be selected.",
        { stage: "missing_market_states" }
      );
    }

    // Backend already reported a run-wide config/auth failure — don't re-call.
    if (this.fatalBackend) {
      return buildApiErrorResult(this.fatalBackend, { shortCircuited: true });
    }

    const batchId = await this.ensureBatch();

    let withImage = true;
    let strippedImage = false;
    let backoffRetries = 0;
    let last: AdScoreFailure | null = null;

    // Bounded loop: initial call + at most one image-stripped retry + a couple
    // of backoff retries for transient provider errors.
    for (let i = 0; i < MAX_BACKOFF_RETRIES + 3; i++) {
      const resp = await this.callGradeAd(input, batchId, withImage);

      if (resp.ok) {
        const json = (await resp.json()) as {
          success: boolean;
          warning?: string | null;
          result: {
            id: string;
            grade: string;
            score: number;
            color: string;
            ruleset_version: string;
            graded_by: string;
            findings: Record<string, unknown>;
          };
        };
        if (json.warning) {
          console.warn(`[compliance] AdScore warning for ${input.evidenceId}: ${json.warning}`);
        }
        return {
          grade: json.result.grade,
          details: {
            adScore: true,
            score: json.result.score,
            color: json.result.color,
            rulesetVersion: json.result.ruleset_version,
            gradedBy: json.result.graded_by,
            findings: json.result.findings,
            batchId,
            gradeId: json.result.id,
          },
        };
      }

      const text = await resp.text().catch(() => "");
      const body = parseAdScoreError(text);
      const code = body?.code ?? null;
      last = { status: resp.status, text, body };

      // 1) Provider rejected this payload — retry once with the image removed.
      //    Covers the new REJECTED_REQUEST code and the legacy raw-422 path.
      const rejected =
        code === REJECTED_PAYLOAD_ADSCORE_CODE || (code === null && resp.status === 422);
      if (rejected && withImage && !strippedImage) {
        console.warn(
          `[compliance] gradeAd rejected payload for evidence ${input.evidenceId} ` +
            `(code=${code ?? resp.status}, offerType=${input.offerType}) — retrying without image`
        );
        withImage = false;
        strippedImage = true;
        continue;
      }

      // 2) Backend config/auth is dead for the whole run — record it so the
      //    remaining ads short-circuit, then return Err for this one.
      if (code && FATAL_BACKEND_ADSCORE_CODES.has(code)) {
        this.fatalBackend = last;
        console.error(
          `[compliance] gradeAd fatal backend error ${resp.status} (code=${code}) for ` +
            `evidence ${input.evidenceId} — remaining ads this run short-circuit to Err. ` +
            `requestId=${body?.requestId ?? "?"}`
        );
        return buildApiErrorResult(last, {});
      }

      // 3) Transient/retryable provider error — back off and retry. Trust the
      //    API's explicit `retryable` flag when present; otherwise infer from
      //    the known transient code set.
      const retryable =
        typeof body?.retryable === "boolean"
          ? body.retryable
          : code !== null && RETRYABLE_ADSCORE_CODES.has(code);
      if (retryable && backoffRetries < MAX_BACKOFF_RETRIES) {
        backoffRetries++;
        const delay = BACKOFF_BASE_MS * 2 ** (backoffRetries - 1);
        console.warn(
          `[compliance] gradeAd ${resp.status} (code=${code ?? "?"}) for evidence ` +
            `${input.evidenceId} — retry ${backoffRetries}/${MAX_BACKOFF_RETRIES} after ${delay}ms`
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      // 4) Non-retryable, or retries exhausted — stop.
      break;
    }

    console.error(
      `[compliance] gradeAd failed ${last?.status} (code=${last?.body?.code ?? "none"}) for ` +
        `evidence ${input.evidenceId} (offerType=${input.offerType}, ` +
        `dealer=${input.dealerName ?? "?"}): ${last?.text ?? ""}`
    );
    return buildApiErrorResult(last!, {});
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchWithRetry(
  ...args: Parameters<typeof fetch>
): Promise<Response> {
  try {
    return await fetch(...args);
  } catch (err) {
    if (isTransientNetworkError(err)) {
      console.warn("[compliance] transient network error, retrying once:", (err as Error).message);
      await new Promise((r) => setTimeout(r, 1500));
      return fetch(...args);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Returns the appropriate grader for the current environment.
 *  AdScore when all three ADGRADER_* vars are set; stub otherwise.
 *  Always returns a fresh instance so each analysis run gets its own batch. */
export function getComplianceGrader(runId: string): ComplianceGrader {
  if (isAdScoreConfigured()) return new AdScoreComplianceGrader(runId);
  return new StubComplianceGrader();
}
