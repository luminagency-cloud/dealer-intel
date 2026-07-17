import { redirect, notFound } from "next/navigation";
import { getEvidenceForPublicSnapshotOffer } from "@/lib/db/repository";
import { getEvidenceDownloadUrl } from "@/lib/evidence";

export const dynamic = "force-dynamic";

/** Public report evidence retrieval. Access is scoped by a valid share token
 * and snapshot-offer id, then redirected to a short-lived private R2 URL. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string; offerId: string }> }
) {
  const { token, offerId } = await params;
  const row = await getEvidenceForPublicSnapshotOffer(token, offerId);
  if (!row) notFound();
  redirect(await getEvidenceDownloadUrl(row));
}