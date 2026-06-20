"use server";

import { revalidatePath } from "next/cache";
import { touchSnapshotApprovedAt } from "@/lib/db/repository";
import { requireAdminSession } from "@/lib/session";

export { refreshNews } from "../actions";

export async function rebuildReport(snapshotId: string) {
  await requireAdminSession();
  await touchSnapshotApprovedAt(snapshotId);
  revalidatePath("/reports", "layout");
  revalidatePath("/");
}
