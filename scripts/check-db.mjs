import "dotenv/config";
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL);
const tables = await sql`
  SELECT table_schema, table_name
  FROM information_schema.tables
  WHERE table_schema IN ('public', 'drizzle')
  ORDER BY table_schema, table_name
`;
for (const t of tables) console.log(`${t.table_schema}.${t.table_name}`);

const cols = await sql`
  SELECT table_name, column_name, data_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
  ORDER BY table_name, ordinal_position
`;
console.log("---");
for (const c of cols) console.log(`${c.table_name}.${c.column_name} (${c.data_type})`);
