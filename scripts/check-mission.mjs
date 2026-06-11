// One-off: show service_specials missions' learned URLs.
import "dotenv/config";
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL);
const rows = await sql`
  select s.name, m.mission_type, m.last_known_url, m.alternate_urls, m.last_success_at
  from missions m join sites s on s.id = m.site_id
  order by s.name, m.mission_type
`;
console.log(JSON.stringify(rows, null, 1));
