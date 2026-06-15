/**
 * Auto-detects the most recent analyzed run and publishes a frozen snapshot.
 * Usage: node scripts/publish-latest-run.mjs [--label "Optional label"] [--visible]
 *
 * Flags:
 *   --label "..."   Optional label for the snapshot
 *   --visible       Set clientVisible=true so dealer portal users can see it
 *   --dry-run       Show what would be published without writing anything
 */
import "dotenv/config";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { asc, desc, eq, isNotNull, inArray } from "drizzle-orm";
import * as schema from "../src/lib/db/schema.ts";

const sql = neon(process.env.DATABASE_URL);
const db = drizzle(sql, { schema });

const {
  collectionRuns,
  complianceGrades,
  evidence,
  offers,
  reportSnapshots,
  runGroups,
  runGroupMembers,
  collectionRunSites,
  sites,
  snapshotOffers,
} = schema;

// --- Parse CLI args ---
const args = process.argv.slice(2);
const labelIdx = args.indexOf("--label");
const LABEL = labelIdx !== -1 ? args[labelIdx + 1] : null;
const SET_VISIBLE = args.includes("--visible");
const DRY_RUN = args.includes("--dry-run");

if (DRY_RUN) console.log("DRY RUN — no changes will be written.\n");

// --- Find the most recent run with analysis completed ---
// Prefer "review" status; fall back to any run with analysisCompletedAt set.
let run = null;

// First try: review status with analysis done
const [reviewRun] = await db
  .select()
  .from(collectionRuns)
  .where(
    isNotNull(collectionRuns.analysisCompletedAt)
  )
  .orderBy(desc(collectionRuns.analysisCompletedAt))
  .limit(1);

run = reviewRun ?? null;

if (!run) {
  console.error(
    "No run with completed analysis found. Run analysis first from the /runs page."
  );
  process.exit(1);
}

console.log(`Found run: ${run.id}`);
console.log(`  Status:             ${run.status}`);
console.log(`  Analysis completed: ${run.analysisCompletedAt?.toISOString()}`);
console.log(`  Run group:          ${run.runGroupId ?? "(multi-group or all-sites)"}`);

// --- Check for existing snapshot(s) ---
const existingSnapshots = await db
  .select({ id: reportSnapshots.id, label: reportSnapshots.label, runGroupName: reportSnapshots.runGroupName })
  .from(reportSnapshots)
  .where(eq(reportSnapshots.collectionRunId, run.id));

if (existingSnapshots.length > 0) {
  console.log(`\nThis run already has ${existingSnapshots.length} snapshot(s):`);
  for (const s of existingSnapshots) {
    console.log(`  ${s.id}  ${s.runGroupName ?? "all sites"}  "${s.label ?? ""}"`);
  }
  if (!args.includes("--force")) {
    console.log("\nPass --force to publish an additional snapshot anyway.");
    process.exit(0);
  }
  console.log("\n--force specified; continuing to create additional snapshot.\n");
}

// --- Pull all offers for this run ---
const rows = await db
  .select({
    offer: offers,
    siteName: sites.name,
    siteBrand: sites.brand,
    siteState: sites.state,
    missionType: evidence.missionType,
    grade: complianceGrades.grade,
    gradeDetails: complianceGrades.detailsJson,
  })
  .from(offers)
  .innerJoin(sites, eq(sites.id, offers.siteId))
  .leftJoin(evidence, eq(evidence.id, offers.sourceEvidenceId))
  .leftJoin(
    complianceGrades,
    eq(complianceGrades.evidenceId, offers.sourceEvidenceId)
  )
  .where(eq(offers.collectionRunId, run.id))
  .orderBy(asc(sites.name));

if (rows.length === 0) {
  console.error("\nNo offers found for this run — run analysis first.");
  process.exit(1);
}

console.log(`\nOffers found: ${rows.length}`);

// --- Resolve group scope ---
let effectiveGroupId = run.runGroupId ?? null;
let effectiveGroupName = null;

