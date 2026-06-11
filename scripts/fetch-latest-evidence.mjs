// One-off: download the newest disclaimer screenshot and main screenshot
// for eyeballing collected evidence quality.
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

const sql = neon(process.env.DATABASE_URL);
const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

for (const type of ["disclaimer_screenshot", "screenshot"]) {
  const [row] = await sql`
    select screenshot_url from evidence
    where evidence_type = ${type} and screenshot_url is not null
    order by created_at desc limit 1`;
  if (!row) continue;
  const obj = await s3.send(
    new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: row.screenshot_url })
  );
  const out = `${process.env.TEMP}/evidence-${type}.png`;
  writeFileSync(out, Buffer.from(await obj.Body.transformToByteArray()));
  console.log(out);
}
