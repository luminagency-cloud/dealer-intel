import assert from "node:assert/strict";

import {
  extractOffers,
  extractOffersFromDisclosure,
  extractOffersFromOcrImage,
  reconcileServiceCoupon,
} from "../src/lib/analysis/extract";
import { normalizeOcrText } from "../src/lib/analysis/ocr-mistral";
import {
  extractAdImageUrls,
  isThirdPartyTile,
  redactUrl,
} from "../src/lib/collector/ad-images";

const hints = { missionType: "finance_offers" as const, brand: "Nissan" };

const adjacentCards = `
  <div id="cards__Container">
    <div class="card__coupon">
      <div class="card__body">
        <h2>NEW 2026 NISSAN ARMADA</h2>
        <p>Get 2.9% APR for 60 months on a New 2026 Nissan Armada OR Get $3,500 Customer Cash.</p>
        <p>*Well-qualified buyers may choose 2.9% annual percentage rate financing for 60 months through NMAC on New 2026 Nissan Armada, $17.92 per month per $1,000 financed.</p>
        <p>**$3,500 Customer Cash from Nissan available on purchase of a New 2026 Nissan Armada. Not compatible with special APR.</p>
      </div>
    </div>
    <div class="card__coupon">
      <div class="card__body">
        <h2>NEW 2026 NISSAN FRONTIER</h2>
        <p>Lease a New 2026 Nissan Frontier for $299/mo OR Get 1.9% APR for 60 months OR Get $3,500 Customer Cash.</p>
        <p>*Well-qualified lessees may lease for $299/mo for 24 months with $5,339 total due at signing. 10,000 miles/year.</p>
        <p>**Well-qualified buyers may choose 1.9% annual percentage rate financing for 60 months through NMAC on New 2026 Nissan Frontier.</p>
      </div>
    </div>
  </div>`;

const offers = extractOffers(adjacentCards, hints);
const armada = offers.filter((offer) => offer.vehicleModel === "Armada");
assert.deepEqual(
  armada.map((offer) => ({
    type: offer.offerType,
    apr: offer.apr,
    term: offer.termMonths,
    payment: offer.monthlyPayment,
    cash: offer.cashIncentive,
  })),
  [{ type: "finance", apr: 2.9, term: 60, payment: null, cash: null }]
);

const frontier = offers.filter((offer) => offer.vehicleModel === "Frontier");
assert.deepEqual(
  frontier.map((offer) => ({
    type: offer.offerType,
    apr: offer.apr,
    term: offer.termMonths,
    payment: offer.monthlyPayment,
    due: offer.dueAtSigning,
    cash: offer.cashIncentive,
  })),
  [
    { type: "finance", apr: 1.9, term: 60, payment: null, due: null, cash: null },
    { type: "lease", apr: null, term: 24, payment: 299, due: 5339, cash: null },
  ]
);

assert.equal(offers.some((offer) => offer.offerType === "cash"), false);

const incentiveOnly = extractOffers(
  `<div>New 2026 Nissan Armada. Get $3,500 Customer Cash.</div>`,
  hints
);
assert.deepEqual(incentiveOnly, []);

const purchasePrice = extractOffers(
  `<div>New 2026 Nissan Armada. Buy this car for $52,695.</div>`,
  hints
);
assert.equal(purchasePrice.length, 1);
assert.equal(purchasePrice[0].offerType, "cash");
assert.equal(purchasePrice[0].salePrice, 52695);
assert.equal(purchasePrice[0].cashIncentive, null);

const capturedFrontierDisclosure =
  "DISCLAIMER Lease a New 2026 Nissan Frontier S 4x4 King Cab for $299/mo OR " +
  "Get 1.9% APR for 60 months OR Get $3,500 Customer Cash. " +
  "Well-qualified lessees may lease for $299/mo for 24 months with $5,339 " +
  "total due at signing. 10,000 miles/year. Well-qualified buyers may choose " +
  "1.9% annual percentage rate financing for 60 months through NMAC on New " +
  "2026 Nissan Frontier.";
const disclosureOffers = extractOffersFromDisclosure(
  capturedFrontierDisclosure,
  hints
);
assert.deepEqual(
  disclosureOffers.map((offer) => ({
    type: offer.offerType,
    model: offer.vehicleModel,
    payment: offer.monthlyPayment,
    apr: offer.apr,
    term: offer.termMonths,
    due: offer.dueAtSigning,
  })),
  [
    {
      type: "finance",
      model: "Frontier",
      payment: null,
      apr: 1.9,
      term: 60,
      due: null,
    },
    {
      type: "lease",
      model: "Frontier",
      payment: 299,
      apr: null,
      term: 24,
      due: 5339,
    },
  ]
);

const serviceHints = {
  missionType: "service_specials" as const,
  brand: null,
};
const mastriaStyleServiceCards = `
  <section>
    <article>$50.00 OFF Remote Starter Installation Save today on installation before the cold weather arrives.</article>
    <article>$10.00 OFF In-Cabin Microfilter Replacement Breathe easier this winter!</article>
    <article>Mastria Auto Group 1305 New State Highway, Raynham, MA 02767 Service: (888) 848-0303 $10.00 OFF</article>
  </section>
`;
assert.deepEqual(
  extractOffers(mastriaStyleServiceCards, serviceHints).map((offer) => ({
    label: offer.rawText,
    value: offer.matches.serviceOffer,
  })),
  [
    { label: "Remote Start", value: "$50.00 OFF" },
    { label: "Cabin Microfilter", value: "$10.00 OFF" },
  ]
);

