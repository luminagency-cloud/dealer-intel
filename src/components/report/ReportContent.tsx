"use client";

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
import type { ReportSnapshot, SnapshotOffer } from "@/lib/db";
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
  /** When true, show admin-only controls (Copy Link, Export CSV). */
  adminControls?: boolean;
  /** Tailwind classes for the outermost wrapper div. Defaults to
   *  "mx-auto max-w-6xl px-4 py-8" (suitable for the standalone public route).
   *  Override in admin context where the layout already provides padding. */
  containerClassName?: string;
}

// ---------------------------------------------------------------------------
// Helper sub-components
// ---------------------------------------------------------------------------


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
      <h2 className="flex items-baseline gap-2 text-xl font-bold text-[#1b3a6b]">
        {num && (
          <span className="text-[#1b3a6b] opacity-50">{num} ·</span>
        )}
        {title}
      </h2>
      {sub && <p className="mt-0.5 text-sm text-zinc-500">{sub}</p>}
    </div>
  );
}

function Narrative({ text }: { text: string }) {
  if (!text) return null;
  return (
    <div className="mt-3 rounded-md border-l-4 border-[#1b3a6b] bg-blue-50 px-4 py-3 text-sm text-zinc-700">
      {text}
    </div>
  );
}

// "Not Advertised" cell style
const NA_CLASS =
  "text-zinc-400 italic text-xs text-center";

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
      <p className="py-4 text-sm text-zinc-500">No offers captured.</p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            <th className="w-36 border border-zinc-200 bg-zinc-100 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-zinc-600">
              Model
            </th>
            {dealers.map((d) => (
              <th
                key={d.siteId ?? d.siteName}
                className={`border border-zinc-200 px-3 py-2 text-center text-xs font-semibold uppercase tracking-wide ${
                  d.isPrimary
                    ? "bg-[#1b5e3b] text-white"
                    : "bg-zinc-700 text-white"
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
              <td className="border border-zinc-200 bg-zinc-50 px-3 py-2 font-medium text-zinc-800">
                {row.vehicleModel}
              </td>
              {row.cells.map((cell, i) => {
                const bg = rankClass(cell.rank, cell.totalRanked);
                return (
                  <td
                    key={dealers[i].siteId ?? dealers[i].siteName}
                    className={`border border-zinc-200 px-3 py-2 text-center align-top ${disableRanking ? "" : bg}`}
                  >
                    {cell.offer ? (
                      <div className="space-y-0.5">
                        {renderCell(cell, cell.offer)}
                        {cell.trimMismatch && cell.displayTrim && (
                          <div>
                            <span className="inline-block rounded bg-amber-100 px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide text-amber-800">
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
    <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-zinc-600">
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
      <span className="text-zinc-400 italic">Not Advertised</span>
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
    <div className="flex gap-4 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
      <div className="flex-shrink-0">
        <span
          className={`inline-flex items-center justify-center rounded px-2 py-1 text-[10px] font-bold uppercase tracking-wider ${CATEGORY_COLORS[item.category]}`}
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
        <p className="mt-1 text-sm text-zinc-600">{item.summary}</p>
      </div>
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
        <div className="rounded-xl border-2 border-dashed border-zinc-300 bg-zinc-50 px-6 py-8 text-center text-sm text-zinc-400">
          Brand &amp; industry news will appear here once the news service is connected.
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Copy-link button (client interaction)
// ---------------------------------------------------------------------------

function CopyLinkButton({ snapshotId }: { snapshotId: string }) {
  return (
    <button
      onClick={() => {
        const url = `${window.location.origin}/r/${snapshotId}`;
        void navigator.clipboard.writeText(url);
        const btn = document.getElementById("copy-link-btn");
        if (btn) {
          btn.textContent = "Copied!";
          setTimeout(() => {
            btn.textContent = "Copy shareable link";
          }, 2000);
        }
      }}
      id="copy-link-btn"
      className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100"
    >
      Copy shareable link
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
  adminControls = false,
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
  // Exclude "n/a" (stub grader output) so the compliance section only appears
  // when real grades (pass / fail / letter grades) are present.
  const realComplianceCounts = Object.fromEntries(
    Object.entries(complianceCounts).filter(([g]) => g !== "n/a")
  );
  const hasCompliance = Object.keys(realComplianceCounts).length > 0;

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
            <p className="mt-2 text-base text-blue-200">
              {anchor.siteName} ★ vs.{" "}
              {competitorNames.join(", ") || "no competitors captured"}
            </p>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <span className="rounded-full border border-blue-400/40 bg-blue-800/40 px-3 py-1 text-sm font-medium">
              {snapshot.runGroupName ?? "All sites"}
            </span>
            <span className="rounded-full border border-blue-400/40 bg-blue-800/40 px-3 py-1 text-sm">
              {snapshot.label || `Snapshot ${snapshot.id.slice(0, 8)}`}
            </span>
            <span className="rounded-full border border-blue-400/40 bg-blue-800/40 px-3 py-1 text-sm">
              Published {captureDate}
            </span>
          </div>
        </div>
        {/* KPI tiles */}
        <div className="grid grid-cols-2 gap-px border-t border-blue-800/60 bg-blue-800/30 sm:grid-cols-4">
          {[
            { value: kpis.leaseModelCount, label: `${anchor?.siteName ?? "Anchor"} Lease Models` },
            { value: kpis.financeOfferCount, label: `${anchor?.siteName ?? "Anchor"} Finance Offers` },
            { value: kpis.cashOfferCount, label: `${anchor?.siteName ?? "Anchor"} Cash Offers` },
            { value: kpis.serviceOfferCount, label: `${anchor?.siteName ?? "Anchor"} Service Offers` },
          ].map((t) => (
            <div
              key={t.label}
              className="flex flex-col items-center px-4 py-5 text-center"
            >
              <span className="text-3xl font-bold">{t.value}</span>
              <span className="mt-1 text-[11px] font-semibold uppercase tracking-widest text-blue-300">
                {t.label}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Admin controls */}
      {adminControls && (
        <div className="mb-6 flex items-center gap-3">
          <CopyLinkButton snapshotId={snapshot.id} />
          <a
            href={`/reports/${snapshot.id}/export`}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100"
          >
            Export CSV
          </a>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* 1 · Brand News                                                      */}
      {/* ------------------------------------------------------------------ */}
      <BrandNewsSection news={news} brand={news?.brand ?? undefined} />

      {/* ------------------------------------------------------------------ */}
      {/* Executive brief                                                     */}
      {/* ------------------------------------------------------------------ */}
      <div className="mb-8 rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-widest text-zinc-500">
          Report Summary
        </h2>
        <ul className="space-y-2 text-sm text-zinc-700">
          {leaseGrid.length > 0 && (
            <li>
              <a href="#lease" className="font-semibold text-[#1b3a6b] hover:underline">
                Lease Specials →
              </a>{" "}
              {leaseGrid.length} model{leaseGrid.length !== 1 ? "s" : ""} advertised across the group.
            </li>
          )}
          {financeGrid.length > 0 && (
            <li>
              <a href="#finance" className="font-semibold text-[#1b3a6b] hover:underline">
                Finance (APR) →
              </a>{" "}
              {financeNote}
            </li>
          )}
          {cashGrid.length > 0 && (
            <li>
              <a href="#cash" className="font-semibold text-[#1b3a6b] hover:underline">
                Cash &amp; Discounts →
              </a>{" "}
              {cashNote}
            </li>
          )}
          {serviceOffers.length > 0 && (
            <li>
              <a href="#service" className="font-semibold text-[#1b3a6b] hover:underline">
                Service Specials →
              </a>{" "}
              {serviceNote}
            </li>
          )}
          {hasCompliance && (
            <li>
              <a href="#compliance" className="font-semibold text-[#1b3a6b] hover:underline">
                Compliance →
              </a>{" "}
              {Object.entries(complianceCounts)
                .map(([g, n]) => `${n} ${g}`)
                .join(", ")}{" "}
              for {anchor?.siteName ?? "anchor"}.
            </li>
          )}
        </ul>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* 2 · Lease Specials                                                  */}
      {/* ------------------------------------------------------------------ */}
      <section id="lease" className="mb-10">
        <SectionHeading
          num="2"
          title="Lease Specials"
        />
        <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm">
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
                      <div className="font-bold">
                        {fmtMoney(offer.monthlyPayment)}/mo
                      </div>
                    )}
                    <div className="text-xs opacity-80">
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
                      <div className="mt-0.5 text-[9px] text-amber-600 opacity-75">
                        missing: {missingFields.join(", ")}
                      </div>
                    )}
                    {(offer.evidenceUrl ?? offer.sourceEvidenceId) && (
                      <a
                        href={offer.evidenceUrl ?? `/api/evidence/${offer.sourceEvidenceId}/file`}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1 block text-[9px] text-blue-500 hover:underline"
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
        <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm">
          <div className="p-4">
            <GridTable
              dealers={dealers}
              rows={financeGrid}
              disableRanking
              renderCell={(_cell, offer) => (
                <>
                  {offer.apr !== null && (
                    <div className="font-bold">{fmtApr(offer.apr)}</div>
                  )}
                  {offer.termMonths && (
                    <div className="text-xs opacity-80">{offer.termMonths} mo</div>
                  )}
                </>
              )}
            />
          </div>
        </div>
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
          <div className="rounded-xl border border-zinc-200 bg-white p-6 text-sm text-zinc-500 shadow-sm">
            No cash or discount offers captured this period.
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm">
            <div className="p-4">
              <GridTable
                dealers={dealers}
                rows={cashGrid}
                renderCell={(_cell, offer) => (
                  <div className="font-bold">
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
          <div className="rounded-xl border border-zinc-200 bg-white p-6 text-sm text-zinc-500 shadow-sm">
            No service specials captured this period.
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {dealers.map((d) => {
              const dKey = d.siteId ?? d.siteName;
              const dOffers = serviceOffers.filter(
                (o) => (o.siteId ?? o.siteName) === dKey
              );
              return (
                <div
                  key={dKey}
                  className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm"
                >
                  <div
                    className={`px-4 py-2.5 text-sm font-semibold ${
                      d.isPrimary
                        ? "bg-[#1b5e3b] text-white"
                        : "bg-zinc-700 text-white"
                    }`}
                  >
                    {d.siteName}
                    {d.isPrimary && <span className="ml-1 text-yellow-300">★</span>}
                  </div>
                  {dOffers.length === 0 ? (
                    <p className="px-4 py-3 text-xs italic text-zinc-400">
                      Not Advertised
                    </p>
                  ) : (
                    <ul className="divide-y divide-zinc-100">
                      {dOffers.map((o) => {
                        const matchMap = (
                          o.normalizedJson as { matches?: Record<string, string> } | null
                        )?.matches ?? {};
                        return (
                        <li key={o.id} className="px-4 py-2.5">
                          <div className="text-sm text-zinc-800">
                            {o.rawText ?? "Service Special"}
                          </div>
                          {o.cashIncentive != null ? (
                            <div className="mt-0.5 text-xs font-medium text-emerald-700">
                              {fmtMoney(o.cashIncentive)} off
                            </div>
                          ) : matchMap.serviceOffer ? (
                            <div className="mt-0.5 text-xs font-medium text-emerald-700">
                              {matchMap.serviceOffer}
                            </div>
                          ) : null}
                          {(o.evidenceUrl ?? o.sourceEvidenceId) && (
                            <a
                              href={o.evidenceUrl ?? `/api/evidence/${o.sourceEvidenceId}/file`}
                              target="_blank"
                              rel="noreferrer"
                              className="mt-0.5 block text-xs text-blue-600 hover:underline"
                            >
                              View evidence
                            </a>
                          )}
                        </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <Narrative text={serviceNote} />
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* 5 · Compliance                                                      */}
      {/* ------------------------------------------------------------------ */}
      {hasCompliance && (
        <section id="compliance" className="mb-10">
          <SectionHeading
            num="6"
            title="Ad Compliance"
            sub={`Compliance grades for ${anchor?.siteName ?? "anchor"} offers.`}
          />
          <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm">
            <div className="px-6 pt-5 pb-4 border-b border-zinc-100">
              <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-zinc-400">
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
                    <div className="mt-1 text-sm font-medium text-zinc-500">
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
                  o.complianceGrade !== "n/a"
              );
              if (anchorGraded.length === 0) return null;
              return (
                <table className="w-full border-t border-zinc-100 text-sm">
                  <thead>
                    <tr className="border-b border-zinc-100 text-xs uppercase tracking-wide text-zinc-500">
                      <th className="px-4 py-2 text-left font-medium">Offer</th>
                      <th className="px-4 py-2 text-left font-medium">Type</th>
                      <th className="px-4 py-2 text-left font-medium">Grade</th>
                      <th className="px-4 py-2 text-left font-medium">Original Ad</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100">
                    {anchorGraded.map((o) => {
                      const details = o.complianceDetailsJson as Record<string, unknown> | null;
                      const reason = details?.reason as string | undefined;
                      return (
                      <tr key={o.id}>
                        <td className="px-4 py-3 text-zinc-800">
                          <div className="font-medium">
                            {[o.vehicleMake, o.vehicleModel, o.vehicleTrim]
                              .filter(Boolean)
                              .join(" ") || "—"}
                          </div>
                          {reason && (
                            <p className="mt-1 text-sm text-zinc-800 leading-snug">{reason}</p>
                          )}
                        </td>
                        <td className="px-4 py-3 capitalize text-zinc-600 align-top">
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
                        <td className="px-4 py-3 align-top">
                          {(o.evidenceUrl ?? o.sourceEvidenceId) ? (
                            <a
                              href={o.evidenceUrl ?? `/api/evidence/${o.sourceEvidenceId}/file`}
                              target="_blank"
                              rel="noreferrer"
                              className="text-sm text-blue-600 hover:underline"
                            >
                              View
                            </a>
                          ) : (
                            <span className="text-sm text-zinc-400">—</span>
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
        </section>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Snapshot history (admin only)                                       */}
      {/* ------------------------------------------------------------------ */}
      {adminControls && groupSnapshots.length > 1 && (
        <section className="mb-10">
          <SectionHeading title="Snapshot History" />
          <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-100 text-xs uppercase tracking-wide text-zinc-500">
                  <th className="px-4 py-2 text-left font-medium">Published</th>
                  <th className="px-4 py-2 text-left font-medium">Report</th>
                  <th className="px-4 py-2 text-right font-medium">Offers</th>
                  <th className="px-4 py-2 text-right font-medium">Sites</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {groupSnapshots.map((s) => (
                  <tr key={s.id} className={s.id === snapshot.id ? "bg-blue-50/50" : ""}>
                    <td className="px-4 py-2.5 text-zinc-600">
                      {new Date(s.approvedAt).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                    </td>
                    <td className="px-4 py-2.5">
                      {s.id === snapshot.id ? (
                        <span className="font-medium text-zinc-900">
                          {s.label || "This report"} (current)
                        </span>
                      ) : (
                        <a
                          href={`/reports/${s.id}`}
                          className="text-blue-600 hover:underline"
                        >
                          {s.label || `Snapshot ${s.id.slice(0, 8)}`}
                        </a>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right text-zinc-700">{s.offerCount}</td>
                    <td className="px-4 py-2.5 text-right text-zinc-700">{s.siteCount}</td>
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
      <footer className="mt-6 rounded-xl border border-zinc-200 bg-zinc-50 px-6 py-5 text-xs text-zinc-500">
        <p className="font-semibold text-zinc-700">Methodology &amp; Data Provenance</p>
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
        <p className="mt-3 text-zinc-400">
          Dealer Intel · Competitive Specials Comparison ·{" "}
          {snapshot.runGroupName ?? "All sites"} · Published {captureDate}
        </p>
      </footer>
    </div>
  );
}
