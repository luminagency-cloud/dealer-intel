import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getChromeInventoryJob } from "@/lib/inventory-batch";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ batchId: string }> }
) {
  const session = await getSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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
