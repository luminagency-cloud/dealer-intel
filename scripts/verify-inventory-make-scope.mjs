/**
 * Make-scoping check for the facet-reading inventory adapters.
 *
 * Dealer.com, Dealer Inspire and Dealer Alchemist all collect by navigating to
 * a make-filtered SRP URL and then reading whatever model facet the page
 * rendered. When a store ignores that filter the read still succeeds — and
 * returns the WHOLE store's models, which then get stored under the one make
 * that happened to be requested. Stored rows showed exactly that: a Buick row
 * holding Golf GTI and IONIQ 5, a Jeep row holding Ram trucks and a Charger.
 *
 * The adapters used to answer "did the filter apply?" by re-reading the query
 * param they had just written into the URL themselves, which can only say yes.
 * `inventoryTally.checkMakeScope` replaces that with page evidence, and this
 * asserts its behaviour on the real cases plus the honest stores it must not
 * break.
 *
 * Run: node scripts/verify-inventory-make-scope.mjs
 */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const read = (name) =>
  readFileSync(new URL(`../extension/${name}`, import.meta.url), "utf8");

eval(read("inventory/tally.js"));
const { checkMakeScope } = globalThis.inventoryTally;

const facet = (entries) => entries.map(([name, count]) => ({ name, value: name, count }));

// Mastria Auto Group, dealer_inspire: the group's whole 887-vehicle model
// facet was banked under Buick. The store facet knows Buick is a small part
// of the lot, so the read cannot be Buick's.
{
  const store = facet([
    ["Buick", 13],
    ["Cadillac", 13],
    ["GMC", 82],
    ["Hyundai", 140],
    ["Kia", 123],
    ["Mazda", 256],
    ["Nissan", 100],
    ["Subaru", 116],
    ["Volkswagen", 57],
  ]);
  const scope = checkMakeScope({ make: "Buick", modelTotal: 887, storeMakes: store });
  assert.equal(scope.scoped, false);
  assert.match(scope.reason, /887 against 13 Buick/);
}

// Westerly CDJR, ddc: every make received the store's whole model list, so
// every make over-counts against its own facet row.
{
  const store = facet([
    ["Chrysler", 8],
    ["Dodge", 12],
    ["Jeep", 45],
    ["Ram", 115],
  ]);
  for (const make of ["Chrysler", "Dodge", "Jeep", "Ram"]) {
    assert.equal(checkMakeScope({ make, modelTotal: 180, storeMakes: store }).scoped, false);
  }
  // The same store read correctly: each make totals its own facet count.
  for (const [make, total] of [["Chrysler", 8], ["Dodge", 12], ["Jeep", 45], ["Ram", 115]]) {
    assert.equal(checkMakeScope({ make, modelTotal: total, storeMakes: store }).scoped, true);
  }
}

// A single-brand store's unfiltered read IS that make's read. The guard must
// stand down, or every Subaru/Hyundai/Nissan dealer collecting correctly today
// would start reporting zero.
{
  const scope = checkMakeScope({
    make: "Subaru",
    modelTotal: 116,
    storeMakes: facet([["Subaru", 116]]),
  });
  assert.equal(scope.scoped, true);
  assert.equal(scope.reason, null);
}

// An unreadable make facet leaves nothing to hold the read against; behaviour
// is unchanged rather than newly destructive.
assert.equal(checkMakeScope({ make: "Jeep", modelTotal: 180, storeMakes: [] }).scoped, true);

// The on-lot pass filters status as well as make, so it reads FEWER vehicles
// than the make's all-status facet count. Only an over-count is evidence.
{
  const store = facet([["Jeep", 45], ["Ram", 115]]);
  assert.equal(checkMakeScope({ make: "Jeep", modelTotal: 30, storeMakes: store }).scoped, true);
  // Counts drift a little between two page loads; two vehicles is not proof.
  assert.equal(checkMakeScope({ make: "Jeep", modelTotal: 47, storeMakes: store }).scoped, true);
  assert.equal(checkMakeScope({ make: "Jeep", modelTotal: 48, storeMakes: store }).scoped, false);
}

// The page reporting the make as selected is the other half of the evidence:
// it stands on its own, for themes that publish no per-make counts.
{
  const store = facet([["Jeep", null], ["Ram", null]]);
  assert.equal(checkMakeScope({ make: "Jeep", modelTotal: 180, storeMakes: store }).scoped, false);
  assert.equal(
    checkMakeScope({
      make: "Jeep",
      modelTotal: 180,
      storeMakes: store,
      selectedMakes: ["Jeep"],
    }).scoped,
    true
  );
  // Another make selected is not this make's evidence.
  assert.equal(
    checkMakeScope({
      make: "Jeep",
      modelTotal: 180,
      storeMakes: store,
      selectedMakes: ["Ram"],
    }).scoped,
    false
  );
}

// A make the store does not stock reads zero, which proves nothing either way
// and must not be reported as a filter failure.
assert.equal(
  checkMakeScope({
    make: "Buick",
    modelTotal: 0,
    storeMakes: facet([["Buick", 0], ["GMC", 82]]),
  }).scoped,
  true
);

// Spelling and case differ between the allow-list and the facet.
assert.equal(
  checkMakeScope({
    make: "ram",
    modelTotal: 115,
    storeMakes: facet([["Jeep", 45], ["RAM", 115]]),
  }).scoped,
  true
);

// Every facet-walking adapter has to route through the guard. Without this the
// shared fix can be quietly bypassed one adapter at a time, which is how the
// per-adapter URL check drifted out of usefulness in the first place.
for (const adapter of ["dealer-com", "dealer-inspire", "dealer-alchemist"]) {
  assert.match(
    read(`inventory/adapters/${adapter}.js`),
    /inventoryTally\.checkMakeScope\(/,
    `${adapter} does not check make scope`
  );
}

// Dealer Inspire's facet reader marks a row selected from the URL too, so the
// scope check must read `selectedInDom` — the URL only repeats what we sent.
{
  const source = read("inventory/adapters/dealer-inspire.js");
  assert.match(source, /selectedInDom/);
  assert.doesNotMatch(source, /filter\(\(row\) => row\.selected\)/);
}

console.log("inventory make scope: ok");
