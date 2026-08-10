import assert from "node:assert/strict";

import { isSameLocation } from "../src/lib/chrome-collector";
import {
  BANNED_PATTERN_SOURCES,
  DISCOVERY_EXCLUSIONS,
  DISCOVERY_KEYWORDS,
  exclusionPattern,
  isHomepageUrl,
  keywordPattern,
  missionTargetsHomepage,
  navLinkIsExcluded,
  navTextMatchesKeyword,
  pageIsBannedProgram,
  urlIsBannedProgram,
} from "../src/lib/collector/mission-knowledge";

// Regression guard for the Chrome collector handing every mission the dealer
// homepage: service_specials screenshotted Anchor Nissan's hero carousel, then
// memorized the homepage as the mission's page so every later run repeated it.

const HOME = "https://www.anchor-nissan.com/";

// Anchor Nissan's real nav, as the extension reads it off the rendered page:
// link text already flattened and lowercased, hrefs already absolute. The app
// never fetches this itself — see the note above the pattern-parity block.
const links = [
  { text: "new inventory", href: `${HOME}new-inventory/index.htm` },
  { text: "service & parts specials", href: `${HOME}promotions/service/index.htm` },
  {
    text: "current offers",
    href: `${HOME}global-incentives-search/index.htm`,
  },
];

// Keyword match, then exclusions — the order the extension applies them in.
function firstMatch(missionType: "service_specials" | "finance_offers") {
  for (const keyword of DISCOVERY_KEYWORDS[missionType]) {
    const hit = links.find(
      (link) =>
        navTextMatchesKeyword(link.text, keyword) &&
        !navLinkIsExcluded(link.text, link.href, missionType)
    );
    if (hit) return hit.href;
  }
  return null;
}
assert.equal(
  firstMatch("service_specials"),
  "https://www.anchor-nissan.com/promotions/service/index.htm"
);
// Anchor Nissan's only finance-ish nav entry is labelled "Current Offers" but
// points at the OEM's national incentive search. We never use those, so nav
// discovery must come back empty here and let the canonical platform path win.
assert.equal(firstMatch("finance_offers"), null);

// Keyword matching tolerates the dealer's own words inside the phrase, which
// plain substring matching did not: measured on the live list, "New Subaru
// Specials" / "New Volvo Special Offers" / "Exclusive Colonial Subaru Specials"
// were the correct finance page on nine dealers and matched none of them.
assert.equal(navTextMatchesKeyword("new subaru specials", "new specials"), true);
assert.equal(navTextMatchesKeyword("new volvo special offers", "new specials"), true);
assert.equal(
  navTextMatchesKeyword("exclusive colonial subaru specials", "new specials"),
  false // no "new" in the label, so this keyword legitimately does not apply
);
assert.equal(navTextMatchesKeyword("subaru service & parts specials", "service special"), true);
assert.equal(navTextMatchesKeyword("service and parts offers", "service offer"), true);

// Order still matters, so the phrase can't match backwards...
assert.equal(navTextMatchesKeyword("specials for new cars", "new specials"), false);
// ...the gap is bounded, so two unrelated words can't be bridged...
assert.equal(
  navTextMatchesKeyword("new inventory search results specials", "new specials"),
  false
);
// ...and words match whole, not as fragments.
assert.equal(navTextMatchesKeyword("servicer specialist", "service special"), false);
assert.equal(navTextMatchesKeyword("renew specials", "new specials"), false);
// ...and a plural is only tolerated where the dealer actually pluralizes. A
// blanket optional "s" made "new" match "News", so a dealer's "News & Specials"
// nav group was picked as its finance offers page.
assert.equal(navTextMatchesKeyword("news & specials", "new specials"), false);
assert.equal(navTextMatchesKeyword("news, events & specials", "new specials"), false);
// The keyword's own plural still matches either way.
assert.equal(navTextMatchesKeyword("offer & incentive", "offers & incentives"), true);

// Exclusions: pages that match a keyword but are not the dealer's own
// advertised specials.
const X = (text: string, href: string, m: "finance_offers" | "service_specials") =>
  navLinkIsExcluded(text, href, m);
