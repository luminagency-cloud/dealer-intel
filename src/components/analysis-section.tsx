"use client";

import { useState } from "react";
import { OFFER_TYPE_LABELS, type ComplianceGrade, type Offer, type Site } from "@/lib/db";
import { ComplianceGradeBadge } from "@/components/compliance-grade-badge";
import { fmtMileage } from "@/lib/report";

function money(value: number | null): string {
  return value === null ? "—" : `$${value.toLocaleString()}`;
}

function confidenceStyle(confidence: number | null): string {
  if (confidence === null) return "text-zinc-700";
  if (confidence >= 0.6) return "text-green-700";
  if (confidence >= 0.4) return "text-amber-700";
  return "text-red-700";
}

/** How a service coupon read from an image was verified against its alt text.
 *  "corroborated" is trusted; the others are worth a human glance at the ad. */
type CouponVerify = "ocr_only" | "alt_only" | "mismatch";

function couponVerify(offer: Offer): CouponVerify | null {
  const nj = offer.normalizedJson as { matches?: { verify?: string }; reviewed?: boolean } | null;
  // A "passed" (human-reviewed) offer no longer flags, even if uncertain.
  if (nj?.reviewed) return null;
  const v = nj?.matches?.verify;
  return v === "ocr_only" || v === "alt_only" || v === "mismatch" ? v : null;
}

const VERIFY_LABEL: Record<CouponVerify, string> = {
  mismatch: "check",
  ocr_only: "unconfirmed",
  alt_only: "unconfirmed",
};

function verifyTitle(offer: Offer, v: CouponVerify): string {
  const nj = offer.normalizedJson as { matches?: { ocrValue?: string; altValue?: string } } | null;
  if (v === "mismatch") {
    return `The coupon image and its alt text disagree — image read "${nj?.matches?.ocrValue ?? "?"}", alt said "${nj?.matches?.altValue ?? "?"}". Showing the image read; check the ad.`;
  }
  if (v === "ocr_only") return "Read from the coupon image; no alt text to confirm it. Glance at the ad if it looks off.";
  return "Read from alt text only (no image read available); can be stale. Glance at the ad if it looks off.";
}

