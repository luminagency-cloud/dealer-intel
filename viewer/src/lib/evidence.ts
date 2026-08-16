import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getR2Bucket, getR2Client } from "@/lib/r2";
import type { Evidence } from "@/lib/db";

/** Viewer only ever resolves an evidence row to a short-lived download link —
 *  it never uploads or deletes (that's collection/analysis's job in the main
 *  app). Mirrors `getEvidenceDownloadUrl` in the main app's `src/lib/evidence.ts`. */
const PRESIGNED_URL_TTL_SECONDS = 60 * 15;

export async function getEvidenceDownloadUrl(row: Evidence): Promise<string> {
  const key = row.htmlUrl ?? row.screenshotUrl;
  if (!key) {
    throw new Error(`Evidence ${row.id} has no stored object`);
  }
  return getSignedUrl(
    getR2Client(),
    new GetObjectCommand({ Bucket: getR2Bucket(), Key: key }),
    { expiresIn: PRESIGNED_URL_TTL_SECONDS }
  );
}
