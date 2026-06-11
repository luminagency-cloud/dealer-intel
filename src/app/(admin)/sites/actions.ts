"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, sites } from "@/lib/db";
import { requireSession } from "@/lib/session";

const siteSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  url: z.url("Must be a valid URL, including https://"),
  platform: z
    .string()
    .trim()
    .transform((v) => (v === "" ? null : v))
    .nullable(),
});

function parseSiteForm(formData: FormData) {
  return siteSchema.safeParse({
    name: formData.get("name"),
    url: formData.get("url"),
    platform: formData.get("platform") ?? "",
  });
}

export async function createSite(formData: FormData) {
  await requireSession();
  const parsed = parseSiteForm(formData);
  if (!parsed.success) {
    redirect(
      `/sites/new?error=${encodeURIComponent(parsed.error.issues[0].message)}`
    );
  }
  await getDb().insert(sites).values(parsed.data);
  revalidatePath("/sites");
  redirect("/sites");
}

export async function updateSite(id: string, formData: FormData) {
  await requireSession();
  const parsed = parseSiteForm(formData);
  if (!parsed.success) {
    redirect(
      `/sites/${id}/edit?error=${encodeURIComponent(parsed.error.issues[0].message)}`
    );
  }
  await getDb()
    .update(sites)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(sites.id, id));
  revalidatePath("/sites");
  redirect("/sites");
}

export async function setSiteActive(id: string, active: boolean) {
  await requireSession();
  await getDb()
    .update(sites)
    .set({ active, updatedAt: new Date() })
    .where(eq(sites.id, id));
  revalidatePath("/sites");
}