const TYPE_ORDER: Record<string, number> = {
  lease: 0,
  finance: 1,
  cash: 2,
  service: 3,
  promotional: 4,
};

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
  resumeAnalysisAction,
  passOfferAction,
  deleteOfferAction,
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
  resumeAnalysisAction?: () => Promise<void>;
  passOfferAction: (offerId: string) => Promise<void>;
  deleteOfferAction: (offerId: string) => Promise<void>;
  canAnalyze: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [siteFilter, setSiteFilter] = useState<string>("all");
  // Default to sorted once analysis is complete; unsorted while it's running so
  // new rows appear at the bottom as they arrive.
  const [sorted, setSorted] = useState(!analyzing);

  const gradeByEvidence = new Map(grades.map((g) => [g.evidenceId, g]));

  const filtered =
    siteFilter === "all"
      ? offers
      : offers.filter((o) => o.siteId === siteFilter);

  const visible = sorted
    ? [...filtered].sort((a, b) => {
        const nameA = siteNames[a.siteId] ?? "";
        const nameB = siteNames[b.siteId] ?? "";
        if (nameA !== nameB) return nameA.localeCompare(nameB);
        return (TYPE_ORDER[a.offerType] ?? 99) - (TYPE_ORDER[b.offerType] ?? 99);
      })
    : filtered;

  // Image-coupon offers whose read wasn't corroborated — a glance-if-curious
  // count, never a gate. Scoped to the current site filter.
  const uncertainCount = filtered.filter((o) => couponVerify(o) !== null).length;

  return (
    <div className="rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-700 dark:bg-zinc-900">
      <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setCollapsed((c) => !c)}
              className="text-xl font-semibold text-zinc-900 hover:text-zinc-600 dark:text-zinc-100 dark:hover:text-zinc-200"
            >
              Analysis{" "}
              {offers.length > 0 && (
                <span className="font-normal text-zinc-700 dark:text-zinc-200">
                  — {offers.length} offer{offers.length === 1 ? "" : "s"}
                  {siteFilter !== "all" && ` · ${filtered.length} shown`}
                  {uncertainCount > 0 && (
                    <span className="text-amber-700 dark:text-amber-500">
                      {" · "}{uncertainCount} to check
                    </span>
                  )}
                </span>
              )}
              <span className="ml-2 text-sm font-normal text-zinc-700">
                {collapsed ? "▸ expand" : "▾ collapse"}
              </span>
            </button>
            {!collapsed && offers.length > 0 && (
              <>
                <select
                  value={siteFilter}
                  onChange={(e) => setSiteFilter(e.target.value)}
                  className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm text-zinc-700 focus:outline-none dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200"
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
                <button
                  type="button"
                  onClick={() => setSorted((s) => !s)}
                  className={`rounded-md border px-2.5 py-1 text-sm transition-colors ${
                    sorted
                      ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                      : "border-zinc-300 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
                  }`}
                >
                  Dealer &amp; Type
                </button>
              </>
            )}
          </div>
          {analyzing ? (
            <div className="mt-1.5">
              <p className="text-sm text-zinc-700 dark:text-zinc-200">
                {analysisStartedAt && <>Started {fmtTime(analysisStartedAt)} · </>}
                {evidencePageCount > 0 && pagesProcessed !== null
                  ? `Analyzing item ${pagesProcessed} of ${evidencePageCount} · ${offers.length} offer${offers.length !== 1 ? "s" : ""} found`
                  : evidencePageCount > 0
                    ? `${offers.length} offer${offers.length !== 1 ? "s" : ""} found so far · ${evidencePageCount} page${evidencePageCount !== 1 ? "s" : ""} to process`
                    : "Starting…"}
              </p>
              {evidencePageCount > 0 && pagesProcessed !== null && (
                <div className="mt-1.5 h-1.5 w-full max-w-sm rounded-full bg-zinc-100 dark:bg-zinc-800">
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
            <p className="mt-1 text-sm text-zinc-700">
              {analysisStartedAt && <>Started {fmtTime(analysisStartedAt)}</>}
              {analysisCompletedAt && <> · Completed {fmtTime(analysisCompletedAt)}</>}
              {totalMin(analysisStartedAt, analysisCompletedAt) && (
                <> · {totalMin(analysisStartedAt, analysisCompletedAt)}</>
              )}
            </p>
          ) : null}
        </div>
        {canAnalyze && (
          <div className="flex items-center gap-2">
            {resumeAnalysisAction && !analyzing && analysisStartedAt && !analysisCompletedAt && offers.length > 0 && (
              <form action={resumeAnalysisAction}>
                <button
                  type="submit"
                  className="rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-500"
                >
                  Resume Analysis
                </button>
              </form>
            )}
            <form action={runAnalysisAction}>
              <button
                type="submit"
                disabled={analyzing}
                className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                {analyzing
                  ? "Analyzing…"
                  : offers.length > 0
                    ? "Re-run Analysis"
                    : "Run Analysis"}
              </button>
            </form>
          </div>
        )}
      </div>

      {!collapsed && (
        <>
          {offers.length === 0 ? (
            <p className="px-4 py-6 text-sm text-zinc-700">
              No offers extracted yet. Run analysis once the run has captured
              evidence.
            </p>
          ) : visible.length === 0 ? (
            <p className="px-4 py-6 text-sm text-zinc-700">
              No offers for the selected site.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <colgroup>
                  {siteFilter === "all" && <col style={{ width: "14%" }} />}
                  <col style={{ width: "80px" }} />
                  <col />
                  <col style={{ width: "100px" }} />
                  <col style={{ width: "70px" }} />
                  <col style={{ width: "72px" }} />
                  <col style={{ width: "80px" }} />
                  <col style={{ width: "90px" }} />
                  <col style={{ width: "80px" }} />
                  <col style={{ width: "90px" }} />
                  <col style={{ width: "110px" }} />
                  <col style={{ width: "70px" }} />
                </colgroup>
                <thead>
                  <tr className="border-b border-zinc-100 text-xs uppercase tracking-wide text-zinc-700 dark:border-zinc-800 dark:text-zinc-200">
                    {siteFilter === "all" && (
                      <th className="px-4 py-2 font-medium">Site</th>
                    )}
                    <th className="px-4 py-2 font-medium">Type</th>
                    <th className="px-4 py-2 font-medium">Vehicle</th>
                    <th className="px-4 py-2 font-medium">Payment</th>
                    <th className="px-4 py-2 font-medium">APR</th>
                    <th className="px-4 py-2 font-medium">Term</th>
                    <th className="px-4 py-2 font-medium">Due</th>
                    <th className="px-4 py-2 font-medium">Mi/Yr</th>
                    <th className="px-4 py-2 font-medium">Cash</th>
                    <th className="px-4 py-2 font-medium">Conf.</th>
                    <th className="px-4 py-2 font-medium">Compliance</th>
                    <th className="px-4 py-2 font-medium">Ad</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {visible.map((offer) => {
                    const compliance = offer.sourceEvidenceId
                      ? gradeByEvidence.get(offer.sourceEvidenceId)
                      : undefined;
                    const vehicle = [
                      offer.vehicleMake,
                      offer.vehicleModel,
                      offer.vehicleTrim,
                    ]
                      .filter(Boolean)
                      .join(" ");
                    const isPromotional = offer.offerType === "promotional";
                    const nJson = offer.normalizedJson as { aiAssisted?: boolean; source?: string } | null;
                    const isImagePromo = isPromotional && nJson?.source === "image_extraction";
                    const verify = couponVerify(offer);
                    return (
                      <tr key={offer.id} className={isPromotional ? "bg-amber-50 dark:bg-amber-950/30" : ""}>
                        {siteFilter === "all" && (
                          <td className="px-4 py-3 text-zinc-900 dark:text-zinc-100">
                            {siteNames[offer.siteId] ?? "—"}
                          </td>
                        )}
                        <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">
                          <span>{OFFER_TYPE_LABELS[offer.offerType]}</span>
                          {isImagePromo && (
                            <span
                              className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-amber-700"
                              title="AI scanned this ad image and found no pricing terms"
                            >
                              no price
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">
                          {offer.offerType === "service"
                            ? (offer.rawText || "—")
                            : isImagePromo
                              ? <span className="italic text-zinc-400">see ad image →</span>
                              : (vehicle || "—")}
                        </td>
                        <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">
                          {offer.offerType === "service"
                            ? ((offer.normalizedJson as { matches?: { serviceOffer?: string } } | null)?.matches?.serviceOffer ?? "—")
                            : offer.monthlyPayment !== null
                              ? `${money(offer.monthlyPayment)}/mo`
                              : offer.salePrice !== null
                                ? money(offer.salePrice)
                                : "—"}
                          {verify && (
                            <span
                              className={`ml-1.5 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${
                                verify === "mismatch"
                                  ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400"
                                  : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400"
                              }`}
                              title={verifyTitle(offer, verify)}
                            >
                              {VERIFY_LABEL[verify]}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">
                          {offer.apr === null ? "—" : `${offer.apr}%`}
                        </td>
                        <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">
                          {offer.termMonths === null
                            ? "—"
                            : `${offer.termMonths} mo`}
                        </td>
                        <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">
                          {money(offer.dueAtSigning)}
                        </td>
                        <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">
                          {offer.mileageAllowance === null
                            ? "—"
                            : fmtMileage(offer.mileageAllowance)}
                        </td>
                        <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">
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
                          {compliance ? (
                            <ComplianceGradeBadge
                              grade={compliance.grade}
                              details={compliance.detailsJson}
                            />
                          ) : (
                            <span className="text-xs text-zinc-700">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            {offer.sourceEvidenceId ? (
                              <a
                                href={`/api/evidence/${offer.sourceEvidenceId}/file`}
                                target="_blank"
                                rel="noreferrer"
                                className="text-xs text-zinc-900 underline hover:text-zinc-600 dark:text-zinc-100 dark:hover:text-zinc-200"
                              >
                                View ad
                              </a>
                            ) : (
                              <span className="text-xs text-zinc-400">—</span>
                            )}
                            {/* Pass clears a flag, so it only applies to a
                                flagged (coupon) offer. */}
                            {verify && (
                              <form action={async () => { await passOfferAction(offer.id); }}>
                                <button
                                  type="submit"
                                  className="text-xs font-medium text-green-700 underline hover:text-green-600 dark:text-green-500"
                                  title="Passed inspection — keep it in the report and stop flagging it"
                                >
                                  Pass
                                </button>
                              </form>
                            )}
                            {/* Delete is available on EVERY offer, not just
                                flagged coupons, so low-confidence junk can be
                                pulled by hand before it reaches a report. */}
                            <form action={async () => { await deleteOfferAction(offer.id); }}>
                              <button
                                type="submit"
                                className="text-xs font-medium text-red-700 underline hover:text-red-600 dark:text-red-500"
                                title="Delete this offer so it can't reach a report"
                              >
                                Delete
                              </button>
                            </form>
                          </div>
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
