import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";
import { getR2Bucket, getR2Client } from "@/lib/r2";
import {
  createEvidence,
  deleteEvidence as deleteEvidenceRow,
  getEvidence,
} from "@/lib/db/repository";
import type { Evidence, EvidenceType, MissionType } from "@/lib/db";

/**
 * Evidence upload/retrieval services (Phase 4, AD-005/AD-010). Files live in
 * R2; Postgres rows reference them by object key. Keys — not URLs — are
 * stored in evidence.screenshot_url / html_url so buckets can stay private
 * and access always goes through short-lived presigned URLs.
 */

const PRESIGNED_URL_TTL_SECONDS = 60 * 15;

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  html: "text/html; charset=utf-8",
};

export function isHtmlEvidence(type: EvidenceType): boolean {
  return type === "html_snapshot";
}

function extensionFor(evidenceType: EvidenceType, fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (ext in CONTENT_TYPES) return ext;
  return isHtmlEvidence(evidenceType) ? "html" : "png";
}

export async function uploadEvidence(input: {
  collectionRunId: string;
  siteId: string;
  missionType: MissionType;
  evidenceType: EvidenceType;
  fileName: string;
  body: Buffer | Uint8Array;
  /** Human-readable name for the viewer (page title/URL, slide/tab, or the
   *  disclaimer's ad anchor). See evidence.label. */
  label?: string | null;
  /** Full captured text (e.g. a disclaimer modal's fine print). See
   *  evidence.textContent. */
  textContent?: string | null;
}): Promise<Evidence> {
  const ext = extensionFor(input.evidenceType, input.fileName);
  const key = `runs/${input.collectionRunId}/${input.evidenceType}/${randomUUID()}.${ext}`;

  await getR2Client().send(
    new PutObjectCommand({
      Bucket: getR2Bucket(),
      Key: key,
      Body: input.body,
      ContentType: CONTENT_TYPES[ext],
    })
  );

  return createEvidence({
    collectionRunId: input.collectionRunId,
    siteId: input.siteId,
    missionType: input.missionType,
    evidenceType: input.evidenceType,
    label: input.label?.trim() || null,
    textContent: input.textContent?.trim() || null,
    ...(isHtmlEvidence(input.evidenceType)
      ? { htmlUrl: key }
      : { screenshotUrl: key }),
  });
}

/** Object key for an evidence row, regardless of evidence type. */
export function evidenceKey(row: Evidence): string | null {
  return row.htmlUrl ?? row.screenshotUrl;
}

/** Reads an evidence row's stored object bytes straight from R2. Used by the
 *  Phase 9 analysis passes, which read stored evidence (no presigned round
 *  trip, no site visits). Returns null when the row has no stored object. */
export async function getEvidenceBody(row: Evidence): Promise<Buffer | null> {
  const key = evidenceKey(row);
  if (!key) return null;
  const response = await getR2Client().send(
    new GetObjectCommand({ Bucket: getR2Bucket(), Key: key })
  );
  const bytes = await response.Body?.transformToByteArray();
  return bytes ? Buffer.from(bytes) : null;
}

/** Convenience for HTML-snapshot evidence: the rendered markup as a string. */
export async function getEvidenceText(row: Evidence): Promise<string | null> {
  const body = await getEvidenceBody(row);
  return body ? body.toString("utf-8") : null;
}

/** Direct public URL for an R2 object key, using the configured public domain.
 *  Returns null when R2_PUBLIC_URL is not set (private-only bucket). */
export function getEvidencePublicUrl(key: string): string | null {
  const base = process.env.R2_PUBLIC_URL;
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/${key}`;
}

/** Short-lived presigned GET URL for an evidence row's stored object. */
export async function getEvidenceDownloadUrl(row: Evidence): Promise<string> {
  const key = evidenceKey(row);
  if (!key) {
    throw new Error(`Evidence ${row.id} has no stored object`);
  }
  return getSignedUrl(
    getR2Client(),
    new GetObjectCommand({ Bucket: getR2Bucket(), Key: key }),
    { expiresIn: PRESIGNED_URL_TTL_SECONDS }
  );
}

/** Removes the R2 object (if any) and the database row. */
export async function removeEvidence(id: string): Promise<void> {
  const row = await getEvidence(id);
  if (!row) return;
  const key = evidenceKey(row);
  if (key) {
    await getR2Client().send(
      new DeleteObjectCommand({ Bucket: getR2Bucket(), Key: key })
    );
  }
  await deleteEvidenceRow(id);
}
