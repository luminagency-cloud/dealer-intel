import assert from "node:assert/strict";

import { isSameLocation, pageLinks } from "../src/lib/chrome-collector";
import {
  DISCOVERY_KEYWORDS,
  missionTargetsHomepage,
  pageHasOfferSignal,
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

// Numeric entity references decode too — some platforms emit `&#38;`.
assert.deepEqual(
  pageLinks(`<a href="/x">Offers &#38; Incentives</a>`, HOME).map((l) => l.text),
  ["offers & incentives"]
);

// The keyword match that the homepage fallback used to bypass entirely.
function firstMatch(missionType: "service_specials" | "finance_offers") {
  for (const keyword of DISCOVERY_KEYWORDS[missionType]) {
    const hit = links.find((link) => link.text.includes(keyword));
    if (hit) return hit.href;
  }
  return null;
}
assert.equal(
  firstMatch("service_specials"),
  "https://www.anchor-nissan.com/promotions/service/index.htm"
);
assert.equal(
  firstMatch("finance_offers"),
  "http://www.anchor-nissan.com/global-incentives-search/index.htm"
);

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

// Candidate ranking: a 200-returning nav hub must not outrank the real page.
assert.equal(
  pageHasOfferSignal(
    `<ul><li><a href="/new">New Inventory</a></li><li><a href="/service">Service</a></li></ul>`
  ),
  false
);
assert.equal(pageHasOfferSignal(`<div class="coupon">$39.95 Oil Change — $10 off</div>`), true);
assert.equal(pageHasOfferSignal(`<p>Lease for $449/mo for 36 months</p>`), true);
assert.equal(pageHasOfferSignal(`<p>0% APR for 60 months</p>`), true);
// Script/style noise must not fake a signal.
assert.equal(
  pageHasOfferSignal(`<script>const price = "$299/mo";</script><p>Welcome</p>`),
  false
);

console.log("Mission URL discovery regression checks passed.");
