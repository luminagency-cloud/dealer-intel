/**
 * Read-only verification of a run's extracted offers — every type. Prints
 * counts by type, per-type coverage, quality/regression guards that should stay
 * empty, a compliance-grade breakdown, and the short list worth a human glance.
 * Mutates nothing.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/verify-offers.ts [runId]
 * Accepts a full uuid, the short id the UI shows (e.g. "f1a32685"), or nothing
 * (defaults to the most recently created run).
 */
import { and, desc, eq, sql } from "drizzle-orm";
import {
  getDb,
  collectionRuns,
  sites,
  evidence,
  offers,
  complianceGrades,
} from "../src/lib/db";

// Junk that must never appear in a service offer value/label.
const CHROME = /wild ?card|claim offer|schedule service|book now|learn more/i;

// Plausible bands for priced vehicle offers (mirrors extract.ts guards).
const RANGE = {
  monthlyPayment: [50, 2000],
  apr: [0, 30],
  termMonths: [12, 96],
  cashIncentive: [250, 25_000],
  salePrice: [5_000, 200_000],
  dueAtSigning: [0, 20_000],
} as const;

type NormalizedJson = {
  aiAssisted?: boolean;
  matches?: { serviceOffer?: string; verify?: string; ocrValue?: string; altValue?: string };
} | null;

const verifyOf = (nj: NormalizedJson) => nj?.matches?.verify ?? "dom";
const svcValue = (nj: NormalizedJson) => nj?.matches?.serviceOffer ?? "";
const outOfRange = (v: number | null, [lo, hi]: readonly [number, number]) => v != null && (v < lo || v > hi);

async function resolveRunId(): Promise<string | undefined> {
  const db = getDb();
  const arg = process.argv[2];
  if (arg) {
    const m = await db
      .select({ id: collectionRuns.id })
      .from(collectionRuns)
      .where(sql`${collectionRuns.id}::text like ${arg + "%"}`)
      .limit(1);
    return m[0]?.id;
  }
  const m = await db
    .select({ id: collectionRuns.id })
    .from(collectionRuns)
    .orderBy(desc(collectionRuns.createdAt))
    .limit(1);
  return m[0]?.id;
}

