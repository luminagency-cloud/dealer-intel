"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { deleteMissionResultsDeep } from "@/lib/deep-delete";
import { requireSession } from "@/lib/session";

export async function deleteSelectedResults(formData: FormData) {
  await requireSession();
  const ids = formData
    .getAll("resultIds")
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  if (ids.length === 0) {
    redirect(
      `/review?error=${encodeURIComponent("Select at least one item to delete")}`
    );
  }
  await deleteMissionResultsDeep(ids);
  revalidatePath("/review");
  redirect("/review");
}
