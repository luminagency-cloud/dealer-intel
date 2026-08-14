/**
 * Inventory tally name check.
 *
 * `plausibleModelName` is the last gate before a scraped label becomes a stored
 * model row, and a stored row is permanent as far as reporting is concerned —
 * nothing downstream can tell a dealer address from a nameplate. Real rows that
 * reached storage are listed below as REJECT cases; the ACCEPT list is the
 * reason the rules cannot simply be stricter.
 *
 * Run: node scripts/verify-inventory-tally.mjs
 */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const source = readFileSync(
  new URL("../extension/inventory/tally.js", import.meta.url),
  "utf8"
);
// The file is an IIFE that publishes onto globalThis.
eval(source);
const { plausibleModelName, createInventoryTally } = globalThis.inventoryTally;

// Rows that actually reached inventory_results.models and should not have.
const REJECT = [
  // Dealer addresses, from the footer or a location switcher.
  "1890 Hartford Ave, Johnston, RI",
  "845 Taunton Avenue, East Providence, RI",
  "885 Quaker Ln, West Warwick, RI",
  "1164 North Colony Rd. • Wallingford, CT",
  "223 Broad St • Bristol, CT",
  "1030 Hingham St, Rockland, MA",
  "1300 Pontiac Ave, Cranston, RI",
  // Same addresses without the city/state tail the old rule required.
  "1030 Hingham St",
  "223 Broad Street Bristol",
  // Compare-widget captions off the results grid.
  "Compare New 2025 Kia K5 EX Stock:",
  "Compare New 2026 Kia Sportage LX",
  // A whole facet panel read as one label.
  "Model 4Runner 7 BZ 7 C-HR 5 Camry 26 Corolla 48 Corolla Cross 11 Crown 2 GR 2",
  "Camry 26 Corolla 48 Crown 2",
  // Assorted furniture.
  "Sales: 401-555-0100",
  "View Inventory",
  "12 Vehicles",
  "Schedule Service",
  "",
  "   ",
];

for (const name of REJECT) {
  assert.equal(plausibleModelName(name), false, `should reject: ${JSON.stringify(name)}`);
}

// Real nameplates, including every shape that looks like junk: digits-only
// names, a bare number after the name, model-year-shaped numbers that are not
// years, and street-type words that are not addresses.
const ACCEPT = [
  "GR86",
  "GR Corolla",
  "Mazda3",
  "CX-90 PHEV",
  "bZ4X",
  "MX-5 Miata RF",
  "IONIQ 5",
  "IONIQ 5 N",
  "Ram ProMaster 3500 Cutaway",
  "Ram 1500 Classic",
  "Sierra 2500 HD",
  "Silverado 3500 HD Chassis Cab",
  "300",
  "911",
  "500X",
  "4Runner",
  "Land Cruiser",
  "F-150 Lightning",
  "Transit-350 Cargo Van",
  "Wrangler 4xe",
  "CT5-V Blackwing",
  "Focus ST",
  "Grand Wagoneer L",
  "Corolla Cross Hybrid",
  "Tacoma i-FORCE MAX",
];

for (const name of ACCEPT) {
  assert.equal(plausibleModelName(name), true, `should accept: ${JSON.stringify(name)}`);
}

// The gate is inside the tally, so an adapter that hands it junk stores
// nothing — and the junk is not quietly folded into a make subtotal either.
{
  const tally = createInventoryTally({ makeAllowList: ["Kia"] });
  tally.addModelCount("Kia", "Sportage", { inStock: 12 });
  tally.addModelCount("Kia", "Compare New 2025 Kia K5 EX Stock:", { inStock: 2025 });
  tally.addModelCount("Kia", "223 Broad St • Bristol, CT", { inStock: 7 });
  const counted = tally.result();
  assert.deepEqual(
    counted.models.map((row) => row.model),
    ["Sportage"]
  );
  assert.equal(counted.totals.inStock, 12);
}

// Ram's make prefix is applied before the name is judged, so the prefixed name
// is what has to pass.
{
  const tally = createInventoryTally({ makeAllowList: ["Ram"] });
  tally.addModelCount("Ram", "1500", { inStock: 4 });
  assert.deepEqual(
    tally.result().models.map((row) => row.model),
    ["Ram 1500"]
  );
}

console.log("inventory tally names: ok");