assert.equal(X("military incentive program", "/military.htm", "finance_offers"), true);
assert.equal(X("pre-owned vehicle specials", "/used.htm", "finance_offers"), true);
assert.equal(X("apply for financing", "/apply.htm", "finance_offers"), true);
assert.equal(X("subaru lease returns", "/lease-return.htm", "finance_offers"), true);

// OEM national incentive pages are banned outright, and matched on the href
// because the label hides them: Anchor Nissan calls this one "Current Offers".
// They are identical across every store selling the brand, so an offer read off
// one is not that dealer's offer.
assert.equal(X("current offers", "/global-incentives-search/index.htm", "finance_offers"), true);
assert.equal(X("national offers", "/global-incentives/index.htm", "finance_offers"), true);
assert.equal(X("service coupons", "/global-incentives/index.htm", "service_specials"), true);

// OEM parts/service coupon programs are banned on the same grounds: Mopar for
// Stellantis stores, ACDelco for GM. Elmwood CDJR was resolving to
// /mopar-service-coupons.htm while its own "Service Specials" page sat unused.
assert.equal(X("mopar service coupons", "/mopar-service-coupons.htm", "service_specials"), true);
assert.equal(X("service coupons", "/mopar-service-coupons.htm", "service_specials"), true);
assert.equal(X("mopar service coupons", "/service-coupons.htm", "service_specials"), true);
assert.equal(X("acdelco service specials", "/acdelco-specials.htm", "service_specials"), true);
assert.equal(X("ac delco coupons", "/ac-delco-coupons.htm", "service_specials"), true);
// The ban also applies to a URL reached by redirect, not just a nav label.
assert.equal(urlIsBannedProgram("https://www.elmwoodcdjr.com/mopar-service-coupons.htm"), true);
assert.equal(urlIsBannedProgram("https://www.anchor-nissan.com/global-incentives/index.htm"), true);
assert.equal(urlIsBannedProgram("https://www.elmwoodcdjr.com/promotions/service/index.htm"), false);

// And to the page's own title/h1, which is the only thing that catches a
// program served from a neutral path: Elmwood's /coupons.htm is titled
// "Coupons for Mopar Parts And Service".
assert.equal(
  pageIsBannedProgram(`<title>Coupons for Mopar Parts And Service | Elmwood CDJR</title>`),
  true
);
assert.equal(pageIsBannedProgram(`<h1>ACDelco Service Coupons</h1>`), true);
assert.equal(
  pageIsBannedProgram(`<title>Service Specials | Elmwood Chrysler Dodge Jeep Ram</title>`),
  false
);
// A dealer's real specials page may mention the parts brand in body copy —
// that is not the same as being the OEM program, so only title/h1 are read.
assert.equal(
  pageIsBannedProgram(`<title>Service Specials</title><p>We install genuine Mopar parts.</p>`),
  false
);

// ...but the dealer's own pages must survive all of that.
assert.equal(X("new subaru specials", "/promotions/new/index.htm", "finance_offers"), false);
assert.equal(X("current incentives", "/current-incentives.htm", "finance_offers"), false);
// A path that merely contains "incentive" is not the global one.
assert.equal(X("new subaru incentives", "/new-subaru-incentives.htm", "finance_offers"), false);
// Service discovery has no label exclusions; a service coupon page is the target.
assert.equal(X("used car service coupons", "/service-coupons.htm", "service_specials"), false);
// Exclusion terms are whole words. Substring matching dropped good links on
// "used" hiding inside another word.
assert.equal(X("customer-focused offers", "/specials.htm", "finance_offers"), false);
assert.equal(X("unused inventory specials", "/specials.htm", "finance_offers"), false);

// A site root is never a specials page, whoever owns the host. The old check
// compared against the dealer's own url only, which misses a front page served
// from another host — legitimate after a sale (Station Buick GMC answers as
// checkvachonbuickgmc.com), and still not a specials page. Measured Aug 7 2026:
// 14 of 21 dealers had finance and service resolve to a path that redirected to
// a homepage in Chrome and recorded as success.
assert.equal(isHomepageUrl("https://www.anchor-nissan.com/"), true);
assert.equal(isHomepageUrl("https://www.anchor-nissan.com"), true);
assert.equal(isHomepageUrl("https://www.checkvachonbuickgmc.com/"), true);
assert.equal(isHomepageUrl("https://www.balisenissanri.com/service-specials/"), false);
assert.equal(isHomepageUrl("https://www.mastria.com/promotions/"), false);
assert.equal(isHomepageUrl("not-a-url"), false);

