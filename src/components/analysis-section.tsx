"use client";

import { useState } from "react";
import { OFFER_TYPE_LABELS, type ComplianceGrade, type Offer, type Site } from "@/lib/db";

function money(value: number | null): string {
  return value === null ? "—" : `$${value.toLocaleString()}`;
}

function gradeStyle(grade: string): string {
  const g = grade.toLowerCase();
  if (g === "a" || g === "a+" || g === "a-") return "bg-green-100 text-green-800";
  if (g === "n/a") return "bg-zinc-100 text-zinc-500";
  if (g === "f") return "bg-red-100 text-red-800";
  return "bg-amber-100 text-amber-800";
}

function confidenceStyle(confidence: number | null): string {
  if (confidence === null) return "text-zinc-400";
  if (confidence >= 0.6) return "text-green-700";
  if (confidence >= 0.4) return "text-amber-700";
  return "text-red-700";
}

function fmtTime(d: Date | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function totalMin(start: Date | null | undefined, end: Date | null | undefined): string {
  if (!start || !end) return "";
  const mins = Math.round((end.getTime() - start.getTime()) / 60000);
  return mins < 1 ? "< 1 min" : `${mins} min`;
}

export function AnalysisSection({
  offers,
  grades,
  siteNames,
  siteOptions,
  analyzing,
  analysisStartedAt,
  analysisCompletedAt,
  evidencePageCount,
  pagesProcessed,
  runAnalysisAction,
  canAnalyze,
}: {
  offers: Offer[];
  grades: ComplianceGrade[];
  siteNames: Record<string, string>;
  siteOptions: Pick<Site, "id" | "name">[];
  analyzing: boolean;
  analysisStartedAt?: Date | null;
  analysisCompletedAt?: Date | null;
  /** Total HTML snapshot pages this run captured — used for progress display. */
  evidencePageCount: number;
  /** Pages processed so far during an active analysis run. */
  pagesProcessed: number | null;
  runAnalysisAction: () => Promise<void>;
  canAnalyze: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [siteFilter, setSiteFilter] = useState<string>("all");

  const gradeByEvidence = new Map(grades.map((g) => [g.evidenceId, g.grade]));

  const visible =
    siteFilter === "all"
      ? offers
      : offers.filter((o) => o.siteId === siteFilter);

  return (
    <div className="rounded-lg border border-zinc-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setCollapsed((c) => !c)}
              className="text-xl font-semibold text-zinc-900 hover:text-zinc-600"
            >
              Analysis{" "}
              {offers.length > 0 && (
                <span className="font-normal text-zinc-500">
                  — {offers.length} offer{offers.length === 1 ? "" : "s"}
                  {siteFilter !== "all" && ` · ${visible.length} shown`}
                </span>
              )}
              <span className="ml-2 text-sm font-normal text-zinc-400">
                {collapsed ? "▸ expand" : "▾ collapse"}
              </span>
            </button>
            {!collapsed && offers.length > 0 && (
              <select
                value={siteFilter}
                onChange={(e) => setSiteFilter(e.target.value)}
                className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm text-zinc-700 focus:outline-none"
              >
                <option value="all">All sites</option>
                {siteOptions
                  .filter((s) => offers.some((o) => o.siteId === s.id))
                  .map((site) => (
                    <option key={site.id} value={site.id}>
                      {site.name}
                    </option>
                  ))}
              </select>
            )}
          </div>
          {analyzing ? (
            <div className="mt-1.5">
              <p className="text-sm text-zinc-500">
                {analysisStartedAt && <>Started {fmtTime(analysisStartedAt)} · </>}
                {evidencePageCount > 0 && pagesProcessed !== null
                  ? `Analyzing page ${pagesProcessed} of ${evidencePageCount} · ${offers.length} offer${offers.length !== 1 ? "s" : ""} found`
                  : evidencePageCount > 0
                    ? `${offers.length} offer${offers.length !== 1 ? "s" : ""} found so far · ${evidencePageCount} page${evidencePageCount !== 1 ? "s" : ""} to process`
                    : "Starting…"}
              </p>
              {evidencePageCount > 0 && pagesProcessed !== null && (
                <div className="mt-1.5 h-1.5 w-full max-w-sm rounded-full bg-zinc-100">
                  <div
                    className="h-1.5 rounded-full bg-zinc-400 transition-all duration-300"
                    style={{
                      width: `${Math.min(100, Math.round((pagesProcessed / evidencePageCount) * 100))}%`,
                    }}
                  />
                </div>
              )}
            </div>
          ) : (analysisStartedAt || analysisCompletedAt) ? (
            <p className="mt-1 text-sm text-zinc-500">
              {analysisStartedAt && <>Started {fmtTime(analysisStartedAt)}</>}
              {analysisCompletedAt && <> · Completed {fmtTime(analysisCompletedAt)}</>}
              {totalMin(analysisStartedAt, analysisCompletedAt) && (
                <> · {totalMin(analysisStartedAt, analysisCompletedAt)}</>
              )}
            </p>
          ) : null}
        </div>
        {canAnalyze && (
          <form action={runAnalysisAction}>
            <button
              type="submit"
              disabled={analyzing}
              className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {analyzing
                ? "Analyzing…"
                : offers.length > 0
                  ? "Re-run Analysis"
                  : "Run Analysis"}
            </button>
          </form>
        )}
      </div>

      {!collapsed && (
        <>
          {offers.length === 0 ? (
            <p className="px-4 py-6 text-sm text-zinc-500">
              No offers extracted yet. Run analysis once the run has captured
              evidence.
            </p>
          ) : visible.length === 0 ? (
            <p className="px-4 py-6 text-sm text-zinc-500">
              No offers for the selected site.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-zinc-100 text-xs uppercase tracking-wide text-zinc-500">
                    {siteFilter === "all" && (
                      <th className="px-4 py-2 font-medium">Site</th>
                    )}
                    <th className="px-4 py-2 font-medium">Type</th>
                    <th className="px-4 py-2 font-medium">Vehicle</th>
                    <th className="px-4 py-2 font-medium">Payment</th>
                    <th className="px-4 py-2 font-medium">APR</th>
                    <th className="px-4 py-2 font-medium">Term</th>
                    <th className="px-4 py-2 font-medium">Due</th>
                    <th className="px-4 py-2 font-medium">Cash</th>
                    <th className="px-4 py-2 font-medium">Conf.</th>
                    <th className="px-4 py-2 font-medium">Compliance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {visible.map((offer) => {
                    const grade = offer.sourceEvidenceId
                      ? gradeByEvidence.get(offer.sourceEvidenceId)
                      : undefined;
                    const vehicle = [
                      offer.vehicleMake,
                      offer.vehicleModel,
                      offer.vehicleTrim,
                    ]
                      .filter(Boolean)
                      .join(" ");
                    return (
                      <tr key={offer.id}>
                        {siteFilter === "all" && (
                          <td className="px-4 py-3 text-zinc-900">
                            {siteNames[offer.siteId] ?? "—"}
                          </td>
                        )}
                        <td className="px-4 py-3 text-zinc-700">
                          {OFFER_TYPE_LABELS[offer.offerType]}
                        </td>
                        <td className="px-4 py-3 text-zinc-700">
                          {vehicle || "—"}
                        </td>
                        <td className="px-4 py-3 text-zinc-700">
                          {offer.monthlyPayment === null
                            ? "—"
                            : `${money(offer.monthlyPayment)}/mo`}
                        </td>
                        <td className="px-4 py-3 text-zinc-700">
                          {offer.apr === null ? "—" : `${offer.apr}%`}
                        </td>
                        <td className="px-4 py-3 text-zinc-700">
                          {offer.termMonths === null
                            ? "—"
                            : `${offer.termMonths} mo`}
                        </td>
                        <td className="px-4 py-3 text-zinc-700">
                          {money(offer.dueAtSigning)}
                        </td>
                        <td className="px-4 py-3 text-zinc-700">
                          {money(offer.cashIncentive)}
                        </td>
                        <td
                          className={`px-4 py-3 font-medium ${confidenceStyle(offer.confidence)}`}
                        >
                          {offer.confidence === null
                            ? "—"
                            : `${Math.round(offer.confidence * 100)}%`}
                          {(
                            offer.normalizedJson as {
                              aiAssisted?: boolean;
                            } | null
                          )?.aiAssisted && (
                            <span
                              className="ml-1 rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-violet-700"
                              title="Corrected by the AI analysis pass"
                            >
                              AI
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {grade ? (
                            <span
                              className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${gradeStyle(grade)}`}
                            >
                              {grade}
                            </span>
                          ) : (
                            <span className="text-xs text-zinc-400">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
