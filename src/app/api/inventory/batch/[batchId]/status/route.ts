import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getInventoryBatchStatus } from "@/lib/inventory-batch";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ batchId: string }> }
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { batchId } = await params;
  const status = await getInventoryBatchStatus(batchId);
  return NextResponse.json(status, {
    headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
  });
}
