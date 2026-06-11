import { redirect } from "next/navigation";
import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { getEvidence } from "@/lib/db/repository";
import { getEvidenceDownloadUrl } from "@/lib/evidence";

/** Auth-guarded evidence retrieval: resolves the evidence row and redirects
 *  to a short-lived presigned R2 URL. The bucket itself stays private. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return new Response("Unauthorized", { status: 401 });
  }
  const { id } = await params;
  const row = await getEvidence(id);
  if (!row) notFound();
  redirect(await getEvidenceDownloadUrl(row));
}
