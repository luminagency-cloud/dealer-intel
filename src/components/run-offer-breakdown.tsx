import type { Offer } from "@/lib/db";

// Same basic view as scripts/verify-offers.ts, rendered on the run page:
// whole-run totals plus one padded row per dealer. Plain monospaced text on
// purpose — it's a pre-publish gut check, not a styled report.
const TYPES = ["service", "lease", "finance", "cash", "promotional"] as const;

type BreakdownOffer = Pick<
  Offer,
  "siteId" | "offerType" | "confidence" | "normalizedJson"
>;

const fmtCounts = (c: Record<string, number>) =>
  TYPES.map((t) => `${t}:${String(c[t] ?? 0).padEnd(3)}`).join(" ");

function isReviewed(o: BreakdownOffer): boolean {
  return (
    (o.normalizedJson as { reviewed?: boolean } | null)?.reviewed === true
  );
}

function isPublishable(o: BreakdownOffer, confidenceFloor: number): boolean {
  return (
    isReviewed(o) ||
    o.confidence === null ||
    o.confidence >= confidenceFloor
  );
}

function countByType(offers: BreakdownOffer[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const o of offers) {
    counts[o.offerType] = (counts[o.offerType] ?? 0) + 1;
  }
  return counts;
}

export function RunOfferBreakdown({
  offers,
  siteMeta,
  publishableConfidenceFloor,
}: {
  offers: BreakdownOffer[];
  siteMeta: Record<string, { name: string; platform: string | null }>;
  publishableConfidenceFloor?: number;
}) {
  const total = countByType(offers);
  const publishableOffers =
    publishableConfidenceFloor === undefined
      ? null
      : offers.filter((o) => isPublishable(o, publishableConfidenceFloor));
  const publishableTotal = publishableOffers
    ? countByType(publishableOffers)
    : null;
  const excludedOffers =
    publishableConfidenceFloor === undefined
      ? []
      : offers.filter((o) => !isPublishable(o, publishableConfidenceFloor));
  const excludedTotal = countByType(excludedOffers);

  const byDealer = new Map<string, Record<string, number>>();
  const publishableByDealer = new Map<string, Record<string, number>>();
  for (const o of offers) {
    const c = byDealer.get(o.siteId) ?? {};
    c[o.offerType] = (c[o.offerType] ?? 0) + 1;
    byDealer.set(o.siteId, c);

    if (
      publishableConfidenceFloor !== undefined &&
      isPublishable(o, publishableConfidenceFloor)
    ) {
      const pc = publishableByDealer.get(o.siteId) ?? {};
      pc[o.offerType] = (pc[o.offerType] ?? 0) + 1;
      publishableByDealer.set(o.siteId, pc);
    }
  }

  const dealerRows = [...byDealer.entries()]
    .map(([siteId, counts]) => ({
      siteId,
      name: siteMeta[siteId]?.name ?? siteId.slice(0, 8),
      platform: siteMeta[siteId]?.platform ?? "?",
      counts,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const nameWidth = Math.max(0, ...dealerRows.map((d) => d.name.length));

  const lines = [
    `OFFERS BY TYPE (${offers.length} total)`,
    `  ${fmtCounts(total)}`,
    ...(publishableOffers
      ? [
          ``,
          `REPORT-PUBLISHABLE (${publishableOffers.length} total, confidence >= ${Math.round(
            publishableConfidenceFloor! * 100
          )}% or passed)`,
          `  ${fmtCounts(publishableTotal ?? {})}`,
          `  excluded below floor: ${fmtCounts(excludedTotal)}`,
        ]
      : []),
    ``,
    publishableOffers ? `BY DEALER (all / publishable)` : `BY DEALER`,
    ...dealerRows.map(
      (d) =>
        `  ${d.name.padEnd(nameWidth)}  ${fmtCounts(d.counts)}${
          publishableOffers
            ? ` / ${fmtCounts(publishableByDealer.get(d.siteId) ?? {})}`
            : ""
        } (${d.platform})`
    ),
  ];

  return (
    <pre className="overflow-x-auto rounded-md border border-zinc-200 bg-zinc-50 p-4 font-mono text-xs leading-relaxed text-zinc-800 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
      {lines.join("\n")}
    </pre>
  );
}
