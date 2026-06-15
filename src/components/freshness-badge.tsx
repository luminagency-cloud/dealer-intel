import { FRESHNESS_LABELS, freshnessOf } from "@/lib/freshness";

const STYLES: Record<string, string> = {
  fresh: "bg-green-100 text-green-800",
  stale: "bg-amber-100 text-amber-800",
  never: "bg-zinc-100 text-zinc-500",
};

/** Fresh / Stale / Never indicator for a site's last successful collection. */
export function FreshnessBadge({
  lastCollectedAt,
}: {
  lastCollectedAt: Date | null | undefined;
}) {
  const freshness = freshnessOf(lastCollectedAt);
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STYLES[freshness]}`}
      title={lastCollectedAt ? new Date(lastCollectedAt).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Never collected"}
    >
      {FRESHNESS_LABELS[freshness]}
    </span>
  );
}
