"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/session";
import { pullAndStoreNews } from "@/lib/news";

export async function refreshNews() {
  await requireSession();
  await pullAndStoreNews();
  revalidatePath("/reports", "layout");
  revalidatePath("/");
}
