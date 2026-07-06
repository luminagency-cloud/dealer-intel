import { getAnalysisProgressForRuns } from "@/lib/analysis";
import type { GroupCycleStatus, CollectCoverage, AnalyzeCoverage } from "@/lib/db/ops-board";
import type { InventoryFreshnessStatus } from "@/lib/inventory";

/**
 * Shared "how much of this week's work is done" display text — used by the
 * home page and (eventually) `/runs` and `/inventory` so the same coverage
 * numbers read identically everywhere instead of each page formatting its
 * own copy of the same fractions.
 */

/** Joins non-empty fragments with "·", e.g. ["11 of 14 groups", "2 failed", null] → "11 of 14 groups · 2 failed". */
export function joinDetail(parts: (string | null | false)[]): string {
  return parts.filter((p): p is string => Boolean(p)).join(" · ");
}

export function formatCollectDetail(c: CollectCoverage): string {
  if (c.total === 0) return "No groups configured";
  if (c.passing + c.failing + c.running === 0) return "Not started this week";
  return joinDetail([
    `${c.passing} of ${c.total} groups collected`,
    c.failing > 0 ? `${c.failing} failed` : null,
    c.running > 0 ? `${c.running} running` : null,
  ]);
}

/** Sums live (in-memory) analysis progress across every group whose run is
 *  currently analyzing. Only meaningful while at least one group is
 *  "analyzing" — returns null otherwise. */
export function getLiveAnalysisProgress(groups: GroupCycleStatus[]): { processed: number; total: number } | null {
  const runningRunIds = groups
    .filter((g) => g.run?.analysisRunning)
    .map((g) => g.run!.id);
  if (runningRunIds.length === 0) return null;
  return getAnalysisProgressForRuns(runningRunIds);
}

/** `collectPassing` gates whether there's anything to analyze yet — analysis
 *  coverage is meaningless before at least one group has collected something.
 *  `live`, if given, folds in-progress page counts into the "running" fragment. */
export function formatAnalyzeDetail(
  a: AnalyzeCoverage,
  collectPassing: number,
  live: { processed: number; total: number } | null
): string {
  if (collectPassing === 0) return "—";
  return joinDetail([
    `${a.analyzed} of ${a.total} groups analyzed`,
    a.analyzing > 0
      ? live && live.total > 0
        ? `${a.analyzing} running (${live.processed} of ${live.total} pages)`
        : `${a.analyzing} running`
      : null,
    a.pageCount > 0 || a.offerCount > 0 ? `${a.pageCount} pages → ${a.offerCount} ads found` : null,
  ]);
}

export function formatInventoryDetail(status: InventoryFreshnessStatus | null): string {
  if (!status?.ranThisWeek) return "Not run this week";
  return joinDetail([
    `${status.okCount} of ${status.totalActiveSites} dealers`,
    status.failedCount > 0 ? `${status.failedCount} failed` : null,
    status.lastRunAt
      ? `last run ${status.lastRunAt.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
      : null,
  ]);
}
