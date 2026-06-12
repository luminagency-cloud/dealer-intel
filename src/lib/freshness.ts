/**
 * Collection freshness (Phase 8). A site collected within the window is
 * "current" and ready for analysis; older collections are stale and want a
 * re-run. The window matches the roadmap's weekly operational cadence.
 */

export const FRESHNESS_WINDOW_DAYS = 7;

const WINDOW_MS = FRESHNESS_WINDOW_DAYS * 24 * 60 * 60 * 1000;

export type Freshness = "fresh" | "stale" | "never";

export function freshnessOf(lastCollectedAt: Date | null | undefined): Freshness {
  if (!lastCollectedAt) return "never";
  return Date.now() - lastCollectedAt.getTime() <= WINDOW_MS ? "fresh" : "stale";
}

export const FRESHNESS_LABELS: Record<Freshness, string> = {
  fresh: "Fresh",
  stale: "Stale",
  never: "Never",
};
