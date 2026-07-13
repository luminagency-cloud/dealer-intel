"use client";

import React from "react";

/**
 * Competitive Market Analysis — full report UI (Phase 11 v2).
 *
 * Rendered server-side by both the standalone /r/[id] route (shareable, no
 * auth) and the admin /reports/[id] view. The component is "use client" only
 * for the copy-link button; everything else is static markup.
 */

import {
  buildGrid,
  cashNarrative,
  computeKpis,
  financeNarrative,
  fmtApr,
  fmtMileage,
  fmtMoney,
  leaseNarrative,
  parseMileage,
  rankBgClass,
  serviceNarrative,
  type DealerCol,
  type GridRow,
} from "@/lib/report";
import type { InventoryResult, ReportSnapshot, SnapshotOffer } from "@/lib/db";
import type { NewsData, NewsItem } from "@/lib/news";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ReportContentProps {
  snapshot: ReportSnapshot;
  offers: SnapshotOffer[];
  primarySiteIds: Set<string>;
  groupSnapshots?: ReportSnapshot[];
  /** News data from the autos.media news service. Null = service not yet
   *  connected; shows a placeholder. */
  news?: NewsData | null;
  /** Latest inventory result per site, used for the Inventory Snapshot section. */
  inventoryData?: InventoryResult[];
  /** When true, show admin-only controls (Copy Link, Export CSV). */
  adminControls?: boolean;
  /** Absolute public shareable link for the "Copy shareable link" control.
   *  Omitted when a public viewer origin or share token is not available. */
  shareUrl?: string;
  /** Short disabled-state label explaining why no public link can be copied. */
  shareUrlUnavailableLabel?: string;
  /** Tailwind classes for the outermost wrapper div. Defaults to
   *  "mx-auto max-w-6xl px-4 py-8" (suitable for the standalone public route).
   *  Override in admin context where the layout already provides padding. */
  containerClassName?: string;
}

// ---------------------------------------------------------------------------
// Helper sub-components
// ---------------------------------------------------------------------------

const REPORT_PANEL_CLASS =
  "overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-700 dark:bg-zinc-950";
const REPORT_CARD_CLASS =
  "rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-700 dark:bg-zinc-950";
const REPORT_EMPTY_CLASS =
  "rounded-xl border border-zinc-200 bg-white p-6 text-base font-semibold text-black shadow-sm dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50";
const REPORT_HEADLINE_CLASS =
  "text-base font-semibold leading-snug text-black dark:text-zinc-50";
const REPORT_BODY_CLASS = "text-base text-black dark:text-zinc-50";
const REPORT_META_CLASS = "text-sm font-semibold text-zinc-900 dark:text-zinc-100";
const REPORT_LABEL_CLASS =
  "text-sm font-bold uppercase tracking-wide text-zinc-900 dark:text-zinc-100";
const REPORT_LINK_CLASS =
  "text-sm font-semibold text-blue-700 hover:underline dark:text-blue-300";
const REPORT_BORDER_CLASS = "border-zinc-200 dark:border-zinc-800";

function SectionHeading({
  num,
  title,
  sub,
  id,
}: {
  num?: string;
  title: string;
  sub?: string;
  id?: string;
}) {
  return (
    <div id={id} className="mb-3">
      <h2 className="flex items-baseline gap-2 text-xl font-bold text-[#1b3a6b] dark:text-blue-300">
        {num && (
          <span className="text-[#1b3a6b] dark:text-blue-300">{num} ·</span>
        )}
        {title}
      </h2>
      {sub && <p className="mt-0.5 text-base text-black dark:text-zinc-50">{sub}</p>}
    </div>
  );
}

function Narrative({ text }: { text: string }) {
  if (!text) return null;
  return (
    <div className="mt-3 rounded-md border-l-4 border-[#1b3a6b] bg-blue-50 px-4 py-3 text-base text-black dark:border-blue-400 dark:bg-blue-950/40 dark:text-zinc-50">
      {text}
    </div>
  );
}

// "Not Advertised" cell style
const NA_CLASS =
  "text-sm font-semibold italic text-zinc-900 text-center dark:text-zinc-100";

function rankClass(rank: number | null, total: number): string {
  return rankBgClass(rank, total);
}

// ---------------------------------------------------------------------------
// Grid table component
// ---------------------------------------------------------------------------

interface GridTableProps {
  dealers: DealerCol[];
  rows: GridRow[];
  renderCell: (
    cell: GridRow["cells"][number],
    offer: SnapshotOffer
  ) => React.ReactNode;
  emptyLabel?: string;
  disableRanking?: boolean;
}

