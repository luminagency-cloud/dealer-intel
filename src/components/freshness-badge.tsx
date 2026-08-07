import { FRESHNESS_LABELS, freshnessOf } from "@/lib/freshness";
import { fmtDateTime } from "@/lib/fmt-date";

const STYLES: Record<string, string> = {
  fresh: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  stale: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
  never: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200",
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
      title={lastCollectedAt ? fmtDateTime(lastCollectedAt) : "Never collected"}
    >
      {FRESHNESS_LABELS[freshness]}
    </span>
  );
}
