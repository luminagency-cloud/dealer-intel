import assert from "node:assert/strict";

import {
  extractOffers,
  extractOffersFromDisclosure,
  extractOffersFromOcrImage,
  reconcileServiceCoupon,
} from "../src/lib/analysis/extract";
import { normalizeOcrText } from "../src/lib/analysis/ocr-mistral";

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

console.log("Offer extraction regression checks passed.");
