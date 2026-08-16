import { redirect, notFound } from "next/navigation";
import { getEvidenceForPublicSnapshotOffer } from "@/lib/db/repository";
import { getEvidenceDownloadUrl } from "@/lib/evidence";

export const dynamic = "force-dynamic";

/** Report evidence retrieval, scoped by a valid share token and snapshot-offer
 *  id, then redirected to a short-lived private R2 URL. Mirrors the main
 *  app's `/api/report-evidence/[token]/[offerId]/file` route exactly — same
 *  bucket, same access-control shape, just served from this app since it's
 *  the one with a public URL for offer report pages to link to. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string; offerId: string }> }
) {
  const { token, offerId } = await params;
  const row = await getEvidenceForPublicSnapshotOffer(token, offerId);
  if (!row) notFound();
  redirect(await getEvidenceDownloadUrl(row));
}
