import assert from "node:assert/strict";

import { isMenuToggle, isSameLocation, pageLinks } from "../src/lib/chrome-collector";
import {
  DISCOVERY_KEYWORDS,
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

// Real Dealer.com nav shape: relative hrefs, markup inside the anchor text,
// off-site social links, and a javascript: href that must not throw.
const NAV = `
  <nav>
    <a href="/new-inventory/index.htm">New <span>Inventory</span></a>
    <a href="/promotions/service/index.htm">Service &amp; Parts Specials</a>
    <a href="http://www.anchor-nissan.com/global-incentives-search/index.htm">
      Current <em>Offers</em>
    </a>
    <a href="https://www.facebook.com/anchornissan">Facebook</a>
    <a href="javascript:void(0)">Menu</a>
    <a href="/about.htm"></a>
  </nav>
`;

const links = pageLinks(NAV, HOME);

// Same-host only, absolute hrefs, lowercased text, empty text dropped.
assert.deepEqual(
  links.map((link) => link.text),
  ["new inventory", "service & parts specials", "current offers"]
);
assert.equal(
  links[1].href,
  "https://www.anchor-nissan.com/promotions/service/index.htm"
);

// A dropdown group header is not a destination. This is Gengras Subaru's real
// markup: the "Finance & Specials" menu opens a submenu but its own href is the
// finance department, so reading it as a link sent finance_offers to
// /financing/index.htm instead of the specials page nested underneath.
const MENU = `
  <li class="dropdown">
    <a data-toggle="dropdown" href="/financing/index.htm"
       class="nav-with-children">Finance &amp; Specials</a>
    <ul class="dropdown-menu">
      <li><a href="/promotions/new/index.htm">New Subaru Specials</a></li>
      <li><a href="/apply-for-financing.htm">Get Approved Now</a></li>
    </ul>
  </li>
`;
assert.deepEqual(
  pageLinks(MENU, HOME).map((link) => link.text),
  ["new subaru specials", "get approved now"] // the toggle itself is dropped
);
// Both marker forms are recognized independently.
assert.equal(isMenuToggle(` data-toggle="dropdown" href="/x"`), true);
assert.equal(isMenuToggle(` class="nav-with-children" href="/x"`), true);
assert.equal(isMenuToggle(` class="child" href="/x"`), false);

// Numeric entity references decode too — some platforms emit `&#38;`.
assert.deepEqual(
  pageLinks(`<a href="/x">Offers &#38; Incentives</a>`, HOME).map((l) => l.text),
  ["offers & incentives"]
);

// The keyword match that the homepage fallback used to bypass entirely.
// Mirrors production: keyword match, then exclusions.
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

console.log("Mission URL discovery regression checks passed.");
