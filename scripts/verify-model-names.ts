/**
 * Model-name normalization check.
 *
 * Reporting compares model rows across dealers by name, so the same car
 * arriving from six platforms has to leave storage under one name. What must
 * NOT happen is the opposite: two different cars folded into one row, which is
 * invisible in a report and unrecoverable from stored data.
 *
 * Run: npx tsx scripts/verify-model-names.ts
 */
import assert from "node:assert/strict";
import { canonicalModelName, normalizeModelRows } from "../src/lib/inventory-model-names";
import type { ModelRow } from "../src/lib/inventory";

const row = (make: string, model: string, inStock: number | null, inTransit: number | null): ModelRow => ({
  make,
  model,
  inStock,
  inTransit,
  status: "ok",
});

// The make word repeated in the model is noise.
assert.equal(canonicalModelName("Toyota", "Toyota Crown"), "Crown");
assert.equal(canonicalModelName("Toyota", "Toyota Crown Signia"), "Crown Signia");
assert.equal(canonicalModelName("Nissan", "Nissan Z"), "Z");

// Ram trucks really are named "Ram 1500" — the make word stays.
assert.equal(canonicalModelName("Ram", "Ram 1500"), "Ram 1500");
assert.equal(canonicalModelName("RAM", "Ram ProMaster Cargo Van"), "Ram ProMaster Cargo Van");

// A model that is only the make name keeps it rather than becoming blank.
assert.equal(canonicalModelName("Nissan", "Nissan"), "Nissan");

// Grade names are stripped.
assert.equal(canonicalModelName("GMC", "Yukon Denali"), "Yukon");
assert.equal(canonicalModelName("GMC", "Yukon XL Denali Ultimate"), "Yukon XL");
assert.equal(canonicalModelName("GMC", "Sierra 1500 Limited"), "Sierra 1500");
assert.equal(canonicalModelName("Hyundai", "IONIQ 5 SE"), "IONIQ 5");
assert.equal(canonicalModelName("Hyundai", "SANTA FE CALLIG"), "SANTA FE");

// Spacing dealers disagree about.
assert.equal(canonicalModelName("GMC", "Sierra 2500HD"), "Sierra 2500 HD");
assert.equal(canonicalModelName("GMC", "Sierra  3500HD"), "Sierra 3500 HD");

// Powertrain and body variants are different cars and must survive untouched.
for (const model of [
  "Corolla",
  "Corolla Hybrid",
  "Corolla Hatchback",
  "Corolla Cross",
  "Corolla Cross Hybrid",
  "GR Corolla",
  "RAV4 Plug-in Hybrid",
  "Tacoma i-FORCE MAX",
]) {
  assert.equal(canonicalModelName("Toyota", model), model);
}

// Names that merely look like trims are separate models, so they stay.
assert.equal(canonicalModelName("Nissan", "Rogue Sport"), "Rogue Sport");
assert.equal(canonicalModelName("Ram", "Ram 1500 Classic"), "Ram 1500 Classic");
assert.equal(canonicalModelName("Nissan", "Rogue Select"), "Rogue Select");

// Merging carries both rows' counts. Dropping either would understate the
// dealer and look like a normal number.
{
  const merged = normalizeModelRows([
    row("GMC", "Yukon", 3, 2),
    row("GMC", "Yukon Denali", 4, 1),
    row("GMC", "Yukon XL", 1, 0),
  ]);
  assert.deepEqual(merged, [
    row("GMC", "Yukon", 7, 3),
    row("GMC", "Yukon XL", 1, 0),
  ]);
}

// Case and punctuation differences merge; the first spelling is kept.
{
  const merged = normalizeModelRows([
    row("Hyundai", "Elantra", 2, 1),
    row("Hyundai", "ELANTRA", 3, 0),
  ]);
  assert.deepEqual(merged, [row("Hyundai", "Elantra", 5, 1)]);
}

// Unresolved transit stays unresolved rather than becoming a zero.
{
  const merged = normalizeModelRows([
    row("GMC", "Yukon", 3, null),
    row("GMC", "Yukon Denali", 4, null),
  ]);
  assert.equal(merged[0].inTransit, null);
}

// A merge where only one side knows transit reports what is known.
{
  const merged = normalizeModelRows([
    row("GMC", "Yukon", 3, null),
    row("GMC", "Yukon Denali", 4, 2),
  ]);
  assert.equal(merged[0].inTransit, 2);
}

// Same model name under two makes stays two rows.
{
  const merged = normalizeModelRows([
    row("Jeep", "Grand Cherokee", 5, 0),
    row("Dodge", "Grand Cherokee", 1, 0),
  ]);
  assert.equal(merged.length, 2);
}

console.log("inventory model names: ok");
