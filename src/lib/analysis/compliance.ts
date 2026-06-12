import type { OfferType } from "@/lib/db";

/**
 * Compliance grading (Phase 9). The roadmap is explicit: all compliance logic
 * lives in an external service — this platform sends evidence + disclaimer +
 * ad type and stores the grade that comes back. We code against an interface
 * so the real endpoint drops in without touching the analysis runner; until
 * then a deterministic stub stands in.
 */

export interface ComplianceRequest {
  evidenceId: string;
  offerType: OfferType;
  disclaimerText: string | null;
  /** Extracted/visible offer copy sent for grading. */
  adText: string | null;
}

export interface ComplianceGradeResult {
  /** Service-defined grade. The stub emits pass / warn / fail. */
  grade: string;
  /** Whatever structured detail the service returns, stored verbatim. */
  details: Record<string, unknown>;
}

export interface ComplianceGrader {
  grade(input: ComplianceRequest): Promise<ComplianceGradeResult>;
}

/**
 * Deterministic placeholder grader. It encodes the single most common
 * real-world rule — a priced offer needs a disclaimer — so the pipeline
 * produces sensible, stable grades to build the UI and reporting against. It
 * is NOT a compliance engine; the real service replaces it wholesale.
 */
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
      grade = "pass";
      reason = "Non-priced promotional content; no disclaimer requirement.";
    } else if (hasDisclaimer) {
      grade = "pass";
      reason = "Priced offer carries a disclaimer.";
    } else {
      grade = "fail";
      reason = "Priced offer with no disclaimer detected.";
    }

    return {
      grade,
      details: {
        stub: true,
        reason,
        offerType: input.offerType,
        hasDisclaimer,
      },
    };
  }
}

let _grader: ComplianceGrader | null = null;

/** The grader the analysis runner uses. Swap the construction here (or branch
 *  on an env var) when the real compliance endpoint is available. */
export function getComplianceGrader(): ComplianceGrader {
  if (!_grader) _grader = new StubComplianceGrader();
  return _grader;
}
