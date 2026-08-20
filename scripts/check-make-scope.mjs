/**
 * Self-check for the make-scope guard in extension/inventory/tally.js.
 *
 * The guard decides whether a per-make model read belongs to that make or is
 * the whole store's read banked under one make. It has failed both ways: too
 * loose let a CDJR store put every make's trucks under each make, and too
 * tight rejected every make at once on any store whose make facet publishes
 * no counts, which ended the run with no model rows at all.
 *
 * Run: node scripts/check-make-scope.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const context = { globalThis: null };
context.globalThis = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync("extension/inventory/tally.js", "utf8"), context);
const { checkMakeScope } = context.inventoryTally;

const CDJR = ["Chrysler", "Dodge", "Jeep", "Ram"];
const withCounts = CDJR.map((name, index) => ({ name, count: (index + 1) * 100 }));
const withoutCounts = CDJR.map((name) => ({ name, count: null }));

// A single-brand store cannot confuse one make for another, so the guard
// stands down rather than inventing a failure.
assert.equal(
  checkMakeScope({ make: "Kia", modelTotal: 593, storeMakes: [{ name: "Kia" }] }).scoped,
  true
);

// The regression: a multi-make store whose make facet publishes no counts.
// Every make failed here at once, which is how a dealer ended a run with no
// model rows. A read smaller than the store's unfiltered total narrowed.
assert.equal(
  checkMakeScope({
    make: "Jeep",
    modelTotal: 180,
    storeMakes: withoutCounts,
    storeModelTotal: 400,
  }).scoped,
  true
);

// The guard still has to catch what it exists for: a read that came back the
// size of the whole store did not narrow, counts or no counts.
assert.equal(
  checkMakeScope({
    make: "Jeep",
    modelTotal: 400,
    storeMakes: withoutCounts,
    storeModelTotal: 400,
  }).scoped,
  false
);

// With no baseline to measure against and no published count, the guard has
// no evidence either way and must not bank the numbers.
assert.equal(
  checkMakeScope({ make: "Jeep", modelTotal: 400, storeMakes: withoutCounts }).scoped,
  false
);

// The make's own published count still settles it on its own.
assert.equal(
  checkMakeScope({ make: "Jeep", modelTotal: 295, storeMakes: withCounts }).scoped,
  true
);
assert.equal(
  checkMakeScope({ make: "Jeep", modelTotal: 1000, storeMakes: withCounts }).scoped,
  false
);

// So does the page reporting the make as selected in its own markup.
assert.equal(
  checkMakeScope({
    make: "Jeep",
    modelTotal: 1000,
    storeMakes: withCounts,
    selectedMakes: ["Jeep"],
  }).scoped,
  true
);

console.log("check-make-scope: ok");
