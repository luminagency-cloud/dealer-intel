/**
 * Remove page furniture from stored inventory model rows.
 *
 * `plausibleModelName` now rejects addresses, compare-widget captions and whole
 * facet dumps, but rows collected before it did are already in
 * `inventory_results.models` and reporting reads them as real nameplates.
 *
 * The rule is not copied here: the extension's tally is evaluated and its own
 * function is used, so this script and the collector can never disagree.
 *
 * Totals and make subtotals are left alone, including where a junk row's own
 * count clearly inflated them (a compare caption parsed as "2920 vehicles").
 * Totals were reconciled by the adapter against the store's own advertised
 * figure; rebuilding them from the surviving rows would publish a number the
 * collector never observed. Those dealers need re-collecting, not patching.
 *
 * A result whose rows are ALL junk is emptied rather than deleted: the gap is
 * then visible in reporting, and `collectedAt`, `sourceUrl` and the warnings
 * that explain the bad read survive.
 *
 * Dry run by default. Pass --apply to write.
 *
 * Run: node scripts/clean-inventory-model-rows.mjs [--apply]
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

// The extension file is an IIFE that publishes onto globalThis.
eval(readFileSync(new URL("../extension/inventory/tally.js", import.meta.url), "utf8"));
const { plausibleModelName } = globalThis.inventoryTally;

const apply = process.argv.includes("--apply");
const sql = neon(process.env.DATABASE_URL);

const results = await sql`
  SELECT r.id, r.week_key, r.collected_at, r.detected_platform, r.models, r.totals,
         s.name AS site_name
  FROM inventory_results r
  JOIN sites s ON s.id = r.site_id
  WHERE r.models IS NOT NULL
  ORDER BY r.collected_at DESC
`;

const count = (row) => Number(row?.inStock || 0) + Number(row?.inTransit || 0);

let scanned = 0;
let cleaned = 0;
let dropped = 0;
let droppedVehicles = 0;
const emptied = [];

for (const result of results) {
  const models = Array.isArray(result.models) ? result.models : [];
  if (models.length === 0) continue;
  scanned += 1;

  const junk = models.filter((row) => !plausibleModelName(row?.model));
  if (junk.length === 0) continue;

  const kept = models.filter((row) => plausibleModelName(row?.model));
  const label = `${result.site_name} ${result.week_key} (${result.detected_platform ?? "?"})`;

  if (kept.length === 0) {
    emptied.push(`${label} — all ${models.length} model rows dropped; re-collect this dealer`);
  }

  console.log(`${label} — dropping ${junk.length} of ${models.length}:`);
  for (const row of junk) {
    console.log(`    ${row.make} / ${JSON.stringify(row.model)}  (${count(row)} vehicles)`);
    droppedVehicles += count(row);
  }
  console.log(
    `    totals said ${result.totals?.displayValue ?? "?"}; kept rows hold ${kept.reduce(
      (sum, row) => sum + count(row),
      0
    )}`
  );

  if (apply) {
    await sql`UPDATE inventory_results SET models = ${JSON.stringify(kept)}::jsonb WHERE id = ${result.id}`;
  }
  cleaned += 1;
  dropped += junk.length;
}

if (emptied.length > 0) {
  console.log("\nemptied (no usable model rows left):");
  for (const line of emptied) console.log(`  ${line}`);
}

console.log(
  `\n${apply ? "updated" : "would update"} ${cleaned} of ${scanned} results, ` +
    `${dropped} junk model rows carrying ${droppedVehicles} vehicles.`
);
if (!apply && cleaned > 0) console.log("re-run with --apply to write.");
