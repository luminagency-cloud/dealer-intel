import "dotenv/config";
import { neon } from "@neondatabase/serverless";

const [baselineArg, chromeArg] = process.argv.slice(2);
if (!baselineArg || !chromeArg) {
  console.error(
    "Usage: node scripts/compare-inventory-batches.mjs <api-batch-id-or-prefix> <chrome-batch-id-or-prefix>"
  );
  process.exit(1);
}

const sql = neon(process.env.DATABASE_URL);

async function resolveBatch(value) {
  const batches = await sql`
    select distinct batch_id::text as id
    from inventory_results
    where batch_id::text like ${`${value}%`}
    order by id
  `;
  if (batches.length !== 1) {
    throw new Error(
      batches.length === 0
        ? `No inventory batch starts with ${value}`
        : `Inventory batch prefix ${value} is ambiguous`
    );
  }
  return batches[0].id;
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalize(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function mapBy(rows, keyFor) {
  return new Map((rows || []).map((row) => [keyFor(row), row]));
}

function validateInternal(label, row) {
  const issues = [];
  if (row.status !== "ok") {
    issues.push(`${label} status is ${row.status}`);
    return issues;
  }
  const totals = row.totals || {};
  const makes = Array.isArray(row.make_subtotals) ? row.make_subtotals : [];
  const models = Array.isArray(row.models) ? row.models : [];
  const makeStock = makes.reduce((sum, make) => sum + (numberOrNull(make.inStock) || 0), 0);
  if (numberOrNull(totals.inStock) !== makeStock) {
    issues.push(`${label} make on-lot sum ${makeStock} != total ${totals.inStock}`);
  }
  if (numberOrNull(totals.inTransit) !== null) {
    const makeTransit = makes.reduce(
      (sum, make) => sum + (numberOrNull(make.inTransit) || 0),
      0
    );
    if (makeTransit !== totals.inTransit) {
      issues.push(`${label} make transit sum ${makeTransit} != total ${totals.inTransit}`);
    }
  }
  for (const make of makes) {
    const makeModels = models.filter(
      (model) => normalize(model.make) === normalize(make.make)
    );
    const modelStock = makeModels.reduce(
      (sum, model) => sum + (numberOrNull(model.inStock) || 0),
      0
    );
    if (modelStock !== make.inStock) {
      issues.push(
        `${label} ${make.make} model on-lot sum ${modelStock} != make ${make.inStock}`
      );
    }
    if (numberOrNull(make.inTransit) !== null) {
      const modelTransit = makeModels.reduce(
        (sum, model) => sum + (numberOrNull(model.inTransit) || 0),
        0
      );
      if (modelTransit !== make.inTransit) {
        issues.push(
          `${label} ${make.make} model transit sum ${modelTransit} != make ${make.inTransit}`
        );
      }
    }
  }
  return issues;
}

function compareCount(issues, path, baseline, chrome, tolerance = 2) {
  const expected = numberOrNull(baseline);
  const actual = numberOrNull(chrome);
  if (expected === null && actual === null) return;
  if (expected === null || actual === null || Math.abs(expected - actual) > tolerance) {
    issues.push(`${path}: API ${expected ?? "unknown"}, Chrome ${actual ?? "unknown"}`);
  }
}

function combinedCount(row) {
  const inStock = numberOrNull(row?.inStock);
  const inTransit = numberOrNull(row?.inTransit);
  if (inStock === null) return null;
  return inStock + (inTransit || 0);
}

function compareInventoryCounts(issues, path, baseline, chrome) {
  if (numberOrNull(baseline?.inTransit) === null) {
    compareCount(
      issues,
      `${path} combined`,
      combinedCount(baseline),
      combinedCount(chrome)
    );
    return;
  }
  compareCount(issues, `${path} on-lot`, baseline?.inStock, chrome?.inStock);
  compareCount(issues, `${path} transit`, baseline?.inTransit, chrome?.inTransit);
}

function compareRows(baseline, chrome) {
  const issues = [
    ...validateInternal("API", baseline),
    ...validateInternal("Chrome", chrome),
  ];
  compareInventoryCounts(issues, "total", baseline.totals, chrome.totals);

  const baselineMakes = mapBy(baseline.make_subtotals, (row) => normalize(row.make));
  const chromeMakes = mapBy(chrome.make_subtotals, (row) => normalize(row.make));
  for (const key of new Set([...baselineMakes.keys(), ...chromeMakes.keys()])) {
    const expected = baselineMakes.get(key);
    const actual = chromeMakes.get(key);
    const name = expected?.make || actual?.make || key;
    if (!expected || !actual) {
      issues.push(`make ${name}: missing from ${expected ? "Chrome" : "API"}`);
      continue;
    }
    compareInventoryCounts(issues, name, expected, actual);
  }

  const modelKey = (row) => `${normalize(row.make)}|${normalize(row.model)}`;
  const baselineModels = mapBy(baseline.models, modelKey);
  const chromeModels = mapBy(chrome.models, modelKey);
  for (const key of new Set([...baselineModels.keys(), ...chromeModels.keys()])) {
    const expected = baselineModels.get(key);
    const actual = chromeModels.get(key);
    const name = `${expected?.make || actual?.make}: ${expected?.model || actual?.model}`;
    if (!expected || !actual) {
      const nonzero = expected || actual;
      if ((numberOrNull(nonzero.inStock) || 0) > 2 || (numberOrNull(nonzero.inTransit) || 0) > 2) {
        issues.push(`model ${name}: missing from ${expected ? "Chrome" : "API"}`);
      }
      continue;
    }
    compareInventoryCounts(issues, name, expected, actual);
  }
  return issues;
}

const [baselineBatch, chromeBatch] = await Promise.all([
  resolveBatch(baselineArg),
  resolveBatch(chromeArg),
]);
const rows = await sql`
  select ir.batch_id::text,
         ir.status,
         ir.access_route,
         ir.totals,
         ir.make_subtotals,
         ir.models,
         ir.error,
         s.id::text as site_id,
         s.name as site,
         s.platform
  from inventory_results ir
  join sites s on s.id = ir.site_id
  where ir.batch_id in (${baselineBatch}::uuid, ${chromeBatch}::uuid)
  order by s.name, ir.collected_at desc
`;
const baselineRows = rows.filter((row) => row.batch_id === baselineBatch);
const chromeRows = rows.filter((row) => row.batch_id === chromeBatch);
const siteIds = new Set([
  ...baselineRows.map((row) => row.site_id),
  ...chromeRows.map((row) => row.site_id),
]);
const summary = [];
let failed = false;
for (const siteId of siteIds) {
  const baseline = baselineRows.find((row) => row.site_id === siteId);
  const chrome = chromeRows.find((row) => row.site_id === siteId);
  const site = baseline?.site || chrome?.site || siteId;
  let issues;
  if (!baseline || !chrome) {
    issues = [`missing ${baseline ? "Chrome" : "API"} result`];
  } else if (normalize(baseline.platform) !== normalize(chrome.platform)) {
    issues = [
      `platform mismatch: API ${baseline.platform || "unknown"}, Chrome ${chrome.platform || "unknown"}`,
    ];
  } else if (!new Set(["ddc", "dealer_inspire"]).has(normalize(baseline.platform))) {
    issues = [`comparison platform ${baseline.platform || "unknown"} is not registered`];
  } else {
    issues = compareRows(baseline, chrome);
  }
  if (issues.length > 0) failed = true;
  summary.push({
    site,
    api: baseline?.totals?.displayValue || baseline?.status || "missing",
    chrome: chrome?.totals?.displayValue || chrome?.status || "missing",
    result: issues.length === 0 ? "PASS" : "FAIL",
    issues: issues.join("; "),
  });
}

console.log(`API ${baselineBatch.slice(0, 8)} vs Chrome ${chromeBatch.slice(0, 8)}`);
console.table(summary);
if (failed) process.exitCode = 2;
