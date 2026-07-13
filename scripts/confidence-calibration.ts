/**
 * Confidence calibration report. Reads the append-only offer_dispositions ledger
 * and answers the question that turns the publish floor from a guess into a
 * measured threshold: for offers in each confidence band, what fraction did the
 * operator DELETE (i.e. how much junk lives at that score)? A well-calibrated
 * score shows delete-rate falling monotonically as confidence rises; the right
 * REPORT_MIN_CONFIDENCE floor is the band where delete-rate drops to an
 * acceptable level. Read-only; mutates nothing.
 *
 *   npx tsx --env-file=.env scripts/confidence-calibration.ts
 */
import { desc } from "drizzle-orm";
import { getDb, offerDispositions } from "../src/lib/db";

// Half-open confidence bands [lo, hi).
const BANDS: Array<[number, number]> = [
  [0.0, 0.2],
  [0.2, 0.4],
  [0.4, 0.5],
  [0.5, 0.6],
  [0.6, 0.7],
  [0.7, 0.8],
  [0.8, 0.9],
  [0.9, 1.01],
];

function bandLabel([lo, hi]: [number, number]): string {
  const hiShown = hi > 1 ? 1.0 : hi;
  return `${lo.toFixed(2)}–${hiShown.toFixed(2)}`;
}

async function main() {
  const db = getDb();

  const rows = await db
    .select({
      disposition: offerDispositions.disposition,
      confidence: offerDispositions.confidence,
      aiAssisted: offerDispositions.aiAssisted,
      missionType: offerDispositions.missionType,
    })
    .from(offerDispositions);

  if (rows.length === 0) {
    console.log(
      "No dispositions logged yet. Pass/Delete offers in run review to build calibration data."
    );
    return;
  }

  console.log(`\n${rows.length} disposition(s) logged.\n`);
  console.log("Confidence band   kept  deleted   delete-rate");
  console.log("---------------   ----  -------   -----------");

  for (const band of BANDS) {
    const [lo, hi] = band;
    const inBand = rows.filter(
      (r) => r.confidence != null && r.confidence >= lo && r.confidence < hi
    );
    if (inBand.length === 0) continue;
    const deleted = inBand.filter((r) => r.disposition === "deleted").length;
    const kept = inBand.length - deleted;
    const rate = deleted / inBand.length;
    const bar = "█".repeat(Math.round(rate * 20));
    console.log(
      `${bandLabel(band).padEnd(15)}   ${String(kept).padStart(4)}  ${String(
        deleted
      ).padStart(7)}   ${(rate * 100).toFixed(0).padStart(3)}%  ${bar}`
    );
  }

  const nullConf = rows.filter((r) => r.confidence == null).length;
  if (nullConf > 0) console.log(`\n(${nullConf} disposition(s) had null confidence.)`);

  // Recent context so the report is legible while data is still thin.
  const recent = await db
    .select({
      disposition: offerDispositions.disposition,
      confidence: offerDispositions.confidence,
      missionType: offerDispositions.missionType,
      createdAt: offerDispositions.createdAt,
    })
    .from(offerDispositions)
    .orderBy(desc(offerDispositions.createdAt))
    .limit(10);
  console.log("\nMost recent:");
  for (const r of recent) {
    console.log(
      `  ${r.disposition.padEnd(7)} conf=${r.confidence ?? "?"} ${r.missionType ?? "?"}`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
