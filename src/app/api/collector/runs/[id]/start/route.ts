import { NextResponse } from "next/server";
import {
  ChromeCollectorError,
  startChromeRun,
} from "@/lib/chrome-collector";
import { requireApiSession } from "@/lib/session";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { response } = await requireApiSession();
  if (response) return response;

  try {
    const { id } = await params;
    return NextResponse.json(await startChromeRun(id));
  } catch (error) {
    const status = error instanceof ChromeCollectorError ? error.status : 500;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Chrome start failed" },
      { status }
    );
  }
}
