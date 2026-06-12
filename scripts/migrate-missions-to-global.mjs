// One-time data migration (between schema steps A and B): collapse per-site
// mission rows into the global mission layer + site_missions config.
//
// 1. Create one global mission per distinct mission_type (named from labels).
// 2. Copy per-site URL/learning data into site_missions.
// 3. Remap mission_results.mission_id to the global ids.
// 4. Delete the old per-site mission rows.
//
// Idempotent: skips rows that already exist; safe to re-run if interrupted.
import "dotenv/config";
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL);

const LABELS = {
  homepage_offers: "Homepage Offers",
  finance_offers: "Finance Offers",
  service_specials: "Service Specials",
  promotional_banners: "Promotional Banners",
};

// Old per-site rows are identifiable by having a site_id; global rows by
// having a name (set below) — using name as the marker.
const types = await sql`
  select distinct mission_type from missions`;

const globalIds = {};
for (const { mission_type } of types) {
  const name = LABELS[mission_type] ?? mission_type;
  let [g] = await sql`
    select id from missions where name = ${name} and mission_type = ${mission_type}`;
  if (!g) {
    // Global rows still need a site_id until step B drops the column —
    // borrow any site's id; the column is dropped immediately after.
    const [anySite] = await sql`select id from sites limit 1`;
    [g] = await sql`
      insert into missions (name, site_id, mission_type)
      values (${name}, ${anySite.id}, ${mission_type})
      returning id`;
  }
  globalIds[mission_type] = g.id;
}
console.log("global missions:", Object.keys(globalIds).join(", "));

const oldRows = await sql`
  select * from missions where name is null`;
console.log(`migrating ${oldRows.length} per-site mission rows…`);

let copied = 0;
for (const m of oldRows) {
  const globalId = globalIds[m.mission_type];
  await sql`
    insert into site_missions
      (site_id, mission_id, last_known_url, alternate_urls, success_rate,
       last_success_at, active, created_at, updated_at)
    values
      (${m.site_id}, ${globalId}, ${m.last_known_url}, ${m.alternate_urls},
       ${m.success_rate}, ${m.last_success_at}, ${m.active}, ${m.created_at},
       ${m.updated_at})
    on conflict (site_id, mission_id) do update set
      last_known_url = excluded.last_known_url,
      alternate_urls = excluded.alternate_urls,
      success_rate = excluded.success_rate,
      last_success_at = excluded.last_success_at,
      active = excluded.active`;
  await sql`
    update mission_results set mission_id = ${globalId}
    where mission_id = ${m.id}`;
  await sql`delete from missions where id = ${m.id}`;
  copied++;
}

const [counts] = await sql`
  select
    (select count(*) from missions) as missions,
    (select count(*) from site_missions) as site_missions,
    (select count(*) from mission_results) as results`;
console.log(`done. copied ${copied}.`, counts);
