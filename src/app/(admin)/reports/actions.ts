"use server";

import { revalidatePath } from "next/cache";
import { touchSnapshotApprovedAt } from "@/lib/db/repository";
import { requireSession } from "@/lib/session";

export async function rebuildReport(snapshotId: string) {
  await requireSession();
  await touchSnapshotApprovedAt(snapshotId);
  revalidatePath("/reports", "layout");
  revalidatePath("/");
}
