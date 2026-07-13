"use client";

import { useState } from "react";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function gradeStyle(grade: string): string {
  const g = grade.toLowerCase();
  if (g === "a" || g === "a+" || g === "a-" || g === "pass") {
    return "bg-green-100 text-green-800 hover:bg-green-200 dark:bg-green-900 dark:text-green-200 dark:hover:bg-green-800";
  }
  if (g === "n/a") return "bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700";
  if (g === "err") return "bg-zinc-700 text-zinc-50 hover:bg-zinc-600 dark:bg-zinc-600 dark:text-zinc-50 dark:hover:bg-zinc-500";
  if (g === "f" || g === "fail") return "bg-red-100 text-red-800 hover:bg-red-200 dark:bg-red-900 dark:text-red-200 dark:hover:bg-red-800";
  return "bg-amber-100 text-amber-800 hover:bg-amber-200 dark:bg-amber-900 dark:text-amber-200 dark:hover:bg-amber-800";
}

function compactJson(value: unknown): string {
  if (value === undefined || value === null || value === "") return "—";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function findingText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return compactJson(value);
  for (const key of ["reason", "message", "description", "title", "name", "rule", "text"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return compactJson(value);
}

function summaryFromDetails(details: unknown): string {
  if (!isRecord(details)) return "No grade details were stored for this result.";
  if (typeof details.reason === "string" && details.reason.trim()) return details.reason;

  const findings = isRecord(details.findings) ? details.findings : null;
  const violations = Array.isArray(findings?.violations) ? findings.violations : [];
  if (violations.length > 0) return violations.slice(0, 3).map(findingText).join(" ");

  const bonuses = Array.isArray(findings?.bonuses) ? findings.bonuses : [];
  if (bonuses.length > 0) return `No violations returned. Bonuses: ${bonuses.slice(0, 3).map(findingText).join(" ")}`;

  if (details.notApplicable) return "This offer type is not sent to AdScore.";
  if (details.error) return "The grader could not produce a result for this ad, so no grade was recorded.";
  if (details.adScore) return "AdScore returned no violations in the saved findings.";
  return "No reason text was included in the saved grade details.";
}

function detailRows(details: unknown): Array<[string, unknown]> {
  if (!isRecord(details)) return [];
  const findings = isRecord(details.findings) ? details.findings : {};
  const rows: Array<[string, unknown]> = [
    ["Score", details.score],
    ["Color", details.color],
    ["Ruleset", details.rulesetVersion],
    ["Graded by", details.gradedBy],
    ["Ad type", findings.adType],
    ["Market states", findings.selectedMarketStates],
    ["Violations", findings.violations],
    ["Bonuses", findings.bonuses],
    ["Batch ID", details.batchId],
    ["Grade ID", details.gradeId],
    // Error drill-down (only populated on "Err" grades from a failed grade call).
    ["Error code", details.code],
    ["Retryable", typeof details.retryable === "boolean" ? String(details.retryable) : details.retryable],
    ["Phase", details.phase],
    ["Provider", details.provider],
    ["Upstream status", details.upstreamStatus],
    ["Upstream message", details.upstreamMessage],
    ["Request ID", details.requestId],
  ];
  return rows.filter(([, value]) => value !== undefined && value !== null && value !== "");
}

export function ComplianceGradeBadge({
  grade,
  details,
}: {
  grade: string;
  details?: unknown;
}) {
  const [open, setOpen] = useState(false);
  const rows = detailRows(details);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium transition-colors ${gradeStyle(grade)}`}
        title="View grade details"
      >
        {grade}
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4 py-6"
          role="dialog"
          aria-modal="true"
          aria-label="Compliance grade details"
          onClick={() => setOpen(false)}
        >
          <div
            className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-white shadow-xl dark:bg-zinc-900"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4 dark:border-zinc-800">
              <div>
                <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                  Compliance Grade {grade}
                </h3>
                <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-200">
                  Saved response details from the grading pass.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md border border-zinc-300 px-2.5 py-1 text-sm text-zinc-700 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Close
              </button>
            </div>
            <div className="space-y-4 px-5 py-4">
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-200">
                  Reason
                </h4>
                <p className="mt-1 whitespace-pre-wrap text-sm text-zinc-900 dark:text-zinc-100">
                  {summaryFromDetails(details)}
                </p>
              </div>
              {rows.length > 0 && (
                <dl className="divide-y divide-zinc-100 rounded-md border border-zinc-100 dark:divide-zinc-800 dark:border-zinc-800">
                  {rows.map(([label, value]) => (
                    <div key={label} className="grid gap-2 px-3 py-2 sm:grid-cols-[140px_1fr]">
                      <dt className="text-xs font-medium text-zinc-600 dark:text-zinc-200">{label}</dt>
                      <dd className="whitespace-pre-wrap break-words text-xs text-zinc-900 dark:text-zinc-100">
                        {compactJson(value)}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
              <details>
                <summary className="cursor-pointer text-xs font-medium text-zinc-700 dark:text-zinc-300">
                  Raw stored details
                </summary>
                <pre className="mt-2 max-h-72 overflow-auto rounded-md bg-zinc-950 p-3 text-xs text-zinc-50">
                  {compactJson(details)}
                </pre>
              </details>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
