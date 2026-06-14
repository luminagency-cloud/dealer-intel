import "dotenv/config";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { asc, eq } from "drizzle-orm";
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
  sites,
  snapshotOffers,
} = schema;

const RUN_ID = "706c814d-cdce-4cb0-a48e-5cb635ccfd6e";
const LABEL = "Elmwood Suite · Jun 2026";
const APPROVED_BY = "admin-script";

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
  .where(eq(offers.collectionRunId, RUN_ID))
  .orderBy(asc(sites.name));

if (rows.length === 0) {
  console.error("No offers found for run — run analysis first.");
  process.exit(1);
}

console.log(`Found ${rows.length} offers across run ${RUN_ID}`);

const [run] = await db
  .select({ runGroupId: collectionRuns.runGroupId })
  .from(collectionRuns)
  .where(eq(collectionRuns.id, RUN_ID));

let runGroupName = null;
if (run?.runGroupId) {
  const [group] = await db
    .select({ name: runGroups.name })
    .from(runGroups)
    .where(eq(runGroups.id, run.runGroupId));
  runGroupName = group?.name ?? null;
}

const distinctSites = new Set(rows.map((r) => r.offer.siteId)).size;

const [snapshot] = await db
  .insert(reportSnapshots)
  .values({
    collectionRunId: RUN_ID,
    runGroupId: run?.runGroupId ?? null,
    runGroupName,
    label: LABEL,
    offerCount: rows.length,
    siteCount: distinctSites,
    approvedBy: APPROVED_BY,
  })
  .returning();

console.log(`Created snapshot: ${snapshot.id}`);

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
console.log(`\nSnapshot published!`);
console.log(`Admin view: http://localhost:3000/reports/${snapshot.id}`);
console.log(`Public link: http://localhost:3000/r/${snapshot.id}`);
