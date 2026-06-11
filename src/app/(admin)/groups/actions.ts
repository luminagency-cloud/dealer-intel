"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb, runGroupMembers, runGroups } from "@/lib/db";
import { requireSession } from "@/lib/session";

interface ParsedGroupForm {
  name: string;
  members: { siteId: string; isPrimary: boolean }[];
}

function parseGroupForm(formData: FormData): ParsedGroupForm | string {
  const name = formData.get("name");
  if (typeof name !== "string" || !name.trim()) {
    return "Group name is required";
  }
  const memberIds = formData.getAll("memberSiteIds").filter(
    (v): v is string => typeof v === "string" && v.length > 0
  );
  if (memberIds.length === 0) {
    return "Pick at least one site";
  }
  const primaryIds = new Set(
    formData.getAll("primarySiteIds").filter(
      (v): v is string => typeof v === "string"
    )
  );
  return {
    name: name.trim(),
    members: memberIds.map((siteId) => ({
      siteId,
      // Primary checkboxes only count for sites that are members.
      isPrimary: primaryIds.has(siteId),
    })),
  };
}

export async function createRunGroup(formData: FormData) {
  await requireSession();
  const parsed = parseGroupForm(formData);
  if (typeof parsed === "string") {
    redirect(`/groups/new?error=${encodeURIComponent(parsed)}`);
  }

  const db = getDb();
  const [group] = await db
    .insert(runGroups)
    .values({ name: parsed.name })
    .returning();
  await db.insert(runGroupMembers).values(
    parsed.members.map((m) => ({ ...m, runGroupId: group.id }))
  );
  revalidatePath("/groups");
  redirect("/groups");
}

export async function updateRunGroup(id: string, formData: FormData) {
  await requireSession();
  const parsed = parseGroupForm(formData);
  if (typeof parsed === "string") {
    redirect(`/groups/${id}/edit?error=${encodeURIComponent(parsed)}`);
  }

  const db = getDb();
  await db
    .update(runGroups)
    .set({ name: parsed.name, updatedAt: new Date() })
    .where(eq(runGroups.id, id));
  // Replace membership wholesale — groups are small.
  await db.delete(runGroupMembers).where(eq(runGroupMembers.runGroupId, id));
  await db.insert(runGroupMembers).values(
    parsed.members.map((m) => ({ ...m, runGroupId: id }))
  );
  revalidatePath("/groups");
  redirect("/groups");
}

export async function deleteRunGroup(id: string) {
  await requireSession();
  // Members cascade; runs that referenced the group keep running ungrouped
  // (run_group_id is set null).
  await getDb().delete(runGroups).where(eq(runGroups.id, id));
  revalidatePath("/groups");
}
