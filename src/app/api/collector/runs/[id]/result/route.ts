import { NextResponse } from "next/server";
import {
  ChromeCollectorError,
  completeChromeItem,
  failChromeItem,
  uploadChromeCaptureState,
  type ChromeCaptureStateKind,
} from "@/lib/chrome-collector";
import { getSession } from "@/lib/session";

function requiredString(formData: FormData, name: string): string {
  const value = formData.get(name);
  if (typeof value !== "string" || !value.trim()) {
    throw new ChromeCollectorError(`${name} is required`);
  }
  return value.trim();
}

function requiredInteger(formData: FormData, name: string): number {
  const raw = requiredString(formData, name);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new ChromeCollectorError(`${name} must be a non-negative integer`);
  }
  return value;
}

const CAPTURE_STATE_KINDS = new Set<ChromeCaptureStateKind>([
  "base",
  "carousel",
  "tab",
  "disclaimer",
  "failure",
]);

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
    const action = requiredString(formData, "action");
    const captureError = formData.get("error");

    if (action === "failure") {
      if (typeof captureError !== "string" || !captureError.trim()) {
        throw new ChromeCollectorError("error is required for a failed capture");
      }
      await failChromeItem({
        runId,
        siteId,
        missionId,
        error: captureError.trim(),
      });
      return NextResponse.json({ ok: false, error: captureError.trim() });
    }

    if (action === "complete") {
      await completeChromeItem({
        runId,
        siteId,
        missionId,
        finalUrl: requiredString(formData, "finalUrl"),
        stateCount: requiredInteger(formData, "stateCount"),
      });
      return NextResponse.json({ ok: true });
    }

    if (action === "state") {
      const stateKind = requiredString(formData, "stateKind");
      if (!CAPTURE_STATE_KINDS.has(stateKind as ChromeCaptureStateKind)) {
        throw new ChromeCollectorError(`Unsupported capture state: ${stateKind}`);
      }
      const screenshot = formData.get("screenshot");
      if (!(screenshot instanceof File) || screenshot.size === 0) {
        throw new ChromeCollectorError("screenshot is required");
      }
      const textContent = formData.get("textContent");
      await uploadChromeCaptureState({
        runId,
        siteId,
        missionId,
        stateId: requiredString(formData, "stateId"),
        stateKind: stateKind as ChromeCaptureStateKind,
        stateOrder: requiredInteger(formData, "stateOrder"),
        finalUrl: requiredString(formData, "finalUrl"),
        pageTitle: requiredString(formData, "pageTitle"),
        label: requiredString(formData, "label"),
        html: requiredString(formData, "html"),
        screenshot: new Uint8Array(await screenshot.arrayBuffer()),
        textContent:
          typeof textContent === "string" && textContent.trim()
            ? textContent.trim()
            : undefined,
      });
      return NextResponse.json({ ok: true });
    }

    throw new ChromeCollectorError(`Unsupported result action: ${action}`);
  } catch (error) {
    const status = error instanceof ChromeCollectorError ? error.status : 500;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Chrome result failed" },
      { status }
    );
  }
}
