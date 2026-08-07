// Repairs site_missions rows the Chrome collector poisoned before it had URL
// discovery: it handed every mission the dealer homepage, then memorized that
// homepage as the mission's page. A memorized URL beats discovery, so those
// rows keep the bug alive even after the code fix — clearing them lets the
// next run rediscover the real page.
//
// Only touches non-homepage missions whose last_known_url IS the dealer
// homepage. Homepage/banner missions legitimately point there.
//   node scripts/clear-homepage-mission-memory.mjs [--apply]
//
// The comparison must ignore `www.`, not just the trailing slash. Dealers are
// configured at the apex and redirect to `www.`, so the memorized homepage is
// `https://www.example.com/` against a site url of `https://example.com`. A
// plain string compare called that a different page and this script reported
// zero rows while 28 were pinned to the homepage.
import "dotenv/config";
import { neon } from "@neondatabase/serverless";

const apply = process.argv.includes("--apply");
const sql = neon(process.env.DATABASE_URL);

/** `https://www.example.com/path/` -> `example.com/path`
 *
 *  The backslash is doubled because this is a JS template literal: `\.` is not
 *  a recognized escape and cooks away to a bare `.`, which would let the
 *  pattern strip any character after `www`. */
const SAME_PAGE = sql`
  regexp_replace(rtrim(sm.last_known_url, '/'), '^https?://(www\\.)?', '')
  = regexp_replace(rtrim(s.url, '/'), '^https?://(www\\.)?', '')
`;

const affected = await sql`
  SELECT s.name, m.mission_type, sm.last_known_url
  FROM site_missions sm
  JOIN sites s ON s.id = sm.site_id
  JOIN missions m ON m.id = sm.mission_id
  WHERE m.mission_type NOT IN ('homepage_offers', 'promotional_banners')
    AND sm.last_known_url IS NOT NULL
    AND ${SAME_PAGE}
  ORDER BY s.name, m.mission_type
`;

for (const row of affected) {
  console.log(`${row.mission_type.padEnd(18)} ${row.name.padEnd(30)} ${row.last_known_url}`);
}
console.log(`\n${affected.length} row(s) pinned to the dealer homepage.`);

if (!apply) {
  console.log("Dry run. Re-run with --apply to clear last_known_url on these rows.");
} else {
  const cleared = await sql`
    UPDATE site_missions sm
    SET last_known_url = NULL, updated_at = now()
    FROM sites s, missions m
    WHERE s.id = sm.site_id
      AND m.id = sm.mission_id
      AND m.mission_type NOT IN ('homepage_offers', 'promotional_banners')
      AND sm.last_known_url IS NOT NULL
      AND ${SAME_PAGE}
    RETURNING sm.id
  `;
  console.log(`Cleared ${cleared.length} row(s).`);
}
