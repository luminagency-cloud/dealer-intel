"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, missions, missionTypeEnum } from "@/lib/db";
import { requireSession } from "@/lib/session";

const missionSchema = z.object({
  siteId: z.uuid("Select a site"),
  missionType: z.enum(missionTypeEnum.enumValues, "Select a mission type"),
  lastKnownUrl: z
    .union([z.url("Last known URL must be a valid URL"), z.literal("")])
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
        .max(5, "At most 5 additional URLs per mission")
    ),
});

function parseMissionForm(formData: FormData) {
  return missionSchema.safeParse({
    siteId: formData.get("siteId"),
    missionType: formData.get("missionType"),
    lastKnownUrl: formData.get("lastKnownUrl") ?? "",
    alternateUrls: formData.get("alternateUrls") ?? "",
  });
}

export async function createMission(formData: FormData) {
  await requireSession();
  const parsed = parseMissionForm(formData);
  if (!parsed.success) {
    redirect(
      `/missions/new?error=${encodeURIComponent(parsed.error.issues[0].message)}`
    );
  }
  await getDb().insert(missions).values(parsed.data);
  revalidatePath("/missions");
  redirect("/missions");
}

export async function updateMission(id: string, formData: FormData) {
  await requireSession();
  const parsed = parseMissionForm(formData);
  if (!parsed.success) {
    redirect(
      `/missions/${id}/edit?error=${encodeURIComponent(parsed.error.issues[0].message)}`
    );
  }
  await getDb()
    .update(missions)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(missions.id, id));
  revalidatePath("/missions");
  redirect("/missions");
}

export async function setMissionActive(id: string, active: boolean) {
  await requireSession();
  await getDb()
    .update(missions)
    .set({ active, updatedAt: new Date() })
    .where(eq(missions.id, id));
  revalidatePath("/missions");
}
