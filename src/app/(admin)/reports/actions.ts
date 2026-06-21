"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { touchSnapshotApprovedAt, deleteReportSnapshot } from "@/lib/db/repository";
import { requireSession } from "@/lib/session";

export async function rebuildReport(snapshotId: string) {
  await requireSession();
  await touchSnapshotApprovedAt(snapshotId);
  revalidatePath("/reports", "layout");
  revalidatePath("/");
}

export async function deleteReport(snapshotId: string) {
  await requireSession();
  await deleteReportSnapshot(snapshotId);
  revalidatePath("/reports", "layout");
  revalidatePath("/snapshots");
  revalidatePath("/");
  redirect("/reports");
}
