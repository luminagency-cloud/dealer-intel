import sharp from "sharp";
import type { OfferType } from "@/lib/db";
import { getEnv, isAdScoreConfigured } from "@/lib/env";

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

/** Resize a raw PNG/JPEG to 1200×7900 max (JPEG 80%).
 *  Claude's API rejects images over 8000px in either dimension; full-page
 *  Playwright screenshots can be 15 000px+ tall. */
async function prepareImage(
  buf: Buffer
): Promise<{ data: string; mimeType: "image/jpeg" }> {
  const resized = await sharp(buf)
    .resize({ width: 1200, height: 7900, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
  return { data: resized.toString("base64"), mimeType: "image/jpeg" };
}

export class AdScoreComplianceGrader implements ComplianceGrader {
  private readonly baseUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private batchId: string | null = null;
  private batchPromise: Promise<string> | null = null;
  private readonly stub = new StubComplianceGrader();

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
        const resp = await fetch(
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

  async grade(input: ComplianceRequest): Promise<ComplianceGradeResult> {
    // Fall back to stub when there's no image or no market state — AdScore
    // requires both. Log so the gap is visible in server output.
    if (!input.screenshotBuffer) {
      console.warn(
        `[compliance] no screenshot for evidence ${input.evidenceId} — using stub`
      );
      return this.stub.grade(input);
    }
    if (input.marketStates.length === 0) {
      console.warn(
        `[compliance] no market states for evidence ${input.evidenceId} — using stub`
      );
      return this.stub.grade(input);
    }

    const batchId = await this.ensureBatch();
    const { data: imageBase64, mimeType: imageMimeType } = await prepareImage(
      input.screenshotBuffer
    );

    const body = {
      imageBase64,
      imageMimeType,
      rawText: input.adText ?? undefined,
      disclaimerText: input.disclaimerText ?? undefined,
      metadata: {
        batchId,
        dealerName: input.dealerName ?? "Unknown Dealer",
        originalFileName: `evidence-${input.evidenceId}.jpg`,
        selectedMarketStates: input.marketStates,
      },
    };

    const resp = await fetch(`${this.baseUrl}/api/external/v1/gradeAd`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      console.error(`[compliance] gradeAd failed ${resp.status}: ${text}`);
      return this.stub.grade(input);
    }

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