function GridTable({
  dealers,
  rows,
  renderCell,
  emptyLabel = "Not Advertised",
  disableRanking = false,
}: GridTableProps) {
  if (rows.length === 0) {
    return (
      <p className="py-4 text-base font-semibold text-black dark:text-zinc-50">No offers captured.</p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-base" style={{ tableLayout: "fixed" }}>
        <colgroup>
          <col style={{ width: "160px" }} />
          {dealers.map((d) => (
            <col key={d.siteId ?? d.siteName} style={{ width: "120px" }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th className="border border-zinc-200 bg-zinc-100 px-3 py-2 text-left text-sm font-bold uppercase tracking-wide text-zinc-900 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-50">
              Model
            </th>
            {dealers.map((d) => (
              <th
                key={d.siteId ?? d.siteName}
                className={`border border-zinc-200 px-2 py-2 text-center text-sm font-bold uppercase tracking-wide dark:border-zinc-800 ${
                  d.isPrimary
                    ? "bg-[#1b5e3b] text-white"
                    : "bg-zinc-800 text-white dark:bg-zinc-700"
                }`}
              >
                {d.siteName}
                {d.isPrimary && (
                  <span className="ml-1 text-yellow-300">★</span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.vehicleModel}>
              <td className="border border-zinc-200 bg-zinc-50 px-3 py-2 font-semibold text-black dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-50">
                {row.vehicleModel}
              </td>
              {row.cells.map((cell, i) => {
                const bg = rankClass(cell.rank, cell.totalRanked);
                return (
                  <td
                    key={dealers[i].siteId ?? dealers[i].siteName}
                    className={`border border-zinc-200 px-3 py-2 text-center align-top text-black dark:border-zinc-800 dark:text-zinc-50 ${disableRanking ? "" : bg}`}
                  >
                    {cell.offer ? (
                      <div className="space-y-0.5">
                        {renderCell(cell, cell.offer)}
                        {cell.trimMismatch && cell.displayTrim && (
                          <div>
                            <span className="inline-block rounded bg-amber-100 px-1.5 py-0.5 text-xs font-bold uppercase tracking-wide text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                              TRIM: {cell.displayTrim}
                            </span>
                          </div>
                        )}
                      </div>
                    ) : (
                      <span className={NA_CLASS}>{emptyLabel}</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

function GridLegend({ hasRanking }: { hasRanking: boolean }) {
  if (!hasRanking) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
      <span className="font-medium">Key:</span>
      <span className="flex items-center gap-1">
        <span className="inline-block h-3 w-3 rounded bg-emerald-700" /> 1st
      </span>
      <span className="flex items-center gap-1">
        <span className="inline-block h-3 w-3 rounded bg-emerald-500" /> 2nd
      </span>
      <span className="flex items-center gap-1">
        <span className="inline-block h-3 w-3 rounded bg-amber-500" /> 3rd
      </span>
      <span className="flex items-center gap-1">
        <span className="inline-block h-3 w-3 rounded bg-orange-500" /> 4th
      </span>
      <span className="flex items-center gap-1">
        <span className="inline-block h-3 w-3 rounded bg-red-600" /> Last
      </span>
      <span className="italic">Not Advertised</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Brand news section
// ---------------------------------------------------------------------------

const CATEGORY_LABELS: Record<NewsItem["category"], string> = {
  recall: "Recall",
  new_model: "New Model",
  sales: "Sales",
  regulatory: "Regulatory",
  workforce: "Workforce",
  incentives: "Incentives",
  industry: "Industry",
};

const CATEGORY_COLORS: Record<NewsItem["category"], string> = {
  recall: "bg-red-700 text-white",
  new_model: "bg-[#1b3a6b] text-white",
  regulatory: "bg-amber-700 text-white",
  sales: "bg-emerald-700 text-white",
  workforce: "bg-zinc-600 text-white",
  incentives: "bg-indigo-700 text-white",
  industry: "bg-zinc-500 text-white",
};

function NewsCard({ item }: { item: NewsItem }) {
  return (
    <div className={`flex gap-4 p-4 ${REPORT_CARD_CLASS}`}>
      <div className="flex-shrink-0">
        <span
          className={`inline-flex items-center justify-center rounded px-2 py-1 text-xs font-bold uppercase tracking-wider ${CATEGORY_COLORS[item.category]}`}
          style={{ minWidth: "4.5rem", textAlign: "center" }}
        >
          {CATEGORY_LABELS[item.category]}
        </span>
      </div>
      <div className="min-w-0">
        <a
          href={item.source_url}
          target="_blank"
          rel="noreferrer"
          className="font-semibold text-zinc-900 hover:text-[#1b3a6b] hover:underline"
        >
          {item.headline}
        </a>
        <p className={`mt-1 ${REPORT_BODY_CLASS}`}>{item.summary}</p>
      </div>
    </div>
  );
}

function ReturnToSummary() {
  return (
    <div className="mt-4 text-right">
      <a href="#summary" className={REPORT_LINK_CLASS}>
        ↑ Return to summary
      </a>
    </div>
  );
}

function BrandNewsSection({ news, brand }: { news: NewsData | null | undefined; brand?: string }) {
  const brandLabel = brand
    ? `Current ${brand} developments relevant to this dealer group.`
    : "Current brand developments relevant to this dealer group.";

  const items = news
    ? [...news.brand_items, ...news.industry_items].slice(0, 4)
    : [];

  return (
    <section id="brand-news" className="mb-10">
      <SectionHeading num="1" title="Brand News" sub={news ? brandLabel : undefined} />
      {items.length > 0 ? (
        <div className="space-y-3">
          {items.map((item) => (
            <NewsCard key={item.id} item={item} />
          ))}
        </div>
      ) : (
        <div className="rounded-xl border-2 border-dashed border-zinc-300 bg-zinc-50 px-6 py-8 text-center text-base font-semibold text-black dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50">
          Brand &amp; industry news will appear here once the news service is connected.
        </div>
      )}
      <ReturnToSummary />
    </section>
  );
}

const GENERIC_SUMMARY_NOTES = new Set([
  "Compare advertised lease payments and terms below.",
  "Compare advertised finance rates below.",
  "Compare advertised cash discounts and rebates below.",
]);

const GRADE_VALUES: Record<string, number> = {
  "a+": 12,
  a: 11,
  "a-": 10,
  "b+": 9,
  b: 8,
  "b-": 7,
  "c+": 6,
  c: 5,
  "c-": 4,
  "d+": 3,
  d: 2,
  "d-": 1,
  f: 0,
  pass: 11,
  fail: 0,
};

const VALUE_GRADES = [
  "F",
  "D-",
  "D",
  "D+",
  "C-",
  "C",
  "C+",
  "B-",
  "B",
  "B+",
  "A-",
  "A",
  "A+",
];

function isMeaningfulSummaryNote(text: string): boolean {
  return Boolean(text && !GENERIC_SUMMARY_NOTES.has(text));
}

function cleanComplianceGrades(offers: SnapshotOffer[]): SnapshotOffer[] {
  return offers.filter((o) => {
    const grade = o.complianceGrade?.toLowerCase();
    return Boolean(
      grade &&
        o.offerType !== "service" &&
        grade !== "n/a" &&
        grade !== "err" &&
        GRADE_VALUES[grade] !== undefined
    );
  });
}

function averageComplianceGrade(offers: SnapshotOffer[]): string | null {
  const graded = cleanComplianceGrades(offers);
  if (graded.length === 0) return null;
  const avg =
    graded.reduce((sum, offer) => {
      const grade = offer.complianceGrade?.toLowerCase() ?? "";
      return sum + GRADE_VALUES[grade];
    }, 0) / graded.length;
  return VALUE_GRADES[Math.max(0, Math.min(12, Math.round(avg)))] ?? null;
}

function ServiceDealerCard({
  dealer,
  offers,
  emptyLabel,
}: {
  dealer: DealerCol;
  offers: SnapshotOffer[];
  emptyLabel: string;
}) {
  const usesOfferGrid = offers.length > 1;
  const finalGridRowStart = offers.length % 2 === 0
    ? offers.length - 2
    : offers.length - 1;

  return (
    <div className="mb-4 break-inside-avoid overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-700 dark:bg-zinc-950">
      <div
        className={`px-4 py-2.5 text-base font-semibold ${
          dealer.isPrimary
            ? "bg-[#1b5e3b] text-white"
            : "bg-zinc-800 text-white dark:bg-zinc-700"
        }`}
      >
        {dealer.siteName}
        {dealer.isPrimary && <span className="ml-1 text-yellow-300">★</span>}
      </div>
      {offers.length === 0 ? (
        <p className="px-4 py-3 text-sm font-semibold italic text-black dark:text-zinc-50">
          {emptyLabel}
        </p>
      ) : (
        <ul className={usesOfferGrid ? "grid grid-flow-row sm:grid-cols-2" : ""}>
          {offers.map((o, index) => {
            const matchMap = (
              o.normalizedJson as { matches?: Record<string, string> } | null
            )?.matches ?? {};
            const isLast = index === offers.length - 1;
            const isInFinalGridRow = usesOfferGrid && index >= finalGridRowStart;
            return (
              <li
                key={o.id}
                className={`border-b border-zinc-200 px-4 py-3 dark:border-zinc-800 ${
                  isLast ? "border-b-0" : ""
                } ${isInFinalGridRow ? "sm:border-b-0" : ""}`}
              >
                <div className="text-base font-semibold leading-snug text-black dark:text-zinc-50">
                  {o.rawText ?? "Service Special"}
                </div>
                {o.cashIncentive != null ? (
                  <div className="mt-1 text-sm font-semibold text-emerald-700 dark:text-emerald-300">
                    {fmtMoney(o.cashIncentive)} off
                  </div>
                ) : matchMap.serviceOffer ? (
                  <div className="mt-1 text-sm font-semibold text-emerald-700 dark:text-emerald-300">
                    {matchMap.serviceOffer}
                  </div>
                ) : null}
                {(o.evidenceUrl ?? o.sourceEvidenceId) && (
                  <a
                    href={o.evidenceUrl ?? `/api/evidence/${o.sourceEvidenceId}/file`}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 block text-sm font-semibold text-blue-700 hover:underline dark:text-blue-300"
                  >
                    View ad
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Copy-link button (client interaction)
// ---------------------------------------------------------------------------

function CopyLinkButton({
  shareUrl,
  unavailableLabel = "Public link unavailable",
}: {
  shareUrl?: string;
  unavailableLabel?: string;
}) {
  const canCopy = Boolean(shareUrl);
  return (
    <button
      disabled={!canCopy}
      title={
        canCopy
          ? "Copy public report link"
          : unavailableLabel
      }
      onClick={() => {
        if (!shareUrl) return;
        void navigator.clipboard.writeText(shareUrl);
        const btn = document.getElementById("copy-link-btn");
        if (btn) {
          btn.textContent = "Copied!";
          setTimeout(() => {
            btn.textContent = "Copy shareable link";
          }, 2000);
        }
      }}
      id="copy-link-btn"
      className="rounded-md border border-white bg-white px-3 py-1.5 text-sm font-semibold text-[#12315c] shadow-sm hover:bg-blue-50 disabled:cursor-not-allowed disabled:border-blue-200 disabled:bg-blue-100 disabled:text-blue-500 disabled:shadow-none"
    >
      {canCopy ? "Copy shareable link" : unavailableLabel}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function ReportContent({
  snapshot,
  offers,
  primarySiteIds,
  groupSnapshots = [],
  news,
  inventoryData = [],
  adminControls = false,
  shareUrl,
  shareUrlUnavailableLabel,
  containerClassName = "mx-auto max-w-6xl px-4 py-8",
}: ReportContentProps) {
  // ---------------------------------------------------------------------------
  // Dealers ordered: primary first, then alpha
  // ---------------------------------------------------------------------------
  const dealerMap = new Map<string, DealerCol>();
  for (const o of offers) {
    const key = o.siteId ?? o.siteName;
    if (!dealerMap.has(key)) {
      dealerMap.set(key, {
        siteId: o.siteId,
        siteName: o.siteName,
        isPrimary: Boolean(o.siteId && primarySiteIds.has(o.siteId)),
      });
    }
  }
  const dealers = [...dealerMap.values()].sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    return a.siteName.localeCompare(b.siteName);
  });

  const anchor = dealers.find((d) => d.isPrimary);
  const anchorSiteIds = new Set(
    dealers
      .filter((d) => d.isPrimary && d.siteId)
      .map((d) => d.siteId!)
  );

  // ---------------------------------------------------------------------------
  // Partition offers by type
  // ---------------------------------------------------------------------------
  const leaseOffers = offers.filter((o) => o.offerType === "lease");
  const financeOffers = offers.filter(
    (o) =>
      o.offerType === "finance" &&
      o.apr !== null
  );
  const cashOffers = offers.filter((o) => o.offerType === "cash");
  const serviceOffers = offers.filter((o) => o.offerType === "service");
  const serviceOffersByDealer = new Map<string, SnapshotOffer[]>();
  for (const offer of serviceOffers) {
    const key = offer.siteId ?? offer.siteName;
    const dealerOffers = serviceOffersByDealer.get(key);
    if (dealerOffers) {
      dealerOffers.push(offer);
    } else {
      serviceOffersByDealer.set(key, [offer]);
    }
  }

  // ---------------------------------------------------------------------------
  // Build grids
  // ---------------------------------------------------------------------------
  const leaseGrid = buildGrid(
    dealers,
    leaseOffers,
    (o) => o.monthlyPayment,
    "lower"
  );
  const financeGrid = buildGrid(dealers, financeOffers, (o) => o.apr, "lower");
  const cashGrid = buildGrid(
    dealers,
    cashOffers,
    (o) => o.cashIncentive,
    "higher"
  );

  // ---------------------------------------------------------------------------
  // KPIs (anchor dealer)
  // ---------------------------------------------------------------------------
  const kpis = computeKpis(offers, anchorSiteIds);

  // ---------------------------------------------------------------------------
  // Narratives
  // ---------------------------------------------------------------------------
  const leaseNote = leaseNarrative(dealers, leaseGrid);
  const financeNote = financeNarrative(dealers, financeGrid);
  const cashNote = cashNarrative(dealers, cashGrid);
  const anchorServiceCount = serviceOffers.filter(
    (o) => o.siteId && anchorSiteIds.has(o.siteId)
  ).length;
  const serviceNote = serviceNarrative(dealers, anchorServiceCount);

  // ---------------------------------------------------------------------------
  // Compliance roll-up (all offers, anchor only)
  // ---------------------------------------------------------------------------
  const complianceCounts = kpis.complianceCounts;
  // Exclude "n/a" (not-applicable offer types) and "Err" (grader failures) so
  // the compliance section only appears when real AdScore grades are present.
  // A failed grade is never shown to clients as if it were a real result.
  const realComplianceCounts = Object.fromEntries(
    Object.entries(complianceCounts).filter(
      ([g]) => g !== "n/a" && g.toLowerCase() !== "err"
    )
  );
  const hasCompliance = Object.keys(realComplianceCounts).length > 0;

  // ---------------------------------------------------------------------------
  // Inventory snapshot data
  // ---------------------------------------------------------------------------
  // Build a per-dealer inventory view by joining inventoryData to the dealers
  // list via siteId, then computing totals/makes/models from JSONB fields.
  interface InvMakeRow { make: string; inStock: number }
  interface InvModelRow { make: string; model: string; inStock: number }
  interface DealerInventory {
    siteId: string | null;
    siteName: string;
    isPrimary: boolean;
    totalUnits: number;
    makes: InvMakeRow[];
    models: InvModelRow[];
  }

  const dealerInventory: DealerInventory[] = dealers
    .map((d) => {
      const row = inventoryData.find((r) => r.siteId === d.siteId);
      if (!row) return null;
      const totals = row.totals as { inStock?: number; inTransit?: number } | null;
      const makeSubtotals = (row.makeSubtotals as Array<{ make: string; inStock?: number; inTransit?: number }> | null) ?? [];
      const models = (row.models as Array<{ make: string; model: string; inStock?: number; inTransit?: number }> | null) ?? [];
      return {
        siteId: d.siteId,
        siteName: d.siteName,
        isPrimary: d.isPrimary,
        totalUnits: (totals?.inStock ?? 0) + (totals?.inTransit ?? 0),
        makes: makeSubtotals.map((m) => ({ make: m.make, inStock: (m.inStock ?? 0) + (m.inTransit ?? 0) })),
        models: models.map((m) => ({ make: m.make, model: m.model, inStock: (m.inStock ?? 0) + (m.inTransit ?? 0) })),
      };
    })
    .filter(Boolean) as DealerInventory[];

  const hasInventory = dealerInventory.length > 0;

  // Summary stats
  const invTotalMarket = dealerInventory.reduce((s, d) => s + d.totalUnits, 0);
  const invMarketAvg = dealerInventory.length > 0 ? Math.round(invTotalMarket / dealerInventory.length) : 0;
  const invAnchor = dealerInventory.find((d) => d.isPrimary);
  const invAnchorUnits = invAnchor?.totalUnits ?? 0;
  const invSorted = [...dealerInventory].sort((a, b) => b.totalUnits - a.totalUnits);
  const invAnchorRank = invSorted.findIndex((d) => d.isPrimary) + 1;

  // All unique makes across the market
  const allMakes = [...new Set(dealerInventory.flatMap((d) => d.makes.map((m) => m.make)))].sort();

  // All unique models per make
  const allModelsByMake: Record<string, string[]> = {};
  for (const make of allMakes) {
    const models = [...new Set(dealerInventory.flatMap((d) => d.models.filter((m) => m.make === make).map((m) => m.model)))].sort();
    if (models.length > 0) allModelsByMake[make] = models;
  }

  // Per-model unit lookup: [siteId][make][model] = units
  const invModelLookup: Record<string, Record<string, Record<string, number>>> = {};
  for (const d of dealerInventory) {
    invModelLookup[d.siteName] = {};
    for (const m of d.models) {
      if (!invModelLookup[d.siteName][m.make]) invModelLookup[d.siteName][m.make] = {};
      invModelLookup[d.siteName][m.make][m.model] = (invModelLookup[d.siteName][m.make][m.model] ?? 0) + m.inStock;
    }
  }

  // Key takeaways (rule-based)
  function invTakeaways() {
    if (!invAnchor) return null;
    const leader = invSorted[0];
    const anchorModels = invAnchor.models;

    // Strength: models where anchor leads market
    const modelTotals = new Map<string, { leader: string; leaderN: number; anchorN: number }>();
    for (const make of allMakes) {
      for (const model of (allModelsByMake[make] ?? [])) {
        let leaderName = "";
        let leaderN = 0;
        const anchorN = invAnchor.models.find((m) => m.make === make && m.model === model)?.inStock ?? 0;
        for (const d of dealerInventory) {
          const n = d.models.find((m) => m.make === make && m.model === model)?.inStock ?? 0;
          if (n > leaderN) { leaderN = n; leaderName = d.siteName; }
        }
        modelTotals.set(`${make}|${model}`, { leader: leaderName, leaderN, anchorN });
      }
    }
    const anchorLeadModels = [...modelTotals.entries()]
      .filter(([, v]) => v.leader === invAnchor.siteName)
      .map(([k]) => k.split("|")[1]);

    const gapDealer = leader.isPrimary ? invSorted[1] : leader;
    const gap = gapDealer ? gapDealer.totalUnits - invAnchorUnits : 0;

    // Watch: make where gap is largest
    const makeGaps = invAnchor.makes.map((am) => {
      const leaderMakeN = Math.max(...dealerInventory.map((d) => d.makes.find((m) => m.make === am.make)?.inStock ?? 0));
      return { make: am.make, gap: leaderMakeN - am.inStock, leaderN: leaderMakeN, anchorN: am.inStock };
    }).sort((a, b) => b.gap - a.gap);

    return { anchorLeadModels, gapDealer, gap, makeGaps, anchorModels };
  }
  const invInsights = hasInventory ? invTakeaways() : null;

  // ---------------------------------------------------------------------------
  // Capture date
  // ---------------------------------------------------------------------------
  const captureDate = snapshot.approvedAt.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  // Competitor list for subtitle
  const competitorNames = dealers
    .filter((d) => !d.isPrimary)
    .map((d) => d.siteName);

  const anchorOffers = offers.filter((o) => o.siteId && anchorSiteIds.has(o.siteId));
  const competitorOffers = offers.filter((o) => !o.siteId || !anchorSiteIds.has(o.siteId));
  const anchorComplianceAverage = averageComplianceGrade(anchorOffers);
  const competitorComplianceAverage = averageComplianceGrade(competitorOffers);
  const complianceSummary =
    anchorComplianceAverage && competitorComplianceAverage
      ? `${anchor?.siteName ?? "Anchor"} average: ${anchorComplianceAverage}; competitor average: ${competitorComplianceAverage}.`
      : anchorComplianceAverage
        ? `${anchor?.siteName ?? "Anchor"} average: ${anchorComplianceAverage} across ${cleanComplianceGrades(anchorOffers).length} graded ads.`
        : null;
  const inventorySummary = hasInventory
    ? `${invAnchor?.siteName ?? "Anchor"} holds ${invAnchorUnits} units${
        invAnchorRank > 0
          ? `, ranked #${invAnchorRank} of ${dealerInventory.length}`
          : ""
      }; market average is ${invMarketAvg}.`
    : null;
  const summaryItems = [
    isMeaningfulSummaryNote(leaseNote)
      ? { href: "#lease", label: "Lease Specials", text: leaseNote }
      : null,
    isMeaningfulSummaryNote(financeNote)
      ? { href: "#finance", label: "Finance (APR)", text: financeNote }
      : null,
    isMeaningfulSummaryNote(cashNote)
      ? { href: "#cash", label: "Cash & Discounts", text: cashNote }
      : null,
    anchorServiceCount === 0 && serviceOffers.length > 0 && isMeaningfulSummaryNote(serviceNote)
      ? { href: "#service", label: "Service Specials", text: serviceNote }
      : null,
    inventorySummary
      ? { href: "#inventory", label: "Inventory Snapshot", text: inventorySummary }
      : null,
    hasCompliance && complianceSummary
      ? { href: "#compliance", label: "Ad Compliance", text: complianceSummary }
      : null,
  ].filter((item): item is { href: string; label: string; text: string } => Boolean(item));

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className={containerClassName}>
      {/* ------------------------------------------------------------------ */}
      {/* Report header                                                       */}
      {/* ------------------------------------------------------------------ */}
      <div className="mb-8 overflow-hidden rounded-xl bg-[#1b3a6b] text-white shadow-lg">
        <div className="px-8 py-8">
          <h1 className="text-3xl font-extrabold tracking-tight">
            Competitive Market Analysis
          </h1>
          {anchor && (
            <p className="mt-2 text-base font-semibold text-blue-100">
              {anchor.siteName} ★ vs.{" "}
              {competitorNames.join(", ") || "no competitors captured"}
            </p>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <span className="rounded-full border border-blue-300/60 bg-blue-800/40 px-3 py-1 text-sm font-semibold">
              {snapshot.runGroupName ?? "All sites"}
            </span>
            <span className="rounded-full border border-blue-300/60 bg-blue-800/40 px-3 py-1 text-sm font-semibold">
              {snapshot.label || `Snapshot ${snapshot.id.slice(0, 8)}`}
            </span>
            <span className="rounded-full border border-blue-300/60 bg-blue-800/40 px-3 py-1 text-sm font-semibold">
              Published {captureDate}
            </span>
          </div>
        </div>
        <div className="border-t border-blue-800/60 bg-blue-900/25 px-4 py-4 sm:px-8">
          <p className="whitespace-nowrap text-sm font-semibold text-blue-100">
            Current offers:{" "}
            <span className="text-white">Lease: {kpis.leaseModelCount}</span>
            <span className="mx-1 text-blue-300 sm:mx-2">|</span>
            <span className="text-white">Finance: {kpis.financeOfferCount}</span>
            <span className="mx-1 text-blue-300 sm:mx-2">|</span>
            <span className="text-white">Cash: {kpis.cashOfferCount}</span>
            <span className="mx-1 text-blue-300 sm:mx-2">|</span>
            <span className="text-white">Service: {kpis.serviceOfferCount}</span>
          </p>
        </div>
        {(adminControls || summaryItems.length > 0) && (
          <div className="border-t border-blue-800/60 px-4 py-5 sm:px-8">
            {adminControls && (
              <div className="mb-3 flex items-center justify-end gap-3">
                <CopyLinkButton
                  shareUrl={shareUrl}
                  unavailableLabel={shareUrlUnavailableLabel}
                />
                <a
                  href={`/reports/${snapshot.id}/export`}
                  className="rounded-md border border-blue-200 bg-[#12315c] px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-[#0f294e]"
                >
                  Export CSV
                </a>
              </div>
            )}
            {summaryItems.length > 0 && (
              <div id="summary" className="rounded-lg border border-blue-100 bg-white p-5 text-black shadow-sm dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50">
                <h2 className={`mb-3 ${REPORT_LABEL_CLASS}`}>
                  Key Takeaways
                </h2>
                <ul className="list-disc space-y-2 pl-5 text-base">
                  {summaryItems.map((item) => (
                    <li key={item.href}>
                      <a
                        href={item.href}
                        className="font-semibold text-blue-700 underline decoration-blue-300 underline-offset-2 hover:text-blue-900 dark:text-blue-300 dark:hover:text-blue-200"
                      >
                        {item.label}
                      </a>
                      <span className="text-black dark:text-zinc-50">: {item.text}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* 1 · Brand News                                                      */}
      {/* ------------------------------------------------------------------ */}
      <BrandNewsSection news={news} brand={news?.brand ?? undefined} />

      {/* ------------------------------------------------------------------ */}
      {/* 2 · Lease Specials                                                  */}
      {/* ------------------------------------------------------------------ */}
      <section id="lease" className="mb-10">
        <SectionHeading
          num="2"
          title="Lease Specials"
        />
        <div className={REPORT_PANEL_CLASS}>
          <div className="p-4">
            <GridTable
              dealers={dealers}
              rows={leaseGrid}
              disableRanking
              renderCell={(_cell, offer) => {
                const mileage =
                  parseMileage(offer.disclaimerText) ??
                  parseMileage(offer.rawText);
                const missingFields: string[] = [];
                if (offer.monthlyPayment === null) missingFields.push("payment");
                if (!offer.termMonths) missingFields.push("term");
                if (!mileage) missingFields.push("mileage");
                if (offer.dueAtSigning == null) missingFields.push("DAS");
                return (
                  <>
                    {offer.monthlyPayment !== null && (
                      <div className={REPORT_HEADLINE_CLASS}>
                        {fmtMoney(offer.monthlyPayment)}/mo
                      </div>
                    )}
                    <div className={REPORT_META_CLASS}>
                      {[
                        offer.termMonths ? `${offer.termMonths} mo` : null,
                        mileage ? fmtMileage(mileage) : null,
                        offer.dueAtSigning != null
                          ? `${fmtMoney(offer.dueAtSigning)} DAS`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                    {missingFields.length > 0 && (
                      <div className="mt-1 text-sm font-semibold text-amber-700 dark:text-amber-300">
                        missing: {missingFields.join(", ")}
                      </div>
                    )}
                    {(offer.evidenceUrl ?? offer.sourceEvidenceId) && (
                      <a
                        href={offer.evidenceUrl ?? `/api/evidence/${offer.sourceEvidenceId}/file`}
                        target="_blank"
                        rel="noreferrer"
                        className={REPORT_LINK_CLASS}
                      >
                        View ad ↗
                      </a>
                    )}
                  </>
                );
              }}
            />
          </div>
        </div>
        <ReturnToSummary />
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* 3 · Finance (APR) Specials                                          */}
      {/* ------------------------------------------------------------------ */}
      <section id="finance" className="mb-10">
        <SectionHeading
          num="3"
          title="Finance (APR) Specials"
          sub="Advertised APR per model. Term length varies and is shown in each cell."
        />
        <div className={REPORT_PANEL_CLASS}>
          <div className="p-4">
            <GridTable
              dealers={dealers}
              rows={financeGrid}
              disableRanking
              renderCell={(_cell, offer) => (
                <>
                  {offer.apr !== null && (
                    <div className={REPORT_HEADLINE_CLASS}>{fmtApr(offer.apr)}</div>
                  )}
                  {offer.termMonths && (
                    <div className={REPORT_META_CLASS}>{offer.termMonths} mo</div>
                  )}
                </>
              )}
            />
          </div>
        </div>
        <ReturnToSummary />
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* 4 · Cash & Discount Specials                                        */}
      {/* ------------------------------------------------------------------ */}
      <section id="cash" className="mb-10">
        <SectionHeading
          num="4"
          title="Cash &amp; Discount Specials"
          sub="Ranked by advertised discount amount (larger = better)."
        />
        {cashOffers.length === 0 ? (
          <div className={REPORT_EMPTY_CLASS}>
            No cash or discount offers captured this period.
          </div>
        ) : (
          <div className={REPORT_PANEL_CLASS}>
            <div className="p-4">
              <GridTable
                dealers={dealers}
                rows={cashGrid}
                renderCell={(_cell, offer) => (
                  <div className={REPORT_HEADLINE_CLASS}>
                    {offer.cashIncentive != null
                      ? `Up to ${fmtMoney(offer.cashIncentive)} off`
                      : offer.rawText?.slice(0, 40) ?? "—"}
                  </div>
                )}
              />
              <GridLegend hasRanking={cashGrid.length > 0} />
            </div>
          </div>
        )}
        <Narrative text={cashNote} />
        <ReturnToSummary />
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* 5 · Service Specials                                                */}
      {/* ------------------------------------------------------------------ */}
      <section id="service" className="mb-10">
        <SectionHeading
          num="5"
          title="Service Specials"
          sub="Advertised service offers per dealer."
        />
        {serviceOffers.length === 0 ? (
          <div className={REPORT_EMPTY_CLASS}>
            No service specials captured this period.
          </div>
        ) : (
          <div className="columns-1 gap-4 lg:columns-2">
            {dealers.map((d) => {
              const dKey = d.siteId ?? d.siteName;
              const dOffers = serviceOffersByDealer.get(dKey) ?? [];
              return (
                <ServiceDealerCard
                  key={dKey}
                  dealer={d}
                  offers={dOffers}
                  emptyLabel="Not Advertised"
                />
              );
            })}
          </div>
        )}
        <Narrative text={serviceNote} />
        <ReturnToSummary />
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* 5 · Inventory Snapshot                                              */}
      {/* ------------------------------------------------------------------ */}
      {hasInventory && (
        <section id="inventory" className="mb-10">
          <SectionHeading
            num="5"
            title="Inventory Snapshot"
            sub={`New vehicle inventory across ${dealerInventory.length} dealers.`}
          />

          {/* KPI tiles */}
          <div className="mb-4 grid grid-cols-3 gap-3">
            {[
              {
                value: invAnchorUnits.toLocaleString(),
                label: `${invAnchor?.siteName ?? "Anchor"} Units`,
                sub: invAnchorRank > 0 ? `#${invAnchorRank} of ${dealerInventory.length} dealers` : "",
                color: "text-emerald-700 dark:text-emerald-300",
              },
              {
                value: invMarketAvg.toLocaleString(),
                label: "Market Average",
                sub: `Across ${dealerInventory.length} dealers`,
                color: "text-blue-700 dark:text-blue-300",
              },
              {
                value: invTotalMarket.toLocaleString(),
                label: "Total Market Supply",
                sub: `${dealerInventory.length} dealers combined`,
                color: "text-black dark:text-zinc-50",
              },
            ].map((t) => (
              <div key={t.label} className="rounded-lg border border-zinc-200 bg-white px-4 py-3 text-center shadow-sm dark:border-zinc-700 dark:bg-zinc-950">
                <div className={`text-3xl font-extrabold ${t.color}`}>{t.value}</div>
                <div className={`mt-1 ${REPORT_LABEL_CLASS}`}>{t.label}</div>
                {t.sub && <div className={REPORT_META_CLASS}>{t.sub}</div>}
              </div>
            ))}
          </div>

          {/* Total Inventory Ranking */}
          <div className={`mb-4 rounded-lg ${REPORT_PANEL_CLASS}`}>
            <div className={`border-b px-4 py-2 ${REPORT_BORDER_CLASS}`}>
              <h3 className={REPORT_LABEL_CLASS}>Total Inventory Ranking</h3>
            </div>
            <div className="divide-y divide-zinc-200 px-4 py-1 dark:divide-zinc-800">
              {invSorted.map((d, i) => {
                const pct = invTotalMarket > 0 ? (d.totalUnits / invSorted[0].totalUnits) * 100 : 0;
                return (
                  <div key={d.siteName} className={`flex items-center gap-3 py-1.5 ${d.isPrimary ? "font-semibold" : ""}`}>
                    <span className={REPORT_META_CLASS + " w-5 text-right"}>{d.isPrimary ? "★" : i + 1}</span>
                    <span className={REPORT_META_CLASS + " w-36 shrink-0"}>{d.siteName}{d.isPrimary ? " ★" : ""}</span>
                    <div className="flex-1">
                      <div
                        className={`h-4 rounded ${d.isPrimary ? "bg-[#1b3a6b]" : "bg-blue-300"}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className={REPORT_META_CLASS + " w-8 text-right"}>{d.totalUnits}</span>
                  </div>
                );
              })}
            </div>
            {invInsights && invInsights.gapDealer && !invAnchor?.isPrimary && (
              <div className="border-t border-zinc-200 bg-amber-50 px-4 py-2 text-sm font-semibold text-black dark:border-zinc-800 dark:bg-amber-950/30 dark:text-zinc-50">
                <span className="uppercase tracking-wide text-amber-700 dark:text-amber-300">Inventory Gap Alert</span>{" "}
                {invInsights.gapDealer.siteName} carries {Math.abs(invInsights.gap)} more units than {invAnchor?.siteName ?? "anchor"}.
              </div>
            )}
            {invInsights && invInsights.gapDealer && invAnchorRank === 1 && (
              <div className="border-t border-zinc-200 bg-emerald-50 px-4 py-2 text-sm font-semibold text-black dark:border-zinc-800 dark:bg-emerald-950/30 dark:text-zinc-50">
                <span className="uppercase tracking-wide text-emerald-700 dark:text-emerald-300">Market Leader</span>{" "}
                {invAnchor?.siteName ?? "Anchor"} leads the competitive set with {invAnchorUnits} units — {invInsights.gap < 0 ? Math.abs(invInsights.gap) : ""} more than {invInsights.gapDealer.siteName}.
              </div>
            )}
          </div>

          {/* Anchor brand breakdown */}
          {invAnchor && invAnchor.makes.length > 0 && (
            <div className={`mb-4 rounded-lg ${REPORT_PANEL_CLASS}`}>
              <div className={`border-b px-4 py-2 ${REPORT_BORDER_CLASS}`}>
                <h3 className={REPORT_LABEL_CLASS}>{invAnchor.siteName} — Brand Breakdown</h3>
              </div>
              <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-4">
                {[...invAnchor.makes].sort((a, b) => b.inStock - a.inStock).map((m) => (
                  <div key={m.make} className="rounded border border-zinc-200 bg-zinc-50 px-3 py-2 text-center dark:border-zinc-800 dark:bg-zinc-900">
                    <div className={REPORT_META_CLASS}>{m.make}</div>
                    <div className="text-2xl font-extrabold text-[#1b3a6b] dark:text-blue-300">{m.inStock}</div>
                    <div className={REPORT_META_CLASS}>{invAnchorUnits > 0 ? Math.round((m.inStock / invAnchorUnits) * 100) : 0}% of stock</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Model-by-Dealer table */}
          {Object.keys(allModelsByMake).length > 0 && (
            <div className={`mb-4 rounded-lg ${REPORT_PANEL_CLASS}`}>
              <div className={`flex items-baseline gap-3 border-b px-4 py-2 ${REPORT_BORDER_CLASS}`}>
                <h3 className={REPORT_LABEL_CLASS}>Model-by-Dealer Breakdown</h3>
                <span className={REPORT_META_CLASS}>Shading = inventory density · darkest = row leader</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm" style={{ tableLayout: "fixed" }}>
                  <colgroup>
                    <col style={{ width: "140px" }} />
                    {dealerInventory.map((d) => <col key={d.siteName} style={{ width: "90px" }} />)}
                    <col style={{ width: "70px" }} />
                  </colgroup>
                  <thead>
                    <tr className="border-b border-zinc-200 bg-zinc-50 text-sm uppercase tracking-wide text-zinc-900 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-50">
                      <th className="px-3 py-1.5 text-left font-medium">Model</th>
                      {dealerInventory.map((d) => (
                        <th key={d.siteName} className={`px-2 py-1.5 text-center font-medium ${d.isPrimary ? "bg-[#1b3a6b] text-white" : ""}`}>
                          {d.siteName}{d.isPrimary ? " ★" : ""}
                        </th>
                      ))}
                      <th className="px-2 py-1.5 text-right font-medium">Market</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                    {allMakes.filter((make) => allModelsByMake[make]?.length > 0).map((make) => (
                      <React.Fragment key={`make-${make}`}>
                        <tr className="bg-zinc-100 dark:bg-zinc-900">
                          <td colSpan={dealerInventory.length + 2} className={REPORT_LABEL_CLASS + " px-3 py-1"}>
                            {make}
                          </td>
                        </tr>
                        {(allModelsByMake[make] ?? []).map((model) => {
                          const vals = dealerInventory.map((d) => invModelLookup[d.siteName]?.[make]?.[model] ?? 0);
                          const maxVal = Math.max(...vals, 1);
                          const marketTotal = vals.reduce((s, v) => s + v, 0);
                          return (
                            <tr key={`${make}|${model}`} className="hover:bg-zinc-50/50 dark:hover:bg-zinc-900/70">
                              <td className="px-3 py-1.5 font-semibold text-black dark:text-zinc-50">{model}</td>
                              {dealerInventory.map((d, di) => {
                                const n = vals[di];
                                const intensity = n === 0 ? 0 : n === maxVal ? 1 : 0.3 + (n / maxVal) * 0.5;
                                const isLeader = n === maxVal && n > 0;
                                const isPrimary = d.isPrimary;
                                return (
                                  <td
                                    key={d.siteName}
                                    className={`px-2 py-1.5 text-center font-semibold ${n === 0 ? "text-zinc-900 dark:text-zinc-100" : isLeader ? "text-white" : isPrimary ? "text-white" : "text-black dark:text-zinc-50"}`}
                                    style={{
                                      backgroundColor: n === 0 ? "transparent" : isLeader
                                        ? "#1b3a6b"
                                        : isPrimary
                                        ? `rgba(27,58,107,${intensity})`
                                        : `rgba(59,130,246,${intensity})`,
                                    }}
                                  >
                                    {n === 0 ? "—" : n}
                                  </td>
                                );
                              })}
                              <td className="px-2 py-1.5 text-right font-semibold text-black dark:text-zinc-50">{marketTotal}</td>
                            </tr>
                          );
                        })}
                      </React.Fragment>
                    ))}
                    <tr className="border-t-2 border-zinc-200 bg-zinc-50 font-bold dark:border-zinc-700 dark:bg-zinc-900">
                      <td className="px-3 py-1.5 text-black dark:text-zinc-50">TOTAL</td>
                      {dealerInventory.map((d) => (
                        <td key={d.siteName} className={`px-2 py-1.5 text-center ${d.isPrimary ? "text-[#1b3a6b] dark:text-blue-300" : "text-black dark:text-zinc-50"}`}>
                          {d.totalUnits}
                        </td>
                      ))}
                      <td className="px-2 py-1.5 text-right text-black dark:text-zinc-50">{invTotalMarket}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Key Takeaways */}
          {invInsights && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {invInsights.anchorLeadModels.length > 0 && (
                <div className="rounded-lg border-l-4 border-emerald-500 bg-emerald-50 px-3 py-2.5 dark:bg-emerald-950/30">
                  <div className="mb-1 text-sm font-bold uppercase tracking-widest text-emerald-700 dark:text-emerald-300">Strength</div>
                  <p className={REPORT_BODY_CLASS}>
                    Market leader in {invInsights.anchorLeadModels.slice(0, 3).join(", ")}
                    {invInsights.anchorLeadModels.length > 3 ? ` and ${invInsights.anchorLeadModels.length - 3} more` : ""}.
                  </p>
                </div>
              )}
              {invInsights.makeGaps.length > 0 && invInsights.makeGaps[0].gap > 0 && (
                <div className="rounded-lg border-l-4 border-amber-500 bg-amber-50 px-3 py-2.5 dark:bg-amber-950/30">
                  <div className="mb-1 text-sm font-bold uppercase tracking-widest text-amber-700 dark:text-amber-300">Watch</div>
                  <p className={REPORT_BODY_CLASS}>
                    {invInsights.makeGaps[0].make} supply gap vs. market leader ({invInsights.makeGaps[0].anchorN} vs. {invInsights.makeGaps[0].leaderN} units).
                  </p>
                </div>
              )}
              {invInsights.makeGaps.length > 1 && invInsights.makeGaps[invInsights.makeGaps.length - 1].gap <= 0 && (
                <div className="rounded-lg border-l-4 border-blue-500 bg-blue-50 px-3 py-2.5 dark:bg-blue-950/30">
                  <div className="mb-1 text-sm font-bold uppercase tracking-widest text-blue-700 dark:text-blue-300">Opportunity</div>
                  <p className={REPORT_BODY_CLASS}>
                    Leading in {invInsights.makeGaps[invInsights.makeGaps.length - 1].make} with minimal competition from the field.
                  </p>
                </div>
              )}
              <div className="rounded-lg border-l-4 border-zinc-400 bg-zinc-50 px-3 py-2.5 dark:bg-zinc-900">
                <div className={`mb-1 ${REPORT_LABEL_CLASS}`}>Context</div>
                <p className={REPORT_BODY_CLASS}>
                  {invSorted[0].siteName} leads the market with {invSorted[0].totalUnits} units
                  {invSorted[0].isPrimary ? " — anchor holds the top position." : ` — ${Math.round((invSorted[0].totalUnits / invTotalMarket) * 100)}% of total market supply.`}
                </p>
              </div>
            </div>
          )}
          <ReturnToSummary />
        </section>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* 6 · Compliance                                                      */}
      {/* ------------------------------------------------------------------ */}
      {hasCompliance && (
        <section id="compliance" className="mb-10">
          <SectionHeading
            num="6"
            title="Ad Compliance"
            sub={`Compliance grades for ${anchor?.siteName ?? "anchor"} offers.`}
          />
          <div className={REPORT_PANEL_CLASS}>
            <div className={`px-6 pt-5 pb-4 border-b ${REPORT_BORDER_CLASS}`}>
              <p className={`mb-3 ${REPORT_LABEL_CLASS}`}>
                This week&apos;s ad grades
              </p>
              <div className="flex flex-wrap gap-6">
                {Object.entries(realComplianceCounts).map(([grade, count]) => (
                  <div key={grade} className="text-center">
                    <div
                      className={`text-4xl font-extrabold leading-none ${
                        grade === "pass"
                          ? "text-emerald-600"
                          : grade === "fail"
                            ? "text-red-600"
                            : "text-amber-600"
                      }`}
                    >
                      {grade.toUpperCase()}
                    </div>
                    <div className={REPORT_META_CLASS + " mt-1"}>
                      {count} ad{count !== 1 ? "s" : ""}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            {/* Per-offer compliance table for anchor */}
            {(() => {
              const anchorGraded = offers.filter(
                (o) =>
                  o.siteId &&
                  anchorSiteIds.has(o.siteId) &&
                  o.offerType !== "service" &&
                  o.complianceGrade &&
                  o.complianceGrade !== "n/a" &&
                  o.complianceGrade.toLowerCase() !== "err"
              );
              if (anchorGraded.length === 0) return null;
              return (
                <table className="w-full border-t border-zinc-200 text-base dark:border-zinc-800">
                  <thead>
                    <tr className={`border-b ${REPORT_BORDER_CLASS} ${REPORT_LABEL_CLASS}`}>
                      <th className="px-4 py-2 text-left font-medium">Offer</th>
                      <th className="px-4 py-2 text-left font-medium">Type</th>
                      <th className="px-4 py-2 text-left font-medium">Grade</th>
                      <th className="px-4 py-2 text-left font-medium">Reason</th>
                      <th className="px-4 py-2 text-left font-medium">Original Ad</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                    {anchorGraded.map((o) => {
                      const details = o.complianceDetailsJson as Record<string, unknown> | null;
                      const reason = details?.reason as string | undefined;
                      return (
                      <tr key={o.id}>
                        <td className="px-4 py-3 align-top text-black dark:text-zinc-50">
                          <div className="font-semibold">
                            {[o.vehicleMake, o.vehicleModel, o.vehicleTrim]
                              .filter(Boolean)
                              .join(" ") || "—"}
                          </div>
                        </td>
                        <td className="px-4 py-3 capitalize align-top text-black dark:text-zinc-50">
                          {o.offerType}
                        </td>
                        <td className="px-4 py-3 align-top">
                          <span
                            className={`inline-flex rounded-full px-2.5 py-1 text-sm font-semibold ${
                              o.complianceGrade === "pass"
                                ? "bg-green-100 text-green-800"
                                : o.complianceGrade === "fail"
                                  ? "bg-red-100 text-red-800"
                                  : "bg-amber-100 text-amber-800"
                            }`}
                          >
                            {o.complianceGrade}
                          </span>
                        </td>
                        <td className="px-4 py-3 align-top text-black dark:text-zinc-50">
                          {reason ?? <span className="text-black dark:text-zinc-50">—</span>}
                        </td>
                        <td className="px-4 py-3 align-top">
                          {(o.evidenceUrl ?? o.sourceEvidenceId) ? (
                            <a
                              href={o.evidenceUrl ?? `/api/evidence/${o.sourceEvidenceId}/file`}
                              target="_blank"
                              rel="noreferrer"
                              className={REPORT_LINK_CLASS}
                            >
                              View
                            </a>
                          ) : (
                            <span className={REPORT_META_CLASS}>—</span>
                          )}
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              );
            })()}
          </div>
          <ReturnToSummary />
        </section>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Snapshot history (admin only)                                       */}
      {/* ------------------------------------------------------------------ */}
      {adminControls && groupSnapshots.length > 1 && (
        <section className="mb-10">
          <SectionHeading title="Snapshot History" />
          <div className={REPORT_PANEL_CLASS}>
            <table className="w-full text-base">
              <thead>
                <tr className={`border-b ${REPORT_BORDER_CLASS} ${REPORT_LABEL_CLASS}`}>
                  <th className="px-4 py-2 text-left font-medium">Published</th>
                  <th className="px-4 py-2 text-left font-medium">Report</th>
                  <th className="px-4 py-2 text-right font-medium">Offers</th>
                  <th className="px-4 py-2 text-right font-medium">Sites</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                {groupSnapshots.map((s) => (
                  <tr key={s.id} className={s.id === snapshot.id ? "bg-blue-50/50 dark:bg-blue-950/30" : ""}>
                    <td className="px-4 py-2.5 font-semibold text-black dark:text-zinc-50">
                      {new Date(s.approvedAt).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                    </td>
                    <td className="px-4 py-2.5">
                      {s.id === snapshot.id ? (
                        <span className="font-semibold text-black dark:text-zinc-50">
                          {s.label || "This report"} (current)
                        </span>
                      ) : (
                        <a
                          href={`/reports/${s.id}`}
                          className={REPORT_LINK_CLASS}
                        >
                          {s.label || `Snapshot ${s.id.slice(0, 8)}`}
                        </a>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right font-semibold text-black dark:text-zinc-50">{s.offerCount}</td>
                    <td className="px-4 py-2.5 text-right font-semibold text-black dark:text-zinc-50">{s.siteCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Methodology footer                                                   */}
      {/* ------------------------------------------------------------------ */}
      <footer className="mt-6 rounded-xl border border-zinc-200 bg-zinc-50 px-6 py-5 text-base text-black dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50">
        <p className="font-semibold text-black dark:text-zinc-50">Methodology &amp; Data Provenance</p>
        <p className="mt-2">
          Specials data captured from each dealer&apos;s published promotions pages at
          the time of collection. Offer payments, APRs, and terms are read from
          advertised banners and disclaimer modals. Rankings are per model row and
          reflect the headline figure only — lease due-at-signing and mileage
          allowances differ and are shown in each cell. No values were estimated or
          carried from prior runs.
        </p>
        <p className="mt-2">
          This report is competitive intelligence compiled from publicly advertised
          offers and is provided for informational purposes only. Advertised prices,
          payments, APRs, and terms are subject to change, qualification, and dealer
          availability. Not all buyers will qualify.
        </p>
        <p className="mt-3 font-semibold text-black dark:text-zinc-50">
          Dealer Intel · Competitive Specials Comparison ·{" "}
          {snapshot.runGroupName ?? "All sites"} · Published {captureDate}
        </p>
      </footer>
    </div>
  );
}
