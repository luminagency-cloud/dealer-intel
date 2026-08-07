import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/session";
import { getChromeInventoryJob } from "@/lib/inventory-batch";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ batchId: string }> }
) {
  const { response } = await requireApiSession();
  if (response) return response;

  try {
    const { batchId } = await params;
    return NextResponse.json(await getChromeInventoryJob(batchId), {
      headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Chrome inventory job failed" },
      { status: 409 }
    );
  }
}
