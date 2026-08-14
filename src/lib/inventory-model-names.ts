import type { ModelRow } from "@/lib/inventory";

/**
 * Model-name normalization, applied once on the way into storage.
 *
 * Every platform names the same car differently, and reporting compares model
 * rows across dealers on those names. `Toyota Crown` and `Crown`, or
 * `Yukon Denali` and `Yukon`, are the same nameplate wearing whatever the
 * dealer's CMS happened to publish.
 *
 * This runs server-side rather than in the collector so it covers all six
 * platform adapters at once, needs no extension release to change, and can be
 * replayed over stored rows.
 *
 * What it deliberately does NOT do: merge powertrain or body variants.
 * `Corolla`, `Corolla Hybrid`, `Corolla Hatchback`, `Corolla Cross` and
 * `GR Corolla` are five different cars a shopper chooses between, not five
 * spellings of one.
 */

/**
 * Grade names dealers append to a nameplate. Each one is a price ladder within
 * a single model, so it is noise for a model-level count.
 *
 * An explicit list rather than a pattern: `Sport`, `Classic` and `Select` look
 * exactly like trims and are separate models (`Rogue Sport`, `Ram 1500
 * Classic`), so anything not listed here is left alone by design.
 */
const TRIM_SUFFIXES = [
  "denali ultimate",
  "denali",
  "limited",
  "callig",
  "se",
];

/**
 * Collapse the spellings dealers disagree about for one body:
 * `2500HD` vs `2500 HD`, and `Chassis Cab` / `Chassis` vs `CC`.
 *
 * `CC` wins because it is the shortest of the three and reporting is width-
 * constrained; which one wins does not matter as long as one does.
 */
function normalizeSpacing(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/\b(\d{3,4})(HD|CC)\b/gi, "$1 $2")
    .replace(/\bchassis(?:\s+cab)?\b/gi, "CC")
    .trim();
}

/**
 * The stored name for one model row.
 *
 * Ram is the exception to the make-prefix rule: its trucks are actually named
 * `Ram 1500`, so the make word is part of the model rather than a repetition
 * of it. The collector already applies that prefix; this keeps it.
 */
export function canonicalModelName(make: string, model: string): string {
  let name = normalizeSpacing(model);
  if (!name) return name;

  const makeWord = normalizeSpacing(make).toLowerCase();
  const isRam = /^ram$/i.test(makeWord);

  // `Toyota Crown` -> `Crown`, `Nissan Z` -> `Z`. Only when something survives:
  // the make on its own is the best name we have for that row.
  if (!isRam && makeWord) {
    const prefix = new RegExp(`^${makeWord.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+`, "i");
    if (prefix.test(name) && name.replace(prefix, "").trim()) {
      name = name.replace(prefix, "").trim();
    }
  }

  for (const trim of TRIM_SUFFIXES) {
    const suffix = new RegExp(`\\s+${trim}$`, "i");
    if (suffix.test(name) && name.replace(suffix, "").trim()) {
      name = name.replace(suffix, "").trim();
      break;
    }
  }

  return name;
}

/** Sum two counts, keeping `null` (unresolved) distinct from zero. */
function addCounts(left: number | null, right: number | null): number | null {
  if (left === null && right === null) return null;
  return (left ?? 0) + (right ?? 0);
}

/**
 * Normalize every row's model name and merge the rows that collide.
 *
 * Merging is the whole point: `Yukon` and `Yukon Denali` arriving as two rows
 * must leave as one row carrying both counts, not as one row that silently
 * drops the other's stock.
 */
export function normalizeModelRows(models: ModelRow[]): ModelRow[] {
  const merged = new Map<string, ModelRow>();

  for (const row of models) {
    const model = canonicalModelName(row.make, row.model);
    // Case and punctuation vary per platform (`ELANTRA` / `Elantra`), so the
    // merge key ignores both while the stored name keeps the first spelling.
    const key = `${row.make.toLowerCase()}::${model.toLowerCase().replace(/[^a-z0-9]+/g, "")}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...row, model });
      continue;
    }
    existing.inStock = addCounts(existing.inStock, row.inStock);
    existing.inTransit = addCounts(existing.inTransit, row.inTransit);
  }

  return [...merged.values()];
}
