import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import {
  completeChromeInventoryItem,
  failChromeInventoryItem,
  markChromeInventoryItemRunning,
} from "@/lib/inventory-batch";
import type { ChromeInventoryResult } from "@/lib/inventory";

type InventoryResultBody =
  | { action: "running"; siteId: string }
  | { action: "complete"; siteId: string; result: ChromeInventoryResult }
  | { action: "failure"; siteId: string; error: { message: string; code: string } };

function validSiteId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ batchId: string }> }
) {
  const session = await getSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { batchId } = await params;
    const body = (await request.json()) as InventoryResultBody;
    if (!validSiteId(body.siteId)) throw new Error("A valid siteId is required");

    if (body.action === "running") {
      await markChromeInventoryItemRunning(batchId, body.siteId);
    } else if (body.action === "complete") {
      if (!body.result?.sourceUrl || !body.result?.totals || !Array.isArray(body.result.models)) {
        throw new Error("Chrome inventory result is incomplete");
      }
      await completeChromeInventoryItem(batchId, body.siteId, body.result);
    } else if (body.action === "failure") {
      await failChromeInventoryItem(batchId, body.siteId, {
        message: body.error?.message || "Visible Chrome inventory collection failed",
        code: body.error?.code || "chrome_inventory_failed",
      });
    } else {
      throw new Error("Unsupported inventory result action");
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Chrome inventory result failed" },
      { status: 400 }
    );
  }
}
