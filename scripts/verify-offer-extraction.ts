import assert from "node:assert/strict";

import {
  applyCouponVerdict,
  extractOffers,
  extractOffersFromDisclosure,
  extractOffersFromOcrImage,
  findKnownModel,
  reconcileServiceCoupon,
} from "../src/lib/analysis/extract";
import { looksMisread, normalizeOcrText } from "../src/lib/analysis/ocr";
import {
  AD_IMAGE_RULES,
  MAX_AD_IMAGES,
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

// A coupon whose OCR read disagrees with its alt text: both readings survive on
// the offer so the coupon verifier can be shown each one, and the row sits under
// the publish floor until it is adjudicated.
const mismatchedCoupon = reconcileServiceCoupon(
  "Brake Special $25.00 OFF",
  "Brake Special $49.95",
  serviceHints
)!;
assert.equal(mismatchedCoupon.matches.verify, "mismatch");
assert.equal(mismatchedCoupon.matches.ocrValue, "$25.00 OFF");
assert.equal(mismatchedCoupon.matches.altValue, "$49.95");
assert.ok(
  mismatchedCoupon.confidence < 0.6,
  `expected an unadjudicated mismatch below the floor, got ${mismatchedCoupon.confidence}`
);

// Confirm: the OCR read publishes on the model's calibrated number, and NOT ONE
// FIELD moves — the verifier judges the read, it never rewrites it.
const confirmed = applyCouponVerdict(
  reconcileServiceCoupon("Brake Special $25.00 OFF", "Brake Special $49.95", serviceHints)!,
  { real: true, calibratedConfidence: 0.88, reason: "graphic reads $25 off" },
  0.6
);
assert.equal(confirmed.confidence, 0.88);
assert.equal(confirmed.matches.serviceOffer, "$25.00 OFF");
assert.equal(confirmed.rawText, "Brake Service");
assert.equal(confirmed.matches.verify, "mismatch_confirmed");
assert.deepEqual(confirmed.aiVerified, {
  real: true,
  reason: "graphic reads $25 off",
  confidence: 0.88,
});

// Drop: forced under the floor even when the model's own number is high, so the
// drop holds; the kept OCR read is still not rewritten.
const droppedCoupon = applyCouponVerdict(
  reconcileServiceCoupon("Brake Special $25.00 OFF", "Brake Special $49.95", serviceHints)!,
  { real: false, calibratedConfidence: 0.91, reason: "$25 is the alt of another coupon" },
  0.6
);
assert.ok(
  droppedCoupon.confidence < 0.6,
  `expected a dropped coupon below the floor, got ${droppedCoupon.confidence}`
);
assert.equal(droppedCoupon.matches.serviceOffer, "$25.00 OFF");
assert.equal(droppedCoupon.matches.verify, "mismatch_dropped");
assert.equal(droppedCoupon.aiVerified?.real, false);

// A lukewarm confirm is still under the floor — "probably right" doesn't publish.
assert.ok(
  applyCouponVerdict(
    reconcileServiceCoupon("Brake Special $25.00 OFF", "Brake Special $49.95", serviceHints)!,
    { real: true, calibratedConfidence: 0.55, reason: "unclear" },
    0.6
  ).confidence < 0.6
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

// The Chrome collector downloads ad graphics inside the dealer's page — this
// app never requests a dealer-controlled URL, because anti-bot protection is
// what pushed collection into the operator's browser in the first place. So
// the extension gets these rules as plain values with its job, and they must
// decide what the functions above decide.
const skipPath = new RegExp(AD_IMAGE_RULES.skipPathPattern, "i");
const tileHost = new RegExp(AD_IMAGE_RULES.tileHostPattern, "i");
assert.equal(skipPath.test("/static/franchise-logos/nissan/white/117x80.png"), true);
assert.equal(skipPath.test("/spacer.png"), true);
assert.equal(skipPath.test("/a/anchornissan/1234/murano.jpg"), false);
assert.equal(tileHost.test(new URL(mapTile).hostname), true);
assert.equal(tileHost.test("pictures.dealer.com"), false);
// The extension gates on real decoded pixels, so the thresholds have to travel
// with it rather than stay compiled in here.
assert.equal(AD_IMAGE_RULES.minWidth > 0 && AD_IMAGE_RULES.minHeight > 0, true);
assert.equal(AD_IMAGE_RULES.max, MAX_AD_IMAGES);

// --- Hero-ad OCR text (Aug 5 2026) ---------------------------------------
// Three real hero ads whose data the pipeline dropped. Mistral read all the
// numbers off the first two correctly; the extractor was what lost them.

// "/per mo." — the slash and the word are stacked separately in the artwork.
const kiaOcr = extractOffersFromOcrImage(
  `2027 Kia\nTELLURIDE\n\nLease for Only\n$419 /per mo.\nfor 24 months, 10k miles/yr.,\n$5,037 Due at Signing`,
  { missionType: "promotional_banners", brand: "Kia" }
);
assert.equal(kiaOcr.length, 1);
assert.equal(kiaOcr[0].offerType, "lease");
assert.equal(kiaOcr[0].monthlyPayment, 419);
assert.equal(kiaOcr[0].termMonths, 24);
assert.equal(kiaOcr[0].mileageAllowance, 10000);
assert.equal(kiaOcr[0].dueAtSigning, 5037);

// APR advertised with no "APR" anywhere — the term carries the meaning.
const subaruOcr = extractOffersFromOcrImage(
  `2026 Subaru Forester\n\nSave up to\n\n$2,055 off TSRP\n\n2.9%\n\nfor 72 months!\n\n2.9% on gas Forester only. Excludes hybrid models.`,
  { missionType: "finance_offers", brand: "Subaru" }
);
assert.equal(subaruOcr.length, 1);
assert.equal(subaruOcr[0].offerType, "finance");
assert.equal(subaruOcr[0].apr, 2.9);
assert.equal(subaruOcr[0].termMonths, 72);

// A bare percentage with no term must still be ignored.
assert.equal(
  extractOffersFromOcrImage(`2026 Subaru Forester\n\n2.9% on gas Forester only.`, {
    missionType: "finance_offers",
    brand: "Subaru",
  }).some((offer) => offer.apr !== null),
  false
);

// A per-$1,000 finance rate is not a monthly payment.
assert.equal(
  extractOffersFromOcrImage(`$17.92 per month per $1,000 financed.`, hints)
    .some((offer) => offer.monthlyPayment !== null),
  false
);

// The misread that motivated the OCR contrast retry: $4.79 is not a lease
// payment, and must not be published as one if a retry still can't fix it.
const ramMisread = extractOffersFromOcrImage(
  `2026 Ram 1500\nLease For Only\n$4.79/Mo\nFor 39 Months $4,500 Due At Signing`,
  { missionType: "promotional_banners", brand: "Ram" }
);
assert.equal(ramMisread.every((offer) => offer.monthlyPayment === null), true);
assert.equal(looksMisread("Lease For Only $4.79/Mo"), true);
assert.equal(looksMisread("$17.92 per month per $1,000 financed"), false);
assert.equal(looksMisread("Lease For Only $479/Mo"), false);
assert.equal(looksMisread("   "), true);

// A read that transcribed nothing but Mistral's own segmentation placeholders
// is a FAILED read, and used to pass as a good one because it is non-empty and
// carries no cents-per-month. That silently skipped both the contrast retry and
// the Claude escalation, and it was the common failure, not an exotic one: five
// dealers in the Aug 6 2026 run produced no offers at all behind exactly this.
assert.equal(looksMisread("tbl-0.md\ntbl-1.md\ntbl-2.md\ntbl-3.md"), true);
assert.equal(looksMisread("tbl-0.md"), true);
assert.equal(looksMisread("Figura 1"), true);
assert.equal(looksMisread("1\n\n1\n\n1\n\n1\n\n1\n\n1"), true);
// ...but a real read that merely CONTAINS a placeholder still stands.
assert.equal(looksMisread("SAVE $4,000 ON EVERY DODGE DURANGO\ntbl-0.md"), false);

// Ad copy pluralizes and possessivizes model names, and the bare word boundary
// never matched those. A real Elmwood CDJR finance ad parsed to 2.97% APR / 72
// months and was then discarded as an unmodeled priced offer for want of this.
assert.equal(
  findKnownModel("SAVE $5,000 ON ALL JEEP GRAND WAGONEERS AND GET 2.97% APR for 72 months"),
  "Grand Wagoneer"
);
assert.equal(findKnownModel("2026 RAM LARAMIE 1500's SAVE $16,000 OFF MSRP!"), "1500");
assert.equal(findKnownModel("All Broncos must go"), "Bronco");
assert.equal(findKnownModel("Visit our showroom today"), null);

// Two APR tiers stacked in one hero ad are two offers, not one. Real Bald Hill
// CDJR Pacifica ad (evidence 93a87344) — we used to report only the 0%/36 and
// silently drop the 3.9%/84. Each tier keeps the term printed beside its own
// rate, never the neighbour's, and the ad's fine print keeps the tiers from
// leaking a third offer.
const twoTierApr = extractOffersFromOcrImage(
  `NEW 2026 CHRYSLER PACIFICA AWD FINANCE FOR 0% APR FOR 36 MONTHS 3.9% APR FOR 84 MONTHS ` +
    `OR SAVE UP TO $5,000 OFF MSRP APR: 3.9% APR financing for 72 months equals $15.60 per ` +
    `month per $1,000 financed. 0% APR financing for 36 months equals $27.78 per month per ` +
    `$1,000 financed for well-qualified buyers. Not all buyers will qualify.`,
  { missionType: "homepage_offers", brand: "Chrysler" }
);
assert.deepEqual(
  twoTierApr.map((offer) => [offer.offerType, offer.apr, offer.termMonths, offer.vehicleModel]),
  [
    ["finance", 0, 36, "Pacifica"],
    ["finance", 3.9, 84, "Pacifica"],
  ]
);

// A per-VIN inventory card is not an advertised offer. Toyota of Dartmouth's
// `/specials/` prints a payment on every unit on the lot, each card carrying its
// own VIN and stock number, and a run stored 12 rows that were really 12 cars.
// The whole page must yield nothing, and a genuine model-level card sitting
// beside them must still survive.
const perVinCards = `
  <div class="specials">
    <div class="offer-box">
      <h3>New 2026 Toyota Camry LE AWD</h3>
      <div>Lease for $256 Per month for 36 Months</div>
      <div>Plus tax. $4763 Down Payment</div>
      <div>Model #: 2552 VIN: 4T1DBADKXTU32C915 Stock No: TU32C915</div>
    </div>
    <div class="offer-box">
      <h3>New 2026 Toyota RAV4 LE AWD</h3>
      <div>Lease for $363 Per month for 36 Months</div>
      <div>Plus tax. $3999 Down Payment</div>
      <div>Model #: 4430 VIN: JTMAAAAD4TJ016404 Stock No: N62176</div>
    </div>
    <div class="offer-box">
      <h3>New 2026 Toyota Tacoma SR5</h3>
      <div>Lease for $321 Per month for 36 Months</div>
      <div>Plus tax. $3999 Down Payment. Offer ends 08/31/2026.</div>
    </div>
  </div>`;
const dartmouth = extractOffers(perVinCards, {
  missionType: "finance_offers",
  brand: "Toyota",
});
assert.deepEqual(
  dartmouth.map((offer) => [offer.vehicleModel, offer.monthlyPayment]),
  [["Tacoma", 321]]
);

console.log("Offer extraction regression checks passed.");

// --- Confidence: completeness is measured per offer type -------------------
//
// Real Anchor Subaru homepage ad graphics (run 228ee00f). Under the old
// score — non-null fields out of a fixed six — a fully-parsed lease could not
// exceed 0.8 before provenance, because a lease structurally has no APR and no
// sale price. A 0%-APR finance ad scored worse still (0.6, exactly the publish
// floor) for lacking a monthly payment and a due-at-signing it can never have.
const leaseAd =
  "2026 SUBARU OUTBACK PREMIUM Stk# S21820 Lease for only $239/MONTH 36 months, " +
  "22,500 miles, $5,500 Due at Signing, $0 Security Deposit";
const [leaseOffer] = extractOffersFromOcrImage(leaseAd, {
  missionType: "homepage_offers",
  brand: "Subaru",
});
assert.equal(leaseOffer.offerType, "lease");
// payment + term + due = 3/3 complete, + make, × 0.85 homepage provenance.
assert.equal(leaseOffer.confidence, 0.85);

// Fine print must not move the score. Whether an ad carries a disclaimer is
// recorded in disclaimer_text and acted on by the compliance grade; as a
// confidence bonus it just rewarded whatever text landed in the window.
const [leaseNoDisclaimer] = extractOffersFromOcrImage(leaseAd, {
  missionType: "homepage_offers",
  brand: "Subaru",
});
const [leaseWithDisclaimer] = extractOffersFromOcrImage(
  `${leaseAd} *Lessee responsible for excess wear and mileage. See dealer for details.`,
  { missionType: "homepage_offers", brand: "Subaru" }
);
assert.equal(leaseWithDisclaimer.confidence, leaseNoDisclaimer.confidence);

// A 0% APR finance ad states everything it has: rate and term.
const [zeroApr] = extractOffersFromOcrImage(
  "NEW 2026 SUBARU FORESTER 0% APR for 36 months",
  { missionType: "finance_offers", brand: "Subaru" }
);
assert.equal(zeroApr.offerType, "finance");
assert.equal(zeroApr.apr, 0);
assert.equal(zeroApr.confidence, 1);

// A payment with no term is genuinely half an offer and still scores like one.
const [bare] = extractOffersFromOcrImage("Drive home for $199/mo", {
  missionType: "homepage_offers",
  brand: "Subaru",
});
assert.equal(bare.offerType, "promotional");
assert.ok(bare.confidence < 0.6, `expected bare payment below floor, got ${bare.confidence}`);

console.log("Confidence scoring checks passed.");
