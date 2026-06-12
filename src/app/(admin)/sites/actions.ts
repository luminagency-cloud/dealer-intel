"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, siteMissions, sites } from "@/lib/db";
import { deleteSiteDeep } from "@/lib/deep-delete";
import { requireSession } from "@/lib/session";

const siteSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  url: z.url("Must be a valid URL, including https://"),
  platform: z
    .string()
    .trim()
    .transform((v) => (v === "" ? null : v))
    .nullable(),
  brand: z
    .string()
    .trim()
    .transform((v) => (v === "" ? null : v))
    .nullable(),
  state: z
    .string()
    .trim()
    .toUpperCase()
    .transform((v) => (v === "" ? null : v))
    .nullable(),
});

function parseSiteForm(formData: FormData) {
  return siteSchema.safeParse({
    name: formData.get("name"),
    url: formData.get("url"),
    platform: formData.get("platform") ?? "",
    brand: formData.get("brand") ?? "",
    state: formData.get("state") ?? "",
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

export async function deleteSite(id: string) {
  await requireSession();
  await deleteSiteDeep(id);
  revalidatePath("/sites");
}

const siteMissionSchema = z.object({
  lastKnownUrl: z
    .union([z.url("URL must be valid, including https://"), z.literal("")])
    .transform((v) => (v === "" ? null : v)),
  alternateUrls: z
    .string()
    .transform((v) =>
      v
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    )
    .pipe(
      z
        .array(z.url("Each additional URL must be a valid URL"))
        .max(5, "At most 5 additional URLs")
    ),
  active: z.boolean(),
});

/** Saves a dealer's URL config for one global mission (site edit page). */
export async function saveSiteMission(
  siteId: string,
  missionId: string,
  formData: FormData
) {
  await requireSession();
  const parsed = siteMissionSchema.safeParse({
    lastKnownUrl: formData.get("lastKnownUrl") ?? "",
    alternateUrls: formData.get("alternateUrls") ?? "",
    active: formData.get("active") === "on",
  });
  if (!parsed.success) {
    redirect(
      `/sites/${siteId}/edit?error=${encodeURIComponent(parsed.error.issues[0].message)}`
    );
  }
  await getDb()
    .insert(siteMissions)
    .values({ siteId, missionId, ...parsed.data })
    .onConflictDoUpdate({
      target: [siteMissions.siteId, siteMissions.missionId],
      set: { ...parsed.data, updatedAt: new Date() },
    });
  revalidatePath(`/sites/${siteId}/edit`);
}

export async function setSiteActive(id: string, active: boolean) {
  await requireSession();
  await getDb()
    .update(sites)
    .set({ active, updatedAt: new Date() })
    .where(eq(sites.id, id));
  revalidatePath("/sites");
}