if (effectiveGroupId) {
  const [group] = await db
    .select({ name: runGroups.name })
    .from(runGroups)
    .where(eq(runGroups.id, effectiveGroupId));
  effectiveGroupName = group?.name ?? null;
  console.log(`Group: ${effectiveGroupName} (${effectiveGroupId})`);
} else {
  // Multi-group / all-sites run: detect groups from collectionRunSites
  const runSiteRows = await db
    .select({ siteId: collectionRunSites.siteId })
    .from(collectionRunSites)
    .where(eq(collectionRunSites.collectionRunId, run.id));

  if (runSiteRows.length > 0) {
    const siteIds = runSiteRows.map((r) => r.siteId);
    const memberRows = await db
      .select({ runGroupId: runGroupMembers.runGroupId })
      .from(runGroupMembers)
      .where(inArray(runGroupMembers.siteId, siteIds));

    const uniqueGroupIds = [...new Set(memberRows.map((r) => r.runGroupId))];
    console.log(`Multi-group run spanning ${uniqueGroupIds.length} group(s) — creating one snapshot (all sites).`);
  } else {
    console.log("All-sites run (no site filter).");
  }
}

const distinctSites = new Set(rows.map((r) => r.offer.siteId)).size;

if (DRY_RUN) {
  console.log(`\n[DRY RUN] Would create snapshot:`);
  console.log(`  Label:       ${LABEL ?? "(none)"}`);
  console.log(`  Group:       ${effectiveGroupName ?? "all sites"}`);
  console.log(`  Offers:      ${rows.length}`);
  console.log(`  Sites:       ${distinctSites}`);
  console.log(`  clientVisible: ${SET_VISIBLE}`);
  process.exit(0);
}

// --- Create snapshot ---
const [snapshot] = await db
  .insert(reportSnapshots)
  .values({
    collectionRunId: run.id,
    runGroupId: effectiveGroupId,
    runGroupName: effectiveGroupName,
    label: LABEL?.trim() || null,
    offerCount: rows.length,
    siteCount: distinctSites,
    approvedBy: "publish-latest-run script",
    clientVisible: SET_VISIBLE,
  })
  .returning();

console.log(`\nSnapshot created: ${snapshot.id}`);

await db.insert(snapshotOffers).values(
  rows.map((r) => ({
    snapshotId: snapshot.id,
    siteId: r.offer.siteId,
    siteName: r.siteName,
    siteBrand: r.siteBrand,
    siteState: r.siteState,
    sourceEvidenceId: r.offer.sourceEvidenceId,
    missionType: r.missionType ?? "homepage_offers",
    offerType: r.offer.offerType,
    vehicleMake: r.offer.vehicleMake,
    vehicleModel: r.offer.vehicleModel,
    vehicleTrim: r.offer.vehicleTrim,
    monthlyPayment: r.offer.monthlyPayment,
    apr: r.offer.apr,
    cashIncentive: r.offer.cashIncentive,
    termMonths: r.offer.termMonths,
    dueAtSigning: r.offer.dueAtSigning,
    rawText: r.offer.rawText,
    normalizedJson: r.offer.normalizedJson,
    disclaimerText: r.offer.disclaimerText,
    confidence: r.offer.confidence,
    complianceGrade: r.grade ?? null,
    complianceDetailsJson: r.gradeDetails ?? null,
  }))
);

console.log(`Inserted ${rows.length} snapshot_offers`);

// --- Advance run status to complete if it was in review ---
if (run.status === "review") {
  await db
    .update(collectionRuns)
    .set({ status: "complete", completedAt: run.completedAt ?? new Date() })
    .where(eq(collectionRuns.id, run.id));
  console.log("Run status → complete");
}

console.log("\nSnapshot published!");
console.log(`  Admin report: /reports/${snapshot.id}`);
console.log(`  Public link:  /r/${snapshot.id}`);
if (SET_VISIBLE) {
  console.log("  clientVisible: true (dealer portal users can see this)");
} else {
  console.log("  clientVisible: false (toggle on /snapshots to share with dealers)");
}
