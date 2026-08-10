import { NextResponse } from "next/server";
import {
  ChromeCollectorError,
  startChromeItem,
  startChromeRun,
} from "@/lib/chrome-collector";
import { requireApiSession } from "@/lib/session";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { response } = await requireApiSession();
  if (response) return response;

  try {
    const { id } = await params;
    // Optional body scopes the job to one dealer+mission (row-level re-collect).
    const only = (await request.json().catch(() => null)) as {
      siteId?: string;
      missionId?: string;
    } | null;
    return NextResponse.json(
      only?.siteId && only?.missionId
        ? await startChromeItem(id, only.siteId, only.missionId)
        : await startChromeRun(id)
    );
  } catch (error) {
    const status = error instanceof ChromeCollectorError ? error.status : 500;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Chrome start failed" },
      { status }
    );
  }
}
