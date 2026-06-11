import { S3Client } from "@aws-sdk/client-s3";
import { requireEnv } from "@/lib/env";

/**
 * Cloudflare R2 client (S3-compatible). Evidence upload/retrieval services
 * are built on top of this in Phase 4; Phase 1 only establishes the
 * configured client.
 */
let _client: S3Client | null = null;

export function getR2Client(): S3Client {
  if (!_client) {
    _client = new S3Client({
      region: "auto",
      endpoint: `https://${requireEnv("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
        secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
      },
    });
  }
  return _client;
}

export function getR2Bucket(): string {
  return requireEnv("R2_BUCKET");
}

export { isR2Configured } from "@/lib/env";
