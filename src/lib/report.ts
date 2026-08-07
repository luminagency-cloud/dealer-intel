/**
 * Competitive Market Analysis — report data helpers (Phase 11 v2).
 *
 * Pure computation: takes raw snapshot offers + primary-site IDs and produces
 * the structured data the report UI renders. No DB access here.
 */

import type { SnapshotOffer } from "@/lib/db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DealerCol {
  siteId: string | null;
  siteName: string;
  isPrimary: boolean;
}

export type RankDir = "lower" | "higher";

export interface RankedCell {
  offer: SnapshotOffer | null; // null = Not Advertised
  rank: number | null; // 1=best, null=not advertised
  totalRanked: number; // how many dealers have a value in this row
  trimMismatch: boolean; // trim differs from modal trim for this row
  displayTrim: string | null;
}

export interface GridRow {
  vehicleModel: string;
  cells: RankedCell[]; // one per dealer, same order as dealers array
  modalTrim: string | null;
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

export function fmtMoney(n: number | null): string {
  if (n === null) return "—";
  return `$${Math.round(n).toLocaleString()}`;
}

/** Money exactly as parsed, unrounded. For the admin offer tables, where the
 *  whole point is spotting a bad extraction — `$2,499.5` has to look wrong
 *  rather than get tidied to `$2,500`. Reports use fmtMoney. */
export function fmtMoneyExact(n: number | null): string {
  if (n === null) return "—";
  return `$${n.toLocaleString()}`;
}

export function fmtApr(n: number | null): string {
  if (n === null) return "—";
  const s = n % 1 === 0 ? `${n}` : n.toFixed(1).replace(/\.0$/, "");
  return `${s}%`;
}

/** Parse miles/year from disclaimer or raw text, e.g. "7,500 miles per year"
 *  or "5k miles per year". */
export function parseMileage(text: string | null): number | null {
  if (!text) return null;
  // "7,500 miles per year" or "7500 mi/yr"
  const m = text.match(
    /([\d,]+)\s*(?:miles?|mi)(?:\s*\/\s*|\s+per\s+|\s+a\s+)(?:year|yr\b|annum)/i
  );
  if (m) {
    const v = Number(m[1].replace(/,/g, ""));
    if (v >= 3000 && v <= 30_000) return v;
  }
  // "5k miles per year" or "10k mi/yr"
  const km = text.match(
    /(\d+)k\s*(?:miles?|mi)(?:\s*\/\s*|\s+per\s+|\s+a\s+)(?:year|yr\b|annum)/i
  );
  if (km) {
    const v = Number(km[1]) * 1000;
    if (v >= 3000 && v <= 30_000) return v;
  }
  return null;
}

/** Derive an ANNUAL lease mileage cap from a whole-TERM total, for ads that
 *  only print the total (e.g. "36 months, 22,500 miles" → 22,500 ÷ 3 yr =
 *  7,500/yr). Use ONLY as a fallback after parseMileage — i.e. when no explicit
 *  "per year" figure was stated.
 *
 *  The 15k/yr ceiling is the discriminator, and the reason this is safe: no
 *  mainstream lease advertises more than 15,000 mi/yr, so a bare figure ABOVE
 *  15k can only be a term-total (divide it), while a figure at/below 15k is
 *  plausibly already an annual cap and is LEFT UNTOUCHED — the division path
 *  never sees it. That's what makes "10k miles" structurally impossible to
 *  mangle here. The derived result must itself land in [3k, 15k] to be taken.
 *
 *  Returns null unless a term is known and a >15k total is present near "miles". */
export function deriveAnnualMileage(
  text: string | null,
  termMonths: number | null
): number | null {
  if (!text || !termMonths || termMonths <= 0) return null;
  const years = termMonths / 12;
  const re = /([\d,]{4,})\s*(?:miles?|mi)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // Skip figures explicitly qualified as annual ("per year", "/yr", "/year") —
    // those are parseMileage's job, and dividing an annual figure would be wrong.
    const trailing = text.slice(m.index + m[0].length, m.index + m[0].length + 12);
    if (/^\s*(?:\/\s*|per\s+|a\s+)?(?:year|yr\b|annum)/i.test(trailing)) continue;
    const total = Number(m[1].replace(/,/g, ""));
    // ≤15k can't be a term-total that needs dividing — leave it for the annual
    // path. Only figures that are impossibly high AS an annual cap get divided.
    if (!Number.isFinite(total) || total <= 15_000) continue;
    // Snap to the nearest 500 — real caps are round (7,500 / 10,000 / 12,000)
    // and this absorbs minor OCR/total imprecision.
    const annual = Math.round(total / years / 500) * 500;
    if (annual >= 3_000 && annual <= 15_000) return annual;
  }
  return null;
}