async function main() {
  const db = getDb();
  const runId = await resolveRunId();
  if (!runId) {
    console.error(process.argv[2] ? `No run matching "${process.argv[2]}".` : "No runs found.");
    process.exitCode = 1;
    return;
  }
  console.log(`Verifying run ${runId.slice(0, 8)}\n`);

  const rows = await db
    .select({
      site: sites.name,
      platform: sites.platform,
      type: offers.offerType,
      label: offers.rawText,
      model: offers.vehicleModel,
      term: offers.termMonths,
      apr: offers.apr,
      pay: offers.monthlyPayment,
      due: offers.dueAtSigning,
      cash: offers.cashIncentive,
      sale: offers.salePrice,
      disclaimer: offers.disclaimerText,
      nj: offers.normalizedJson,
    })
    .from(offers)
    .innerJoin(sites, eq(sites.id, offers.siteId))
    .where(eq(offers.collectionRunId, runId));

  const njOf = (r: (typeof rows)[number]) => r.nj as NormalizedJson;

  // --- Counts by type --------------------------------------------------------
  const byType: Record<string, number> = {};
  for (const r of rows) byType[r.type] = (byType[r.type] ?? 0) + 1;
  console.log(`=== OFFERS BY TYPE (${rows.length} total) ===`);
  console.log(
    "  " +
      ["lease", "finance", "cash", "service", "promotional"]
        .map((t) => `${t}:${byType[t] ?? 0}`)
        .join("  ")
  );
  const aiCount = rows.filter((r) => njOf(r)?.aiAssisted).length;
  console.log(`  AI-assisted: ${aiCount}`);

  // ===========================================================================
  // SERVICE
  // ===========================================================================
  const svc = rows.filter((r) => r.type === "service");
  console.log(`\n=== SERVICE (${svc.length}) ===`);
  const svcBySite = new Map<string, typeof svc>();
  for (const r of svc) {
    const key = `${r.site} ${r.platform ?? "?"}`;
    (svcBySite.get(key) ?? svcBySite.set(key, []).get(key)!).push(r);
  }
  for (const [key, rs] of [...svcBySite.entries()].sort()) {
    const [name, platform] = key.split(" ");
    const mix: Record<string, number> = {};
    for (const r of rs) mix[verifyOf(njOf(r))] = (mix[verifyOf(njOf(r))] ?? 0) + 1;
    console.log(`  ${name} [${platform}]  ${rs.length}  { ${Object.entries(mix).map(([k, v]) => `${k}:${v}`).join(", ")} }`);
  }

  const svcPages = await db
    .select({ name: sites.name, platform: sites.platform })
    .from(evidence)
    .innerJoin(sites, eq(sites.id, evidence.siteId))
    .where(and(eq(evidence.collectionRunId, runId), eq(evidence.evidenceType, "html_snapshot"), eq(evidence.missionType, "service_specials")))
    .groupBy(sites.name, sites.platform);
  const svcSites = new Set(svc.map((r) => r.site));
  const zeroSvc = svcPages.filter((p) => !svcSites.has(p.name));
  console.log(`  zero-offer service pages: ${zeroSvc.length ? zeroSvc.map((z) => `${z.name}[${z.platform ?? "?"}]`).join(", ") : "none"}`);

  // ===========================================================================
  // VEHICLE OFFERS (lease / finance / cash)
  // ===========================================================================
  const veh = rows.filter((r) => r.type === "lease" || r.type === "finance" || r.type === "cash");
  console.log(`\n=== VEHICLE OFFERS (${veh.length}) ===`);
  const noModel = veh.filter((r) => !r.model);
  const noDisclaimer = veh.filter((r) => !r.disclaimer);
  console.log(`  missing vehicle model: ${noModel.length}`);
  console.log(`  missing disclaimer (needed for compliance): ${noDisclaimer.length}`);

  // Classification sanity — the fingerprint each type should carry.
  const badLease = veh.filter((r) => r.type === "lease" && (r.pay == null || r.due == null));
  const badFinance = veh.filter((r) => r.type === "finance" && r.apr == null && !(r.pay != null && r.term != null));
  const badCash = veh.filter((r) => r.type === "cash" && r.cash == null && r.sale == null);

  // ===========================================================================
  // REGRESSION GUARDS (should all be 0)
  // ===========================================================================
  console.log(`\n=== REGRESSION GUARDS (should all be 0) ===`);
  const svcVehFields = svc.filter((r) => r.term != null || r.apr != null || r.pay != null || r.due != null || r.cash != null || r.sale != null);
  const svcDisc = svc.filter((r) => r.disclaimer);
  const svcChrome = svc.filter((r) => CHROME.test(String(r.label ?? "")) || CHROME.test(svcValue(njOf(r))));
  const outRange = veh.filter(
    (r) =>
      outOfRange(r.pay, RANGE.monthlyPayment) ||
      outOfRange(r.apr, RANGE.apr) ||
      outOfRange(r.term, RANGE.termMonths) ||
      outOfRange(r.cash, RANGE.cashIncentive) ||
      outOfRange(r.sale, RANGE.salePrice) ||
      outOfRange(r.due, RANGE.dueAtSigning)
  );
  const guards: [string, typeof rows][] = [
    ["service w/ vehicle fields", svcVehFields],
    ["service w/ disclaimer", svcDisc],
    ["service w/ UI-chrome/wildcard", svcChrome],
    ["vehicle value out of range", outRange],
    ["lease missing payment/due-at-signing", badLease],
    ["finance missing APR and term", badFinance],
    ["cash missing incentive and price", badCash],
  ];
  for (const [name, list] of guards) {
    console.log(`  ${name}: ${list.length}`);
    list.slice(0, 6).forEach((r) => console.log(`     ! ${r.site} [${r.type}]: "${r.label ?? ""}" pay=${r.pay} apr=${r.apr} term=${r.term} cash=${r.cash} sale=${r.sale} due=${r.due}`));
  }

  // ===========================================================================
  // COMPLIANCE
  // ===========================================================================
  const grades = await db
    .select({ grade: complianceGrades.grade, n: sql<number>`count(*)` })
    .from(complianceGrades)
    .where(eq(complianceGrades.collectionRunId, runId))
    .groupBy(complianceGrades.grade);
  console.log(`\n=== COMPLIANCE GRADES ===`);
  if (grades.length === 0) console.log("  none");
  for (const g of grades.sort((a, b) => Number(b.n) - Number(a.n))) console.log(`  ${g.grade}: ${Number(g.n)}`);

  // ===========================================================================
  // EYEBALL
  // ===========================================================================
  console.log(`\n=== EYEBALL ===`);
  const mism = svc.filter((r) => verifyOf(njOf(r)) === "mismatch");
  console.log(`  service OCR/alt mismatches (${mism.length}):`);
  for (const r of mism) {
    const nj = njOf(r);
    console.log(`     ${r.site}: ${r.label}  ocr="${nj?.matches?.ocrValue}"  alt="${nj?.matches?.altValue}"`);
  }
  if (noModel.length) console.log(`  vehicle offers with no model (${noModel.length}): ${noModel.slice(0, 10).map((r) => `${r.site}[${r.type}]`).join(", ")}${noModel.length > 10 ? " …" : ""}`);

  const guardsClean = guards.every(([, l]) => l.length === 0);
  console.log(`\n${guardsClean ? "✓ regression guards clean" : "✗ REGRESSION GUARD TRIPPED — see above"}`);
}

// No process.exit(): let Node drain the Neon HTTP handles naturally. Forcing an
// exit here is what triggered the libuv "UV_HANDLE_CLOSING" assertion on Windows.
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
