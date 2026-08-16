import { NextResponse } from "next/server";
import { pauseChromeRun } from "@/lib/chrome-collector";
import { requireApiSession } from "@/lib/session";

/** The driving tab calls this between work items when the operator clicks
 *  Pause — see `ChromeCollectorControl`. Never mid-item: the tab finishes
 *  whatever mission it already opened, then stops before starting the next. */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { response } = await requireApiSession();
  if (response) return response;
  const { id } = await params;
  await pauseChromeRun(id);
  return NextResponse.json({ ok: true });
}
