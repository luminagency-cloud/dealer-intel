import { S3Client } from "@aws-sdk/client-s3";

/**
 * Cloudflare R2 client (S3-compatible), same bucket admin's collector/analysis
 * write evidence into — viewer only ever reads. Needs the same `R2_*`
 * credentials as the main app's `.env`, added to this app's own environment
 * (Vercel project settings, or a local `.env` for dev).
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

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