// Only homepage missions may legitimately collect the homepage.
assert.equal(missionTargetsHomepage("homepage_offers"), true);
assert.equal(missionTargetsHomepage("promotional_banners"), true);
assert.equal(missionTargetsHomepage("service_specials"), false);
assert.equal(missionTargetsHomepage("finance_offers"), false);

// The memorize guard: a mission landing back on the homepage must not pin
// itself there. Trailing slashes and http/https differ across dealer configs.
assert.equal(isSameLocation("https://www.anchor-nissan.com/", "https://www.anchor-nissan.com"), true);
assert.equal(isSameLocation("http://www.anchor-nissan.com", "https://www.anchor-nissan.com/"), true);
assert.equal(
  isSameLocation("https://www.anchor-nissan.com/promotions/service/index.htm", HOME),
  false
);
assert.equal(isSameLocation("not-a-url", HOME), false);

// www vs apex is the case that actually broke this. Dealers are configured at
// the apex and every one of them redirects a browser to www, so a mission that
// landed on the homepage came back under a host that strict comparison called
// different — and the guard waved it through on 28 site/mission rows, pinning
// finance/service to the dealer's front page on every later run.
assert.equal(isSameLocation("https://www.balisenissanri.com/", "https://balisenissanri.com"), true);
assert.equal(isSameLocation("https://balisenissanri.com/", "https://www.balisenissanri.com"), true);
// Normalizing www must not collapse genuinely different hosts or paths.
assert.equal(isSameLocation("https://www.tascakia.com/", "https://www.tascacdjrf.com"), false);
assert.equal(
  isSameLocation("https://balisenissanri.com/service-specials/", "https://www.balisenissanri.com"),
  false
);

// The Chrome extension runs this same discovery inside the operator's browser —
// it has to, because 16 of 62 dealers (Speedcraft, the Tasca and Nucar groups,
// Mastria) answer server-side fetch with a Cloudflare 403 and load normally in
// Chrome. It gets the rules as regex SOURCES rather than a second copy of the
// logic, so those sources must decide exactly what the functions here decide.
const applies = (source: string | null, text: string) =>
  source !== null && new RegExp(source, "i").test(text);
for (const keyword of [
  ...DISCOVERY_KEYWORDS.service_specials,
  ...DISCOVERY_KEYWORDS.finance_offers,
]) {
  for (const label of [
    "service specials",
    "service & parts specials",
    "nissan service & parts coupons near providence",
    "news & specials",
    "new subaru specials",
    "servicer specialist",
    "current offers",
  ]) {
    assert.equal(
      applies(keywordPattern(keyword), label),
      navTextMatchesKeyword(label, keyword),
      `keywordPattern disagrees for "${keyword}" on "${label}"`
    );
  }
}
for (const term of DISCOVERY_EXCLUSIONS.finance_offers) {
  for (const label of ["pre-owned specials", "customer-focused offers", "apply now"]) {
    assert.equal(
      applies(exclusionPattern(term), label),
      navLinkIsExcluded(label, "/x.htm", "finance_offers") &&
        new RegExp(exclusionPattern(term), "i").test(label),
      `exclusionPattern disagrees for "${term}" on "${label}"`
    );
  }
}
// Speedcraft Nissan renamed its service page to
// /providence-nissan-service-parts-coupons/ and hides it in a submenu, so the
// menu label is the only stable handle on it.
assert.equal(
  navTextMatchesKeyword("service & parts specials", "service special"),
  true
);
assert.equal(
  navTextMatchesKeyword(
    "nissan service & parts coupons near providence",
    "service coupon"
  ),
  true
);
assert.equal(BANNED_PATTERN_SOURCES.length > 0, true);
assert.equal(
  BANNED_PATTERN_SOURCES.some((source) =>
    new RegExp(source, "i").test("/global-incentives-search/index.htm")
  ),
  true
);

console.log("Mission URL discovery regression checks passed.");
