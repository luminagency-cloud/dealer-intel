import type { MissionType } from "@/lib/db";
import type { ExploreOptions } from "./engine";

/**
 * Per-mission-type collection knowledge (Phase 6): likely URL paths,
 * navigation-discovery keywords, and exploration behavior. This is the only
 * place mission types influence collection — the engine stays generic.
 */

/** Paths tried after the dealer's own nav has had a turn.
 *
 *  Dealer.com's `/promotions/{new,service}/index.htm` leads: 35 of the 38
 *  Dealer.com stores answer both, and Dealer.com is over half the list. Their
 *  absence is what made these guesses look like they "404 on nearly every
 *  site" and left discovery leaning on nav crawling.
 *
 *  They stay *behind* nav, though. A link the dealer's own menu labels as
 *  specials is stronger evidence than any path convention, and putting paths
 *  first overrode 43 correct dealer-authored pages in testing — including
 *  Westerly's `/westerly-service-specials.htm` and Napoli's
 *  `/monthly-specials.htm`. */
export const PLATFORM_DEFAULT_PATHS: Record<MissionType, string[]> = {
  homepage_offers: [],
  finance_offers: [
    "promotions/new/index.htm",
    "current-offers",
    "new-vehicle-specials",
    "finance-specials",
    // Deliberately no bare "offers" / "incentives" / "promotions" / "specials".
    // Those are fishing: they resolve to a nav hub or a section index on plenty
    // of dealers, and a mission that lands on one has not found the specials
    // page, it has found something shaped like it. A mission with no real page
    // must fail, not settle.
  ],
  service_specials: [
    "promotions/service/index.htm",
    "service-specials",
    "service-coupons",
    "service-offers",
    "specials/service",
    "service-and-parts-specials",
    "couponspecials",
  ],
  promotional_banners: [],
};

/** Nav-link text patterns used for discovery when default paths miss.
 *
 *  Matched by `navTextMatchesKeyword`, not substring — dealers name these links
 *  after their own brand, so the keyword's words have to survive an insertion.
 *  Ordered most → least specific: the first keyword that hits wins, so a
 *  narrow phrase must come before a broad one. */
export const DISCOVERY_KEYWORDS: Record<MissionType, string[]> = {
  homepage_offers: [],
  finance_offers: [
    "finance special",
    "current offer",
    "new specials",
    "new vehicle special",
    "offers & incentives",
    // Last resort, and narrow on purpose: "current incentives" is a real
    // dealer-authored page (Elmwood). Bare "incentives" is not usable — it
    // matches "Military Incentive Program" and the OEM's national incentive
    // search just as happily.
    "current incentives",
  ],
  service_specials: [
    "service special",
    "service coupon",
    "service offer",
    "service & parts special",
    // No standalone "parts special". A dealer that splits the two — Elmwood
    // CDJR has both `/specials/parts.htm` and a separate "Service Specials"
    // page — was matching the parts page first, which is a different
    // department's offers, not this mission's.
  ],
  promotional_banners: [],
};

/** Nav-link text that disqualifies a link regardless of keyword match.
 *
 *  These are pages that read like an offers page to a keyword but are not the
 *  dealer's advertised specials: a rebate program for one buyer class, a
 *  used-inventory feed, or a credit-application funnel. Measured on the live
 *  list, without this the finance mission resolved to a military-rebate page on
 *  two dealers and a pre-owned inventory page on a third. */
export const DISCOVERY_EXCLUSIONS: Record<MissionType, string[]> = {
  homepage_offers: [],
  promotional_banners: [],
  finance_offers: [
    "military",
    "national offer",
    "pre-owned",
    "preowned",
    "used",
    "lease return",
    "apply",
    "application",
    "credit",
    "trade",
  ],
  service_specials: [],
};

/** Manufacturer programs, banned outright for every mission.
 *
 *  These are never dealer offers. They are the manufacturer's own nationwide
 *  content — identical across every store selling that brand — so a price read
 *  off one is not attributable to the dealer being measured, and publishing it
 *  as that dealer's offer is simply wrong.
 *
 *  Two families, both confirmed on the live list:
 *
 *  - National incentive search (`/global-incentives-search/`). The label hides
 *    it: Anchor Nissan's nav calls it "Current Offers".
 *  - OEM parts/service coupon programs — Mopar for Stellantis stores, ACDelco
 *    for GM. Elmwood CDJR resolved to `/mopar-service-coupons.htm` ("Mopar
 *    Service Coupons") while its own `/promotions/service/index.htm` ("Service
 *    Specials") sat right there.
 *
 *  Matched on the label as well as the href, because a dealer can put the
 *  program on a neutral path and name it in the link text, or the reverse. */
const BANNED_PATTERNS = [
  /\bglobal[-\s]?incentives?(?:[-\s]?search)?\b/i,
  /\bmopar\b/i,
  /\bac[-\s]?delco\b/i,
];

/** True when a nav link is disqualified for this mission, by label or target. */
export function navLinkIsExcluded(
  text: string,
  href: string,
  missionType: MissionType
): boolean {
  if (BANNED_PATTERNS.some((p) => p.test(href) || p.test(text))) return true;
  // Whole-word, like navTextMatchesKeyword — a substring test fires inside
  // longer words and silently drops good links: "used" hits "customer-focused
  // offers" and "unused inventory specials". A trailing plural is still
  // tolerated so "lease return" catches "Subaru Lease Returns".
  return DISCOVERY_EXCLUSIONS[missionType].some((term) =>
    new RegExp(
      `(?:^|[^a-z0-9])${escapeRegExp(term)}s?(?:[^a-z0-9]|$)`,
      "i"
    ).test(text)
  );
}

