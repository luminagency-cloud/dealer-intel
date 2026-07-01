"use client";

import { useState } from "react";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function gradeStyle(grade: string): string {
  const g = grade.toLowerCase();
  if (g === "a" || g === "a+" || g === "a-" || g === "pass") {
    return "bg-green-100 text-green-800 hover:bg-green-200";
  }
  if (g === "n/a") return "bg-zinc-100 text-zinc-700 hover:bg-zinc-200";
  if (g === "f" || g === "fail") return "bg-red-100 text-red-800 hover:bg-red-200";
  return "bg-amber-100 text-amber-800 hover:bg-amber-200";
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
            className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-white shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4">
              <div>
                <h3 className="text-base font-semibold text-zinc-900">
                  Compliance Grade {grade}
                </h3>
                <p className="mt-1 text-sm text-zinc-700">
                  Saved response details from the grading pass.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md border border-zinc-300 px-2.5 py-1 text-sm text-zinc-700 hover:bg-zinc-50"
              >
                Close
              </button>
            </div>
            <div className="space-y-4 px-5 py-4">
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-600">
                  Reason
                </h4>
                <p className="mt-1 whitespace-pre-wrap text-sm text-zinc-900">
                  {summaryFromDetails(details)}
                </p>
              </div>
              {rows.length > 0 && (
                <dl className="divide-y divide-zinc-100 rounded-md border border-zinc-100">
                  {rows.map(([label, value]) => (
                    <div key={label} className="grid gap-2 px-3 py-2 sm:grid-cols-[140px_1fr]">
                      <dt className="text-xs font-medium text-zinc-600">{label}</dt>
                      <dd className="whitespace-pre-wrap break-words text-xs text-zinc-900">
                        {compactJson(value)}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
              <details>
                <summary className="cursor-pointer text-xs font-medium text-zinc-700">
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
