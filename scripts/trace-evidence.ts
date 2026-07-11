/**
 * Read-only: list every evidence row for a dealer-name substring in the latest
 * run, grouped by mission → evidence type, with labels. Answers "what did we
 * actually capture on this site?". Mutates nothing.
 *
 *   npx tsx --env-file=.env scripts/trace-evidence.ts "langway"
 */
import { desc, eq, ilike, sql } from "drizzle-orm";
import { getDb, collectionRuns, sites, evidence } from "../src/lib/db";

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
  console.log(`Latest run ${run.id.slice(0, 8)} (${run.createdAt.toISOString()})\n`);

  const matched = await db
    .select({ id: sites.id, name: sites.name })
    .from(sites)
    .where(ilike(sites.name, `%${needle}%`));

  for (const site of matched) {
    console.log(`### ${site.name}  ${site.id.slice(0, 8)}`);
    const rows = await db
      .select({
        mission: evidence.missionType,
        evType: evidence.evidenceType,
        label: evidence.label,
        text: evidence.textContent,
        shot: evidence.screenshotUrl,
        html: evidence.htmlUrl,
      })
      .from(evidence)
      .where(sql`${evidence.siteId} = ${site.id} and ${evidence.collectionRunId} = ${run.id}`)
      .orderBy(evidence.missionType, evidence.evidenceType);

    let curMission = "";
    for (const r of rows) {
      if (r.mission !== curMission) {
        curMission = r.mission;
        console.log(`\n  == mission: ${curMission}`);
      }
      const asset = r.shot ?? r.html ?? "(no asset)";
      console.log(`    [${r.evType}] ${r.label ?? "(no label)"}`);
      console.log(`        ${asset}`);
      if (r.text) console.log(`        text: ${JSON.stringify(r.text).slice(0, 120)}`);
    }
    console.log(`\n  (${rows.length} evidence rows)\n`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
