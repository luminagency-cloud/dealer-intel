/**
 * Read-only provenance trace: for a dealer-name substring, list every offer in
 * the latest run and the exact evidence page it was extracted from (mission,
 * evidence type, label, screenshot/html). Answers "where did this offer come
 * from?". Mutates nothing.
 *
 *   npx tsx --env-file=.env scripts/trace-offers.ts "langway"
 */
import { desc, eq, ilike, sql } from "drizzle-orm";
import { getDb, collectionRuns, sites, offers, evidence } from "../src/lib/db";

const needle = process.argv[2] ?? "langway";

async function main() {
  const db = getDb();

  const run = (
    await db
      .select({ id: collectionRuns.id, createdAt: collectionRuns.createdAt })
      .from(collectionRuns)
      .orderBy(desc(collectionRuns.createdAt))
      .limit(1)
  )[0];
  if (!run) {
    console.error("No runs found.");
    process.exitCode = 1;
    return;
  }
  console.log(`Latest run ${run.id.slice(0, 8)} (${run.createdAt.toISOString()})\n`);

  const matchedSites = await db
    .select({ id: sites.id, name: sites.name, platform: sites.platform })
    .from(sites)
    .where(ilike(sites.name, `%${needle}%`));

  if (matchedSites.length === 0) {
    console.error(`No site matching "${needle}".`);
    process.exitCode = 1;
    return;
  }

  for (const site of matchedSites) {
    console.log(`### ${site.name}  [${site.platform ?? "?"}]  ${site.id.slice(0, 8)}`);

    const rows = await db
      .select({
        offerType: offers.offerType,
        model: offers.vehicleModel,
        pay: offers.monthlyPayment,
        apr: offers.apr,
        cash: offers.cashIncentive,
        sale: offers.salePrice,
        raw: offers.rawText,
        conf: offers.confidence,
        nj: offers.normalizedJson,
        evId: offers.sourceEvidenceId,
        mission: evidence.missionType,
        evType: evidence.evidenceType,
        label: evidence.label,
        shot: evidence.screenshotUrl,
        html: evidence.htmlUrl,
      })
      .from(offers)
      .leftJoin(evidence, eq(evidence.id, offers.sourceEvidenceId))
      .where(sql`${offers.siteId} = ${site.id} and ${offers.collectionRunId} = ${run.id}`);

    if (rows.length === 0) {
      console.log("  (no offers in latest run)\n");
      continue;
    }

    const byEvidence = new Map<string, { rows: typeof rows; meta: (typeof rows)[number] }>();
    for (const r of rows) {
      const key = r.evId ?? "NULL";
      const g = byEvidence.get(key) ?? { rows: [] as typeof rows, meta: r };
      g.rows.push(r);
      byEvidence.set(key, g);
    }

    for (const [evId, g] of byEvidence) {
      const m = g.meta;
      console.log(
        `\n  -- source evidence ${evId === "NULL" ? "NULL (manual/legacy)" : evId.slice(0, 8)}` +
          ` | mission=${m.mission ?? "?"} type=${m.evType ?? "?"}`
      );
      console.log(`     label: ${m.label ?? "(none)"}`);
      if (m.html) console.log(`     html : ${m.html}`);
      if (m.shot) console.log(`     shot : ${m.shot}`);
      console.log(`     ${g.rows.length} offer(s):`);
      for (const r of g.rows) {
        const ai = (r.nj as { aiAssisted?: boolean } | null)?.aiAssisted ? " [AI]" : "";
        const money = [
          r.pay != null ? `pay=${r.pay}` : null,
          r.apr != null ? `apr=${r.apr}` : null,
          r.cash != null ? `cash=${r.cash}` : null,
          r.sale != null ? `sale=${r.sale}` : null,
        ]
          .filter(Boolean)
          .join(" ");
        console.log(`        - ${r.offerType}${ai} ${r.model ?? ""} ${money}  conf=${r.conf ?? "?"}`);
        console.log(`          raw: ${JSON.stringify(r.raw)?.slice(0, 160)}`);
      }
    }
    console.log("");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