/** True when a URL is a banned manufacturer program. Applied to platform
 *  default paths and to the URL a candidate actually landed on, so the ban
 *  cannot be walked around by a redirect or a lucky path guess. */
export function urlIsBannedProgram(url: string): boolean {
  return BANNED_PATTERNS.some((p) => p.test(url));
}

/** True when the page itself announces a banned program in its title or first
 *  heading, whatever its URL and nav label said.
 *
 *  Needed because the path can be perfectly neutral: Elmwood CDJR serves
 *  "Coupons for Mopar Parts And Service" from `/coupons.htm`, which no
 *  URL-or-label rule can catch, while its own "Service Specials" page sits at
 *  `/promotions/service/index.htm`. Deliberately limited to the title and h1 —
 *  a dealer's genuine service specials page may well *mention* Mopar parts in
 *  the body copy, and that is not the same as being the OEM's coupon program. */
export function pageIsBannedProgram(html: string): boolean {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "";
  const headings = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)]
    .map((match) => match[1])
    .join(" ");
  const text = `${title} ${headings}`.replace(/<[^>]+>/g, " ");
  return BANNED_PATTERNS.some((pattern) => pattern.test(text));
}

/** True when every word of `keyword` appears in `text`, in order, on whole-word
 *  boundaries. Dealer nav labels their own specials page after the brand and
 *  the store — "New **Subaru** Specials", "Exclusive **Colonial Subaru**
 *  Specials", "New **Volvo** Special Offers" — so a plain `text.includes()`
 *  missed the correct link on a third of the live dealer list and dropped the
 *  mission to a platform guess path that 404s. Matching in order (rather than
 *  as an unordered bag) is what keeps "service special" from matching a
 *  "Special Financing on Service Contracts" link. */
export function navTextMatchesKeyword(text: string, keyword: string): boolean {
  const words = keyword.split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  // Number is ignored on the nouns the dealer actually pluralizes: the trailing
  // word of every keyword, plus any word already written plural in the list
  // ("offers & incentives"). Those are stemmed of a trailing "s" and allowed an
  // optional one, which is what lets "new specials" match "New Volvo Special
  // Offers". Every other word must match exactly — granting a blanket optional
  // "s" turned "new" into /new s?/, which matches "News", so a dealer's
  // "News & Specials" nav group was picked as its finance offers page.
  // Between words, allow at most MAX_INSERTED_WORDS of the dealer's own naming
  // ("new **subaru** specials"). Unbounded would let "new specials" match a
  // sentence that merely contains both words.
  const gap = `[^a-z0-9]+(?:[a-z0-9]+[^a-z0-9]+){0,${MAX_INSERTED_WORDS}}`;
  const body = words
    .map((word, index) =>
      index === words.length - 1 || /s$/.test(word)
        ? `${escapeRegExp(word.replace(/s$/, ""))}s?`
        : escapeRegExp(word)
    )
    .join(gap);
  return new RegExp(`(?:^|[^a-z0-9])${body}(?:[^a-z0-9]|$)`, "i").test(text);
}

/** How many of the dealer's own words may sit between two keyword words.
 *  Two covers brand + store ("Exclusive Colonial Subaru Specials"). */
const MAX_INSERTED_WORDS = 2;

/** Ceiling on *nav-discovered* candidate pages probed per mission. Discovery
 *  keeps every nav link a keyword matches, and a broad keyword like
 *  "incentives" hits several on a big store — without this the Playwright
 *  collector would load all of them. Shared so both collectors probe the same
 *  amount.
 *
 *  Deliberately NOT a cap on the combined list. The platform default paths are
 *  a short fixed list that always gets its turn: capping nav + defaults
 *  together silently dropped every default path on a store whose nav matched
 *  six keywords, and truncated service_specials (seven paths) even on a store
 *  with no nav matches at all. */
export const MAX_DISCOVERY_CANDIDATES = 6;

/** True when two URLs point at the same page, ignoring a trailing slash and a
 *  leading `www.`. Lives here rather than in either collector because both use
 *  it to reject a candidate that leads back to the dealer homepage.
 *
 *  The `www.` normalization is load-bearing, not tidiness. Most dealers are
 *  configured at the apex (`https://balisenissanri.com`) and every one of them
 *  redirects a browser to `www.`, so a mission that landed on the homepage came
 *  back as `https://www.balisenissanri.com/` — a different host under strict
 *  comparison. That waved the homepage past every guard built on this function:
 *  discovery kept homepage candidates, and the collector's memorization guard
 *  pinned `finance_offers`/`service_specials` to the dealer's front page on 28
 *  site/mission rows, where it then beat discovery on every later run. */
export function isSameLocation(left: string, right: string): boolean {
  try {
    const a = new URL(left);
    const b = new URL(right);
    return (
      a.host.replace(/^www\./i, "") === b.host.replace(/^www\./i, "") &&
      a.pathname.replace(/\/$/, "") === b.pathname.replace(/\/$/, "")
    );
  } catch {
    return false;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
