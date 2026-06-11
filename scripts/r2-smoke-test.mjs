// One-off R2 credential smoke test: put → get → delete a small object.
// Run with: node scripts/r2-smoke-test.mjs
import "dotenv/config";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

const required = [
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing in .env: ${missing.join(", ")}`);
  process.exit(1);
}

const client = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const Bucket = process.env.R2_BUCKET;
const Key = `smoke-test/${Date.now()}.txt`;
const body = `dealer-intel R2 smoke test ${new Date().toISOString()}`;

try {
  await client.send(new PutObjectCommand({ Bucket, Key, Body: body }));
  console.log(`PUT ok    → ${Key}`);

  const res = await client.send(new GetObjectCommand({ Bucket, Key }));
  const echoed = await res.Body.transformToString();
  if (echoed !== body) throw new Error("GET returned different content");
  console.log("GET ok    → content matches");

  await client.send(new DeleteObjectCommand({ Bucket, Key }));
  console.log("DELETE ok → cleaned up");

  console.log("\nR2 credentials are working.");
} catch (err) {
  console.error(`\nR2 smoke test failed (${err.name}): ${err.message}`);
  if (err.name === "AccessDenied")
    console.error("Check the token's permissions and bucket scope.");
  if (err.name === "NoSuchBucket")
    console.error(`Bucket "${Bucket}" not found — check R2_BUCKET.`);
  process.exit(1);
}