export function fmtMileage(n: number): string {
  return `${n.toLocaleString()} mi/yr`;
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/**
 * Assign ranks to an array of values. Nulls get null rank (= Not Advertised).
 * Ties share the same rank. Returns ranks in the same index order as values.
 */
export function assignRanks(
  values: (number | null)[],
  dir: RankDir
): (number | null)[] {
  const indexed = values
    .map((v, i) => ({ v, i }))
    .filter((x): x is { v: number; i: number } => x.v !== null);

  if (indexed.length === 0) return values.map(() => null);

  indexed.sort((a, b) => (dir === "lower" ? a.v - b.v : b.v - a.v));

  const rankMap = new Map<number, number>();
  let rank = 1;
  for (let i = 0; i < indexed.length; i++) {
    if (i > 0 && indexed[i].v !== indexed[i - 1].v) rank = i + 1;
    rankMap.set(indexed[i].i, rank);
  }

  return values.map((_, i) => rankMap.get(i) ?? null);
}

/**
 * Tailwind classes for a rank badge / cell background.
 * rank=null → not advertised (no color).
 * totalRanked=1 → only one dealer advertises this model; no comparison color.
 */
export function rankBgClass(rank: number | null, totalRanked: number): string {
  if (rank === null || totalRanked <= 1) return "";
  if (rank === 1) return "bg-emerald-700 text-white";
  if (rank === totalRanked) return "bg-red-600 text-white";
  // Intermediate: position 0=best,1=worst within middle ranks
  const pos = (rank - 1) / Math.max(totalRanked - 1, 1);
  if (pos < 0.4) return "bg-emerald-500 text-white";
  if (pos < 0.65) return "bg-amber-500 text-white";
  return "bg-orange-500 text-white";
}

// ---------------------------------------------------------------------------
// Grid builders
// ---------------------------------------------------------------------------

/** Key used to match an offer to a dealer column. */
function dealerKey(o: SnapshotOffer): string {
  return o.siteId ?? o.siteName;
}

/** Build one offer grid (lease, finance, or cash).
 *  rankBy: numeric field used to rank; rankDir: which direction is "better". */
export function buildGrid(
  dealers: DealerCol[],
  offers: SnapshotOffer[],
  rankBy: (o: SnapshotOffer) => number | null,
  rankDir: RankDir
): GridRow[] {
  // All unique vehicle models present in these offers (sorted alpha, "Other" last)
  const modelSet = new Set<string>();
  for (const o of offers) modelSet.add(o.vehicleModel ?? "Other");
  const models = [...modelSet].sort((a, b) => {
    if (a === "Other") return 1;
    if (b === "Other") return -1;
    return a.localeCompare(b);
  });

  // For each dealer column: a lookup key
  const dealerLookup = dealers.map((d) => d.siteId ?? d.siteName);

  return models.map((model) => {
    // Best offer per dealer for this model (by rankBy value)
    const best = new Map<string, SnapshotOffer>();
    for (const o of offers) {
      if ((o.vehicleModel ?? "Other") !== model) continue;
      const key = dealerKey(o);
      const current = best.get(key);
      if (!current) {
        best.set(key, o);
      } else {
        const cv = rankBy(current);
        const nv = rankBy(o);
        if (cv === null) {
          best.set(key, o);
        } else if (nv !== null) {
          const betterNew =
            rankDir === "lower" ? nv < cv : nv > cv;
          if (betterNew) best.set(key, o);
        }
      }
    }

    const cellOffers = dealerLookup.map((k) => best.get(k) ?? null);
    const rankValues = cellOffers.map((o) => (o ? rankBy(o) : null));
    const ranks = assignRanks(rankValues, rankDir);
    const totalRanked = ranks.filter((r) => r !== null).length;

    // Modal trim for mismatch detection
    const trims = cellOffers
      .map((o) => o?.vehicleTrim)
      .filter((t): t is string => Boolean(t));
    const trimCounts = new Map<string, number>();
    for (const t of trims) trimCounts.set(t, (trimCounts.get(t) ?? 0) + 1);
    const modalTrim =
      trims.length > 0
        ? [...trimCounts.entries()].sort((a, b) => b[1] - a[1])[0][0]
        : null;

    const cells: RankedCell[] = cellOffers.map((offer, i) => ({
      offer,
      rank: ranks[i],
      totalRanked,
      trimMismatch: Boolean(
        offer?.vehicleTrim && modalTrim && offer.vehicleTrim !== modalTrim
      ),
      displayTrim: offer?.vehicleTrim ?? null,
    }));

    return { vehicleModel: model, cells, modalTrim };
  });
}

// ---------------------------------------------------------------------------
// KPI helpers
// ---------------------------------------------------------------------------

export interface ReportKpis {
  leaseModelCount: number;
  financeOfferCount: number;
  cashOfferCount: number;
  serviceOfferCount: number;
  complianceCounts: Record<string, number>;
}

export function computeKpis(
  offers: SnapshotOffer[],
  anchorSiteIds: Set<string>
): ReportKpis {
  const anchorOffers = offers.filter(
    (o) => o.siteId && anchorSiteIds.has(o.siteId)
  );

  const leaseModels = new Set(
    anchorOffers
      .filter((o) => o.offerType === "lease" && o.vehicleModel)
      .map((o) => o.vehicleModel!)
  );

  const complianceCounts: Record<string, number> = {};
  for (const o of anchorOffers) {
    if (o.complianceGrade && o.offerType !== "service") {
      complianceCounts[o.complianceGrade] =
        (complianceCounts[o.complianceGrade] ?? 0) + 1;
    }
  }

  return {
    leaseModelCount: leaseModels.size,
    financeOfferCount: anchorOffers.filter((o) => o.offerType === "finance")
      .length,
    cashOfferCount: anchorOffers.filter((o) => o.offerType === "cash").length,
    serviceOfferCount: anchorOffers.filter((o) => o.offerType === "service")
      .length,
    complianceCounts,
  };
}

// ---------------------------------------------------------------------------
// Rule-based narrative generation
// ---------------------------------------------------------------------------

/** One-sentence insight for the lease grid. */
export function leaseNarrative(dealers: DealerCol[], rows: GridRow[]): string {
  const anchor = dealers.find((d) => d.isPrimary);
  if (!anchor || rows.length === 0) return "";

  const anchorIdx = dealers.indexOf(anchor);
  const wins: string[] = [];
  const gaps: string[] = [];

  for (const row of rows) {
    const cell = row.cells[anchorIdx];
    if (!cell.offer) {
      gaps.push(row.vehicleModel);
    } else if (cell.rank === 1 && cell.totalRanked > 1) {
      wins.push(row.vehicleModel);
    }
  }

  // DAS comparison
  const dasValues = rows
    .flatMap((r) =>
      r.cells.map((c, i) => ({
        das: c.offer?.dueAtSigning ?? null,
        isAnchor: i === anchorIdx,
        siteName: dealers[i].siteName,
      }))
    )
    .filter((x) => x.das !== null) as {
    das: number;
    isAnchor: boolean;
    siteName: string;
  }[];

  const anchorDas = dasValues.find((x) => x.isAnchor)?.das;
  const maxDas = dasValues.length
    ? Math.max(...dasValues.map((x) => x.das))
    : null;

  const parts: string[] = [];

  if (wins.length > 0) {
    parts.push(
      `${anchor.siteName} has the lowest advertised payment on ${wins.join(", ")}.`
    );
  }
  if (gaps.length > 0) {
    parts.push(`No lease advertised for ${gaps.join(", ")}.`);
  }
  if (anchorDas !== null && maxDas !== null && anchorDas === maxDas && dasValues.length > 1) {
    parts.push(
      `Note: ${anchor.siteName}'s ${fmtMoney(anchorDas)} due-at-signing is the highest in the set — headline payments are not apples-to-apples.`
    );
  }

  return parts.join(" ") || "Compare advertised lease payments and terms below.";
}

/** One-sentence insight for the finance grid. */
export function financeNarrative(dealers: DealerCol[], rows: GridRow[]): string {
  const anchor = dealers.find((d) => d.isPrimary);
  if (!anchor || rows.length === 0) return "";

  const anchorIdx = dealers.indexOf(anchor);
  const wins: string[] = [];
  const losses: string[] = [];

  for (const row of rows) {
    const cell = row.cells[anchorIdx];
    if (!cell.offer) continue;
    if (cell.rank === 1 && cell.totalRanked > 1) wins.push(row.vehicleModel);
    if (cell.rank === cell.totalRanked && cell.totalRanked > 1)
      losses.push(row.vehicleModel);
  }

  const parts: string[] = [];
  if (wins.length > 0)
    parts.push(
      `${anchor.siteName} leads on ${wins.join(", ")} APR.`
    );
  if (losses.length > 0)
    parts.push(
      `Competitors beat ${anchor.siteName} on ${losses.join(", ")}.`
    );
  return parts.join(" ") || "Compare advertised finance rates below.";
}

/** One-sentence insight for the cash grid. */
export function cashNarrative(dealers: DealerCol[], rows: GridRow[]): string {
  const anchor = dealers.find((d) => d.isPrimary);
  if (!anchor || rows.length === 0) return "";

  const anchorIdx = dealers.indexOf(anchor);
  const anchorAdvertises = rows.some((r) => r.cells[anchorIdx].offer !== null);

  if (!anchorAdvertises) {
    const advertisers = dealers
      .filter((_, i) => i !== anchorIdx && rows.some((r) => r.cells[i].offer))
      .map((d) => d.siteName);
    if (advertisers.length > 0)
      return `${anchor.siteName} does not currently advertise a purchase price; ${advertisers.join(", ")} ${advertisers.length === 1 ? "does" : "do"}.`;
    return "No advertised purchase prices in this set.";
  }
  return "Compare advertised purchase prices below.";
}

/** One-sentence insight for the service grid. */
export function serviceNarrative(
  dealers: DealerCol[],
  anchorOfferCount: number
): string {
  const anchor = dealers.find((d) => d.isPrimary);
  if (!anchor) return "";
  if (anchorOfferCount === 0) return `${anchor.siteName} has no service specials captured this period.`;
  return `${anchor.siteName} advertises ${anchorOfferCount} service ${anchorOfferCount === 1 ? "special" : "specials"} this period.`;
}
