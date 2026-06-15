/**
 * CLI: run full analysis (including AI enrichment) on a given run ID and
 * print a before/after summary of offers.
 *
 * Usage: npx tsx --env-file=.env scripts/analyze-run.ts <runId>
 */
import { runAnalysisDirect } from "../src/lib/analysis/runner";
import { getDb, offers, sites } from "../src/lib/db";
import { eq } from "drizzle-orm";

const runId = process.argv[2];
if (!runId) {
  console.error("Usage: npx tsx --env-file=.env scripts/analyze-run.ts <runId>");
  process.exit(1);
}

async function main() {
  const db = getDb();

  // Snapshot before
  const before = await db
    .select({ id: offers.id, siteId: offers.siteId, offerType: offers.offerType,
               vehicleModel: offers.vehicleModel, confidence: offers.confidence,
               normalizedJson: offers.normalizedJson })
    .from(offers)
    .where(eq(offers.collectionRunId, runId));

  console.log(`\nBefore: ${before.length} offers`);
  const beforeNoModel = before.filter(o => !o.vehicleModel);
  console.log(`  Missing vehicle model: ${beforeNoModel.length}`);

  console.log("\nRunning analysis…");
  await runAnalysisDirect(runId);
  console.log("Done.\n");

  // Results after
  const after = await db
    .select({ siteName: sites.name, offerType: offers.offerType,
              vehicleModel: offers.vehicleModel, monthlyPayment: offers.monthlyPayment,
              apr: offers.apr, termMonths: offers.termMonths,
              confidence: offers.confidence, normalizedJson: offers.normalizedJson })
    .from(offers)
    .innerJoin(sites, eq(sites.id, offers.siteId))
    .where(eq(offers.collectionRunId, runId))
    .orderBy(sites.name, offers.offerType);

  const afterNoModel = after.filter(o => !o.vehicleModel);
  const aiAssisted = after.filter(o => (o.normalizedJson as { aiAssisted?: boolean } | null)?.aiAssisted);

  console.log(`After: ${after.length} offers`);
  console.log(`  Missing vehicle model: ${afterNoModel.length}`);
  console.log(`  AI-assisted: ${aiAssisted.length}`);

  console.log("\n── Offers ──────────────────────────────────────────────────────────");
  for (const o of after) {
    const ai = (o.normalizedJson as { aiAssisted?: boolean } | null)?.aiAssisted ? " [AI]" : "";
    const vehicle = o.vehicleModel ?? "(no model)";
    const payment = o.monthlyPayment ? `$${o.monthlyPayment}/mo` : o.apr != null ? `${o.apr}% APR` : "—";
    const term = o.termMonths ? `${o.termMonths}mo` : "";
    const conf = o.confidence != null ? `${Math.round(o.confidence * 100)}%` : "—";
    console.log(`  ${o.siteName.padEnd(34)} ${o.offerType.padEnd(10)} ${vehicle.padEnd(14)} ${payment.padEnd(12)} ${term.padEnd(5)} conf:${conf}${ai}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
