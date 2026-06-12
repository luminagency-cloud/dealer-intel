// One-off: show per-site mission configs (URLs + learning state).
import "dotenv/config";
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL);
const rows = await sql`
  select s.name as site, m.name as mission, sm.last_known_url,
         sm.alternate_urls, sm.last_success_at
  from site_missions sm
  join sites s on s.id = sm.site_id
  join missions m on m.id = sm.mission_id
  order by s.name, m.name
  limit ${Number(process.argv[2] ?? 20)}
`;
console.log(JSON.stringify(rows, null, 1));
