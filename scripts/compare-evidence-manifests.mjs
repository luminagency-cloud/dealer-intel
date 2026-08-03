import "dotenv/config";
import { neon } from "@neondatabase/serverless";

const [currentRunArg, chromeRunArg, siteFilter = ""] = process.argv.slice(2);
if (!currentRunArg || !chromeRunArg) {
  console.error(
    "Usage: node scripts/compare-evidence-manifests.mjs <current-run-id-or-prefix> <chrome-run-id-or-prefix> [site-name]"
  );
  process.exit(1);
}

const sql = neon(process.env.DATABASE_URL);

async function resolveRun(value) {
  const rows = await sql`
    select id::text as id, collector_mode, status
    from collection_runs
    where id::text like ${`${value}%`}
    order by created_at desc
    limit 2
  `;
  if (rows.length !== 1) {
    throw new Error(
      rows.length === 0
        ? `No run starts with ${value}`
        : `Run prefix ${value} is ambiguous`
    );
  }
  return rows[0];
}

function inferredKind(row) {
  if (row.capture_state) return row.capture_state;
  if (row.evidence_type === "disclaimer_screenshot") return "disclaimer";
  if (row.evidence_type === "failure_screenshot") return "failure";
  if (/^carousel slide\b/i.test(row.label || "")) return "carousel";
  if (/^tab\b/i.test(row.label || "")) return "tab";
  return "base";
}

function logicalStateKey(row) {
  return [
    row.site,
    row.mission_type,
    inferredKind(row),
    row.capture_state_id || row.label || row.source_url || "unlabeled",
  ].join("|");
}

function manifest(rows) {
  const states = new Map();
  for (const row of rows) {
    const key = logicalStateKey(row);
    const existing = states.get(key) || {
      site: row.site,
      mission: row.mission_type,
      kind: inferredKind(row),
      order: row.capture_order,
      label: row.label || "",
      url: row.source_url || "",
      artifacts: new Set(),
      hasText: false,
    };
    existing.artifacts.add(row.evidence_type);
    existing.hasText ||= Boolean(row.text_content);
    states.set(key, existing);
  }
  return [...states.values()].map((state) => ({
    ...state,
    artifacts: [...state.artifacts].sort().join(" + "),
  }));
}

function counts(states) {
  const result = new Map();
  for (const state of states) {
    const key = `${state.site}|${state.mission}|${state.kind}`;
    result.set(key, (result.get(key) || 0) + 1);
  }
  return result;
}

function carouselCoverage(states) {
  const coverage = new Map();
  for (const state of states.filter((candidate) => candidate.kind === "carousel")) {
    const match = state.label.match(/^Carousel slide (\d+) of (\d+)/i);
    if (!match) continue;
    const key = `${state.site}|${state.mission}|carousel`;
    const existing = coverage.get(key) || { ordinals: new Set(), total: 0 };
    existing.ordinals.add(Number(match[1]));
    existing.total = Math.max(existing.total, Number(match[2]));
    coverage.set(key, existing);
  }
  return coverage;
}

const [currentRun, chromeRun] = await Promise.all([
  resolveRun(currentRunArg),
  resolveRun(chromeRunArg),
]);
const rows = await sql`
  select e.collection_run_id::text as run_id,
         s.name as site,
         e.mission_type,
         e.evidence_type,
         e.label,
         e.text_content,
         e.capture_state_id,
         e.capture_state,
         e.capture_order,
         e.source_url
  from evidence e
  join sites s on s.id = e.site_id
  where e.collection_run_id in (${currentRun.id}::uuid, ${chromeRun.id}::uuid)
    and (${siteFilter} = '' or s.name ilike ${`%${siteFilter}%`})
  order by s.name, e.mission_type, e.capture_order nulls first, e.created_at
`;

const currentStates = manifest(rows.filter((row) => row.run_id === currentRun.id));
const chromeStates = manifest(rows.filter((row) => row.run_id === chromeRun.id));
const currentCounts = counts(currentStates);
const chromeCounts = counts(chromeStates);
const chromeCarouselCoverage = carouselCoverage(chromeStates);
const keys = [...new Set([...currentCounts.keys(), ...chromeCounts.keys()])].sort();
const comparison = keys.map((key) => {
  const [site, mission, kind] = key.split("|");
  const current = currentCounts.get(key) || 0;
  const chrome = chromeCounts.get(key) || 0;
  const coverage = chromeCarouselCoverage.get(key);
  const completeCarousel =
    !coverage ||
    (coverage.total > 0 && coverage.ordinals.size === coverage.total);
  return {
    site,
    mission,
    kind,
    current,
    chrome,
    delta: chrome - current,
    coverage: coverage ? `${coverage.ordinals.size}/${coverage.total}` : "—",
    parity:
      kind === "failure"
        ? "n/a"
        : chrome >= current && completeCarousel
          ? "yes"
          : "NO",
  };
});

console.log(
  `Current ${currentRun.id.slice(0, 8)} (${currentRun.status}) vs Chrome ${chromeRun.id.slice(0, 8)} (${chromeRun.status})`
);
console.table(comparison);
console.log("\nCurrent manifest");
console.table(currentStates);
console.log("\nChrome manifest");
console.table(chromeStates);

if (comparison.some((row) => row.parity === "NO")) process.exitCode = 2;
