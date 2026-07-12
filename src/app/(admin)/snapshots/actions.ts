"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  deleteReportSnapshot,
  ensureShareToken,
  regenerateShareToken,
  setSnapshotClientVisible,
} from "@/lib/db/repository";
import { requireAdminSession } from "@/lib/session";

export async function deleteSnapshot(snapshotId: string) {
  await requireAdminSession();
  await deleteReportSnapshot(snapshotId);
  revalidatePath("/snapshots");
  redirect("/snapshots");
}

export async function toggleClientVisible(id: string, visible: boolean) {
  await requireAdminSession();
  await setSnapshotClientVisible(id, visible);
  // Every released snapshot needs a public share token; mint one on release.
  if (visible) await ensureShareToken(id);
  revalidatePath("/snapshots");
}

/** Rotate a snapshot's share token, invalidating any previously shared link. */
export async function regenerateShareLink(id: string) {
  await requireAdminSession();
  await regenerateShareToken(id);
  revalidatePath("/snapshots");
}
