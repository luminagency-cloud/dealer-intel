import assert from "node:assert/strict";

import { storedAdSources } from "../src/lib/analysis/runner";
import type { Evidence } from "../src/lib/db";

/**
 * Regression: an ad graphic is stored once per RUN (capture key = run + URL),
 * so a banner the homepage and the finance page both show carries whichever
 * mission reached it first. Selecting ad graphics per mission left the sibling
 * page with none, so it fell through to full-page screenshot OCR — Balise
 * Nissan's Altima banner read "$309 / $1,424 due" at ad scale but "$300, no
 * due at signing" off the page screenshot, and "View ad" on that offer opened
 * the whole page instead of the ad (evidence 13c91ef1).
 */

const SITE = "site-1";
const BANNER = "https://d.com/static/Banner/altima-1920x600.jpg";

const adRow = (over: Partial<Evidence>) =>
  ({
    id: "ad-1",
    siteId: SITE,
    missionType: "homepage_offers",
    evidenceType: "ad_image",
    captureStateId: "page-home:base",
    sourceUrl: BANNER,
    ...over,
  }) as Evidence;

const htmlRow = (over: Partial<Evidence>) =>
  ({
    id: "html-1",
    siteId: SITE,
    missionType: "finance_offers",
    evidenceType: "html_snapshot",
    captureStateId: "page-finance:base",
    label: "Finance — https://d.com/finance/",
    ...over,
  }) as Evidence;

const index = new Map<string, Evidence[]>([
  [SITE, [adRow({}), adRow({ id: "ad-2", sourceUrl: "https://d.com/other.jpg", captureStateId: "page-other:base" })]],
]);

// The finance page renders the homepage-captured banner: it must OCR the ad.
// The resized CDN variant is the same picture — matching is origin+path.
assert.deepEqual(
  storedAdSources(index, htmlRow({}), `<img src="${BANNER}?width=1600">`).map((s) => s.evidenceId),
  ["ad-1"]
);

// A page that renders neither gets nothing, and still falls back to its own
// screenshot — the site-wide index must not hand it a sibling page's ads.
assert.deepEqual(storedAdSources(index, htmlRow({}), "<img src='https://d.com/logo.png'>"), []);

// Graphics captured from this page's OWN states (carousel/tab HTML the base
// snapshot never contains) stay selected without any URL match.
assert.deepEqual(
  storedAdSources(
    index,
    htmlRow({ captureStateId: "page-home:base" }),
    "<p>no images</p>"
  ).map((s) => s.evidenceId),
  ["ad-1"]
);

console.log("Ad source selection checks passed.");
