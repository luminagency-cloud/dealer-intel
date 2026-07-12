import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getInventoryBatchStatus } from "@/lib/inventory-batch";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ batchId: string }> }
) {
  const session = await getSession();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { batchId } = await params;
  const status = await getInventoryBatchStatus(batchId);
  return NextResponse.json(status, {
    headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
  });
}
