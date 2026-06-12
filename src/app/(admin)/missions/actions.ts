"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, missions, missionTypeEnum } from "@/lib/db";
import { deleteMissionDeep } from "@/lib/deep-delete";
import { requireSession } from "@/lib/session";

const missionSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  missionType: z.enum(missionTypeEnum.enumValues, "Select a mission type"),
});

function parseMissionForm(formData: FormData) {
  return missionSchema.safeParse({
    name: formData.get("name"),
    missionType: formData.get("missionType"),
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

export async function deleteMission(id: string) {
  await requireSession();
  await deleteMissionDeep(id);
  revalidatePath("/missions");
}
