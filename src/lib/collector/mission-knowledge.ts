import type { MissionType } from "@/lib/db";
import type { ExploreOptions } from "./engine";

/**
 * Per-mission-type collection knowledge (Phase 6): likely URL paths,
 * navigation-discovery keywords, and exploration behavior. This is the only
 * place mission types influence collection — the engine stays generic.
 */

/** Common dealer-platform paths tried when a mission has no configured URL.
 *  Ordered most → least common across Dealer.com / DealerOn / Dealer Inspire. */
export const PLATFORM_DEFAULT_PATHS: Record<MissionType, string[]> = {
  homepage_offers: [],
  finance_offers: [
    "current-offers",
    "new-vehicle-specials",
    "finance-specials",
    "offers",
    "incentives",
    "promotions",
    "specials",
  ],
  service_specials: [
    "service-specials",
    "service-coupons",
    "service-offers",
    "specials/service",
    "service-and-parts-specials",
    "couponspecials",
  ],
  promotional_banners: [],
};

/** Nav-link text patterns used for discovery when default paths miss. */
export const DISCOVERY_KEYWORDS: Record<MissionType, string[]> = {
  homepage_offers: [],
  finance_offers: ["finance special", "current offer", "new specials", "offers & incentives", "incentives", "new vehicle special"],
  service_specials: ["service special", "service coupon", "service offer", "parts special", "service & parts special"],
  promotional_banners: [],
};

/** Exploration behavior per mission type. Disclaimers are captured for all
 *  offer missions — they are first-class evidence (AD-005). */
export const MISSION_EXPLORATION: Record<MissionType, ExploreOptions> = {
  // Headline offers rotate through the hero carousel.
  homepage_offers: { carousels: true, disclaimers: true },
  promotional_banners: { carousels: true, disclaimers: true },
  // Offer pages frequently organize content in tabs and accordions.
  finance_offers: { tabs: true, accordions: true, disclaimers: true },
  // Service coupon pages don't have offer-modal disclosure buttons — tabs and
  // accordions organize coupons by category; disclaimers are boilerplate links
  // (Privacy Policy etc.) that produce noise, not evidence.
  service_specials: { tabs: true, accordions: true, disclaimers: false },
};

/** Missions without configured or discoverable URLs fall back to the
 *  site homepage (always true for homepage missions). */
export function missionTargetsHomepage(missionType: MissionType): boolean {
  return (
    missionType === "homepage_offers" || missionType === "promotional_banners"
  );
}

/** Missions where a reachable-but-empty page is a real problem worth guarding
 *  against: a dealer's generic "/promotions" guess path routinely redirects to
 *  a nav hub (links to New Inventory / Service / About, no cards) rather than
 *  the actual specials, and that hub still returns 200 — so plain reachability
 *  isn't enough signal to trust it. Homepage/banner missions are teasers by
 *  design (thin content is expected there), so they're exempt. */
export const SIGNAL_CHECKED_MISSIONS: MissionType[] = [
  "finance_offers",
  "service_specials",
];

/** Cheap, collector-local heuristic for "does this page carry a priced offer
 *  at all" — deliberately NOT the analysis extractor (collection must not
 *  depend on analysis logic; Collect and Analyze are separate phases, see
 *  AGENTS.md). Used only to rank discovery candidates, never to produce an
 *  offer record. Shared by both collectors so they agree on what counts as a
 *  real offer page. */
export function pageHasOfferSignal(html: string): boolean {
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return (
    /\$\s?[\d,]{2,7}\s*(?:\/|per\s+|a\s+)?\s*(?:mo(?:nthly)?\b|month\b)/i.test(text) ||
    /\d+(?:\.\d+)?\s*%\s*(?:APR\b|off\b|financing\b)/i.test(text) ||
    /\$\s?[\d,]{1,7}\s*(?:cash back|customer cash|rebate|off\b)/i.test(text)
  );
}
