"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { deleteReportSnapshot } from "@/lib/db/repository";
import { requireSession } from "@/lib/session";

export async function deleteSnapshot(snapshotId: string) {
  await requireSession();
  await deleteReportSnapshot(snapshotId);
  revalidatePath("/snapshots");
  redirect("/snapshots");
}