assert.equal(
  reconcileServiceCoupon(
    "$10 OFF Service, see dealer for details",
    null,
    serviceHints
  ),
  null
);
assert.equal(
  reconcileServiceCoupon("$200.00 Detail", null, serviceHints),
  null
);
assert.deepEqual(
  (() => {
    const offer = reconcileServiceCoupon(
      "$200.00 Full Vehicle Detail",
      null,
      serviceHints
    );
    return offer
      ? { label: offer.rawText, value: offer.matches.serviceOffer }
      : null;
  })(),
  { label: "Vehicle Detailing", value: "$200.00" }
);
assert.deepEqual(
  (() => {
    const offer = reconcileServiceCoupon(
      "Brake Special $25.00 OFF View Offer In-Cabin Air Filter Replacement $48.93",
      null,
      serviceHints
    );
    return offer
      ? { label: offer.rawText, value: offer.matches.serviceOffer }
      : null;
  })(),
  { label: "Brake Service", value: "$25.00 OFF" }
);

const mistralMarkdown = `
# IMPRIZIA Sport

![img-0.jpeg](img-0.jpeg)

Get **2.9%** APR Financing for Up to 48 Months
or Lease for **$269**/Month for 36 Months
`;
const normalizedOcrText = normalizeOcrText(mistralMarkdown);
assert.equal(normalizedOcrText.includes("**"), false);
assert.equal(normalizedOcrText.includes("img-0.jpeg"), false);
assert.match(normalizedOcrText, /2\.9% APR/);
assert.match(normalizedOcrText, /\$269\/Month/);

const mistralOffers = extractOffersFromOcrImage(normalizedOcrText, {
  missionType: "finance_offers",
  brand: "Subaru",
});
assert.deepEqual(
  mistralOffers.map((offer) => ({
    type: offer.offerType,
    payment: offer.monthlyPayment,
    apr: offer.apr,
    term: offer.termMonths,
  })),
  [
    { type: "finance", payment: null, apr: 2.9, term: 48 },
    { type: "lease", payment: 269, apr: null, term: 36 },
  ]
);

// A combo ad card that states a term for only ONE of its two alternatives: the
// lease half must not inherit the finance half's 60 months. Real OCR text from
// an Anchor Nissan hero ad (Aug 2026) — the ad states no lease term at all.
const oneSidedTerm = extractOffersFromOcrImage(
  "2026 NISSAN MURANO SL LEASE FOR $389/MO $2,999 Total Due at signing -or- " +
    "TAKE ADVANTAGE OF 0% FINANCING for 60 months! NISSAN SUMMER SALES EVENT",
  { missionType: "homepage_offers", brand: "Nissan" }
);
assert.deepEqual(
  oneSidedTerm.map((offer) => ({
    type: offer.offerType,
    payment: offer.monthlyPayment,
    apr: offer.apr,
    term: offer.termMonths,
    due: offer.dueAtSigning,
  })),
  [
    { type: "finance", payment: null, apr: 0, term: 60, due: null },
    { type: "lease", payment: 389, apr: null, term: null, due: 2999 },
  ]
);

// Map tiles from a dealer's embedded "find us" map are 256x256, so they clear
// the ad-size gate and used to be fetched and OCR'd like ad creative — on the
// dealer's own Google quota, with their API key riding into our logs.
const mapTile =
  "https://maps.googleapis.com/maps/vt?pb=!1m5!1m4!1i14!2i4924!3i6121!4i256" +
  "&key=AIzaSyExampleKeyNotReal000000000000&token=96713";
assert.equal(isThirdPartyTile(mapTile), true);
assert.equal(isThirdPartyTile("https://maps.gstatic.com/tile/1/2/3.png"), true);
assert.equal(
  isThirdPartyTile("https://pictures.dealer.com/a/anchornissan/1234/abc.jpg?w=1600"),
  false
);
assert.equal(isThirdPartyTile("not a url"), false);

// Whatever slips through the host filter must not carry credentials into logs
// or evidence rows.
assert.equal(redactUrl(mapTile).includes("AIzaSy"), false);
assert.match(redactUrl(mapTile), /key=<redacted>&token=<redacted>/);
assert.equal(
  redactUrl("https://pictures.dealer.com/a/x.jpg?w=1600"),
  "https://pictures.dealer.com/a/x.jpg?w=1600"
);

// End to end over the markup the collector actually sees: real ad cards are
// picked up, map tiles and franchise badges are not, and &amp; in the source
// attribute is decoded so the stored URL is the one the browser requested.
const pageMarkup = `
  <header><img src="/static/franchise-logos/nissan/white/117x80.png"></header>
  <div class="hero">
    <img src="https://pictures.dealer.com/a/anchornissan/1234/murano.jpg?impolicy=downsize_bkpt&amp;w=1600">
    <img data-src="https://pictures.dealer.com/a/anchornissan/1234/rogue.jpg?impolicy=downsize_bkpt&amp;w=1600">
    <img src="${mapTile}">
    <img src="/spacer.png">
  </div>`;
assert.deepEqual(extractAdImageUrls(pageMarkup, "https://www.anchor-nissan.com/"), [
  "https://pictures.dealer.com/a/anchornissan/1234/murano.jpg?impolicy=downsize_bkpt&w=1600",
  "https://pictures.dealer.com/a/anchornissan/1234/rogue.jpg?impolicy=downsize_bkpt&w=1600",
]);

console.log("Offer extraction regression checks passed.");
