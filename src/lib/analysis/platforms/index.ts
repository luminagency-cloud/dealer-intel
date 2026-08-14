import { extractOffers, type ExtractedOffer, type ExtractHints } from "../extract";

/**
 * Platform-keyed extraction registry — mirrors the pattern already established
 * for collection in `extension/inventory/adapters/` (one file per platform,
 * self-registering `{ id, platforms: string[], collect }`, dispatched off
 * `sites.platform`). Collection already needs this because a specials page's
 * DOM shape genuinely differs by CMS (ddc, dealer-inspire, dealer-alchemist,
 * dealer-on, apollo, sokal, ...); analysis today gets by on symptom-based
 * generic heuristics instead (see `extract.ts` — "deliberately NOT keyed on
 * any platform-specific token").
 *
 * No adapter is registered yet: extract.ts's generic pass is still correct for
 * every known platform, so there's nothing platform-specific to encode. This
 * file is the seam — when a platform needs its own DOM handling (the way
 * collection's inventory adapters do), it registers here as one small file,
 * same shape as `extension/inventory/adapters/*.js`, with no change to any
 * caller.
 */
export interface PlatformAdapter {
  id: string;
  /** Values of `sites.platform` this adapter handles — matched after
   *  `normalizePlatform`, so "Dealer.com (DDC)" and "ddc" both match "ddc". */
  platforms: string[];
  extractOffers(html: string, hints: ExtractHints): ExtractedOffer[];
}

const platformAdapters: PlatformAdapter[] = [];

function normalizePlatform(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export function resolvePlatformAdapter(
  platform: string | null | undefined
): PlatformAdapter | null {
  const normalized = normalizePlatform(platform);
  if (!normalized) return null;
  return (
    platformAdapters.find((adapter) =>
      adapter.platforms.some((candidate) => normalizePlatform(candidate) === normalized)
    ) ?? null
  );
}

/** Extraction entry point for HTML snapshots: a registered platform adapter's
 *  own extraction if `sites.platform` matches one, otherwise the generic
 *  DOM-shape-heuristic pass every platform relies on today. */
export function extractOffersForPlatform(
  html: string,
  hints: ExtractHints,
  platform: string | null | undefined
): ExtractedOffer[] {
  return resolvePlatformAdapter(platform)?.extractOffers(html, hints) ?? extractOffers(html, hints);
}
