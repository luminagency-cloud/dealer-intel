// Yield-anomaly scan for a run: where did collection succeed but analysis
// produce nothing? A dealer with no finance offers is normal; ten dealers whose
// finance mission succeeded and yielded three offers between them is our bug.
//
// Usage: node scripts/anomaly-scan.mjs [runId]   (defaults to the newest run)
import "dotenv/config";
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL);

const runId =
  process.argv[2] ??
  (
    await sql`SELECT id FROM collection_runs ORDER BY started_at DESC NULLS LAST LIMIT 1`
  )[0]?.id;
if (!runId) throw new Error("no runs");

// Offers join back to their mission through the evidence row they came from,
// so per-mission yield needs that hop.
const yieldByMission = await sql`
  SELECT m.mission_type,
    count(*)::int AS sites_ok,
    coalesce(sum(o.n), 0)::int AS offers,
    count(*) FILTER (WHERE coalesce(o.n, 0) = 0)::int AS sites_zero
  FROM mission_results m
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS n
    FROM offers off
    JOIN evidence e ON e.id = off.source_evidence_id
    WHERE off.collection_run_id = ${runId}
      AND e.site_id = m.site_id
      AND e.mission_type = m.mission_type
  ) o ON true
  WHERE m.collection_run_id = ${runId}
    AND m.status IN ('success', 'needs_review')
  GROUP BY m.mission_type
  ORDER BY m.mission_type`;

console.log(`run ${runId}`);
console.log("\n== yield per mission (successful missions only)");
console.table(
  yieldByMission.map((r) => ({
    ...r,
    per_site: r.sites_ok ? (r.offers / r.sites_ok).toFixed(1) : "—",
    zero_pct: r.sites_ok ? Math.round((100 * r.sites_zero) / r.sites_ok) + "%" : "—",
  }))
);

// The actionable list: mission captured pages, analysis read them, nothing came
// out. Either the page was wrong or extraction missed it.
const silent = await sql`
  SELECT s.name, m.mission_type, m.pages_captured,
    (SELECT count(*)::int FROM evidence e
      WHERE e.collection_run_id = ${runId} AND e.site_id = m.site_id
        AND e.mission_type = m.mission_type AND e.evidence_type = 'html_snapshot') AS html_pages,
    left(coalesce(m.successful_url, ''), 70) AS url
  FROM mission_results m
  JOIN sites s ON s.id = m.site_id
  WHERE m.collection_run_id = ${runId}
    AND m.status IN ('success', 'needs_review')
    AND NOT EXISTS (
      SELECT 1 FROM offers off
      JOIN evidence e ON e.id = off.source_evidence_id
      WHERE off.collection_run_id = ${runId}
        AND e.site_id = m.site_id AND e.mission_type = m.mission_type
    )
  ORDER BY m.mission_type, s.name`;

console.log(`\n== silent missions: captured pages, produced zero offers (${silent.length})`);
console.table(silent);

// Same page captured for two missions means discovery landed on the wrong URL;
// analysis dedups it away and the second mission reports success with no yield.
const dupUrls = await sql`
  SELECT s.name, m.successful_url, string_agg(m.mission_type::text, ', ') AS missions
  FROM mission_results m
  JOIN sites s ON s.id = m.site_id
  WHERE m.collection_run_id = ${runId} AND m.successful_url IS NOT NULL
  GROUP BY s.name, m.successful_url
  HAVING count(*) > 1
  ORDER BY s.name`;

console.log(`\n== same URL claimed by multiple missions (${dupUrls.length})`);
console.table(dupUrls);
