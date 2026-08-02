import assert from "node:assert/strict";

import { extractOffers } from "../src/lib/analysis/extract";

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

console.log("Offer extraction regression checks passed.");
