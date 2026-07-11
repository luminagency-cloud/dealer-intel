import type { Offer } from "@/lib/db";

// Same view as scripts/verify-offers.ts, rendered on the run page: whole-run
// totals plus one padded row per dealer. Plain monospaced text on purpose —
// it's a pre-publish gut check, not a styled report.
const TYPES = ["service", "lease", "finance", "cash"] as const;

const fmtCounts = (c: Record<string, number>) =>
  TYPES.map((t) => `${t}:${String(c[t] ?? 0).padEnd(3)}`).join(" ");

export function RunOfferBreakdown({
  offers,
  siteMeta,
}: {
  offers: Pick<Offer, "siteId" | "offerType">[];
  siteMeta: Record<string, { name: string; platform: string | null }>;
}) {
  const total: Record<string, number> = {};
  const byDealer = new Map<string, Record<string, number>>();
  for (const o of offers) {
    total[o.offerType] = (total[o.offerType] ?? 0) + 1;
    const c = byDealer.get(o.siteId) ?? {};
    c[o.offerType] = (c[o.offerType] ?? 0) + 1;
    byDealer.set(o.siteId, c);
  }

  const dealerRows = [...byDealer.entries()]
    .map(([siteId, counts]) => ({
      name: siteMeta[siteId]?.name ?? siteId.slice(0, 8),
      platform: siteMeta[siteId]?.platform ?? "?",
      counts,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const nameWidth = Math.max(0, ...dealerRows.map((d) => d.name.length));

  const lines = [
    `OFFERS BY TYPE (${offers.length} total)`,
    `  ${fmtCounts(total)}`,
    ``,
    `BY DEALER`,
    ...dealerRows.map(
      (d) => `  ${d.name.padEnd(nameWidth)}  ${fmtCounts(d.counts)} (${d.platform})`
    ),
  ];

  return (
    <pre className="overflow-x-auto rounded-md border border-zinc-200 bg-zinc-50 p-4 font-mono text-xs leading-relaxed text-zinc-800 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
      {lines.join("\n")}
    </pre>
  );
}
