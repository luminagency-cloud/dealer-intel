import "dotenv/config";
import { neon } from "@neondatabase/serverless";
const sql = neon(process.env.DATABASE_URL);
const rows = await sql.query(process.argv[2]);
console.log(JSON.stringify(rows, null, 1));
