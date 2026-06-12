// One-off: verify a deep-deleted run left nothing in R2 or Postgres.
import "dotenv/config";
import { neon } from "@neondatabase/serverless";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";

const runId = process.argv[2];
const sql = neon(process.env.DATABASE_URL);
const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const [r2, runs, ev, res] = await Promise.all([
  s3.send(
    new ListObjectsV2Command({
      Bucket: process.env.R2_BUCKET,
      Prefix: `runs/${runId.slice(0, 8)}`,
    })
  ),
  sql`select count(*) n from collection_runs where id = ${runId}`,
  sql`select count(*) n from evidence where collection_run_id = ${runId}`,
  sql`select count(*) n from mission_results where collection_run_id = ${runId}`,
]);
console.log(
  `R2 objects: ${(r2.Contents ?? []).length} | run rows: ${runs[0].n} | evidence rows: ${ev[0].n} | result rows: ${res[0].n}`
);
