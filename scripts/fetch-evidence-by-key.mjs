// One-off: download a single evidence object by its R2 key to a local path.
//   node scripts/fetch-evidence-by-key.mjs "<r2-key>" "<out-path>"
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

const key = process.argv[2];
const out = process.argv[3];
if (!key || !out) {
  console.error('usage: node scripts/fetch-evidence-by-key.mjs "<r2-key>" "<out-path>"');
  process.exit(1);
}

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const obj = await s3.send(
  new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key })
);
writeFileSync(out, Buffer.from(await obj.Body.transformToByteArray()));
console.log(`wrote ${out}`);
