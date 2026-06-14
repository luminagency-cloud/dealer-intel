"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { deleteReportSnapshot, setSnapshotClientVisible } from "@/lib/db/repository";
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
  revalidatePath("/snapshots");
}
