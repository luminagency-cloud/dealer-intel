import { NextResponse } from "next/server";
import {
  ChromeCollectorError,
  completeChromeItem,
  failChromeItem,
} from "@/lib/chrome-collector";
import { getSession } from "@/lib/session";

function requiredString(formData: FormData, name: string): string {
  const value = formData.get(name);
  if (typeof value !== "string" || !value.trim()) {
    throw new ChromeCollectorError(`${name} is required`);
  }
  return value.trim();
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { id: runId } = await params;
    const formData = await request.formData();
    const siteId = requiredString(formData, "siteId");
    const missionId = requiredString(formData, "missionId");
    const captureError = formData.get("error");

    if (typeof captureError === "string" && captureError.trim()) {
      await failChromeItem({
        runId,
        siteId,
        missionId,
        error: captureError.trim(),
      });
      return NextResponse.json({ ok: false, error: captureError.trim() });
    }

    const screenshot = formData.get("screenshot");
    if (!(screenshot instanceof File) || screenshot.size === 0) {
      throw new ChromeCollectorError("screenshot is required");
    }
    await completeChromeItem({
      runId,
      siteId,
      missionId,
      finalUrl: requiredString(formData, "finalUrl"),
      pageTitle: requiredString(formData, "pageTitle"),
      html: requiredString(formData, "html"),
      screenshot: new Uint8Array(await screenshot.arrayBuffer()),
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const status = error instanceof ChromeCollectorError ? error.status : 500;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Chrome result failed" },
      { status }
    );
  }
}
