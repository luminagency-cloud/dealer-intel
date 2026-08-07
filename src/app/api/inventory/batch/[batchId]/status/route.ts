import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/session";
import { getInventoryBatchStatus } from "@/lib/inventory-batch";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ batchId: string }> }
) {
  const { response } = await requireApiSession();
  if (response) return response;

  const { batchId } = await params;
  const status = await getInventoryBatchStatus(batchId);
  return NextResponse.json(status, {
    headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
  });
}
