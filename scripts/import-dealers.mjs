// Idempotent dealer import. Re-run any time the CSV changes:
//   node scripts/import-dealers.mjs [path-to-csv]
//
// CSV columns (header names matter, order does not):
//   "Dealer name","State","Brand","Main site","service_path","other paths",
//   "known_platform","isDlr"
//
// Behavior:
// - The file is block-structured: each isDlr=TRUE row starts a run group
//   (named after that dealer), and the isDlr=FALSE rows beneath it are that
//   group's competitors. Dealers may repeat across blocks — sites dedupe by
//   name, group memberships overlap.
// - Sites are keyed by dealer name: existing sites are updated, new ones created.
// - Each site gets three missions (homepage_offers, service_specials,
//   finance_offers). service_path -> service mission URL; "other paths"
//   (pipe-separated) -> finance mission URL + alternates. Existing missions
//   are updated to the CSV's URLs (the CSV is the curated source of truth).
// - Group membership is replaced to match the CSV on each run.
import "dotenv/config";
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

const csvPath = process.argv[2] ?? "dealer-competitors-flat.csv";
const sql = neon(process.env.DATABASE_URL);

// --- CSV parsing (quoted fields, no embedded newlines) ---------------------

function parseCsvLine(line) {
  const fields = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields.map((f) => f.trim());
}

const lines = readFileSync(csvPath, "utf-8")
  .split(/\r?\n/)
  .filter((l) => l.trim().length > 0);
const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
const col = (row, name) => {
  const idx = header.indexOf(name.toLowerCase());
  return idx === -1 ? "" : (row[idx] ?? "");
};

const dealers = lines.slice(1).map((line) => {
  const row = parseCsvLine(line);
  const baseUrl = col(row, "Main site").replace(/\/+$/, "");
  const otherPaths = col(row, "other paths")
    .split("|")
    .map((p) => p.trim())
    .filter(Boolean);
  const joinPath = (p) => (p.startsWith("http") ? p : baseUrl + p);
  const state = col(row, "State").toUpperCase();
  return {
    name: col(row, "Dealer name"),
    state: state && state !== "--" ? state : null,
    brand: col(row, "Brand") || null,
    platform: col(row, "known_platform") || col(row, "Platform") || null,
    url: baseUrl,
    serviceUrl: col(row, "service_path")
      ? joinPath(col(row, "service_path"))
      : null,
    financeUrls: otherPaths.map(joinPath),
    isDealer: col(row, "isDlr").toUpperCase() === "TRUE",
  };
});

// --- Sites ------------------------------------------------------------------

const siteIds = new Map(); // dealer name -> site id
let sitesCreated = 0;
let sitesUpdated = 0;

for (const d of dealers) {
  const [existing] = await sql`select id from sites where name = ${d.name}`;
  if (existing) {
    await sql`
      update sites set url = ${d.url}, brand = ${d.brand}, state = ${d.state},
        platform = coalesce(${d.platform}, platform), updated_at = now()
      where id = ${existing.id}`;
    siteIds.set(d.name, existing.id);
    sitesUpdated++;
  } else {
    const [created] = await sql`
      insert into sites (name, url, brand, state, platform)
      values (${d.name}, ${d.url}, ${d.brand}, ${d.state}, ${d.platform})
      returning id`;
    siteIds.set(d.name, created.id);
    sitesCreated++;
  }
}

// --- Missions -----------------------------------------------------------------

let missionsCreated = 0;
let missionsUpdated = 0;

async function upsertMission(siteId, missionType, lastKnownUrl, alternateUrls) {
  const [existing] = await sql`
    select id from missions
    where site_id = ${siteId} and mission_type = ${missionType}`;
  if (existing) {
    if (lastKnownUrl !== undefined) {
      await sql`
        update missions
        set last_known_url = ${lastKnownUrl},
            alternate_urls = ${alternateUrls ?? []},
            updated_at = now()
        where id = ${existing.id}`;
      missionsUpdated++;
    }
  } else {
    await sql`
      insert into missions (site_id, mission_type, last_known_url, alternate_urls)
      values (${siteId}, ${missionType}, ${lastKnownUrl ?? null}, ${alternateUrls ?? []})`;
    missionsCreated++;
  }
}

for (const d of dealers) {
  const siteId = siteIds.get(d.name);
  // Homepage mission needs no URL (the collector targets the site URL);
  // never overwrite whatever it may have learned.
  await upsertMission(siteId, "homepage_offers", undefined, undefined);
  if (d.serviceUrl) {
    await upsertMission(siteId, "service_specials", d.serviceUrl, []);
  }
  if (d.financeUrls.length > 0) {
    await upsertMission(
      siteId,
      "finance_offers",
      d.financeUrls[0],
      d.financeUrls.slice(1)
    );
  }
}

// --- Run groups: one per isDlr=TRUE block, named after the primary dealer --

const blocks = [];
let currentBlock = null;
for (const d of dealers) {
  if (d.isDealer) {
    currentBlock = { primary: d, members: [d] };
    blocks.push(currentBlock);
  } else if (currentBlock) {
    currentBlock.members.push(d);
  } else {
    console.warn(`skipping "${d.name}": competitor row before any primary dealer`);
  }
}

let groupsTouched = 0;
for (const block of blocks) {
  const groupName = block.primary.name;
  let [group] = await sql`select id from run_groups where name = ${groupName}`;
  if (!group) {
    [group] = await sql`
      insert into run_groups (name) values (${groupName}) returning id`;
  } else {
    await sql`update run_groups set updated_at = now() where id = ${group.id}`;
  }
  // Replace membership to mirror the CSV block.
  await sql`delete from run_group_members where run_group_id = ${group.id}`;
  const seen = new Set();
  for (const d of block.members) {
    const siteId = siteIds.get(d.name);
    if (seen.has(siteId)) continue;
    seen.add(siteId);
    await sql`
      insert into run_group_members (run_group_id, site_id, is_primary)
      values (${group.id}, ${siteId}, ${d.isDealer})`;
  }
  groupsTouched++;
  console.log(`group "${groupName}": ${seen.size} members`);
}

console.log(
  `\nsites: ${sitesCreated} created, ${sitesUpdated} updated | ` +
    `missions: ${missionsCreated} created, ${missionsUpdated} updated | ` +
    `groups: ${groupsTouched}`
);
