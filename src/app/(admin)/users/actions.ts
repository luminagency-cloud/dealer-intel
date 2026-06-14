"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import bcrypt from "bcryptjs";
import {
  createUser,
  deleteUser,
  listUserRunGroups,
  setUserRunGroups,
  updateUserPassword,
} from "@/lib/db/repository";
import { requireAdminSession } from "@/lib/session";

export async function createDealerUser(formData: FormData) {
  await requireAdminSession();
  const email = (formData.get("email") as string).trim().toLowerCase();
  const password = formData.get("password") as string;
  const name = ((formData.get("name") as string) || "").trim() || undefined;
  const runGroupIds = formData.getAll("runGroupIds") as string[];

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await createUser({ email, passwordHash, name, role: "dealer" });
  await setUserRunGroups(user.id, runGroupIds);
  revalidatePath("/users");
  redirect("/users");
}

export async function updateUserGroups(userId: string, formData: FormData) {
  await requireAdminSession();
  const runGroupIds = formData.getAll("runGroupIds") as string[];
  await setUserRunGroups(userId, runGroupIds);
  revalidatePath("/users");
}

export async function resetUserPassword(userId: string, formData: FormData) {
  await requireAdminSession();
  const password = formData.get("password") as string;
  const passwordHash = await bcrypt.hash(password, 12);
  await updateUserPassword(userId, passwordHash);
  revalidatePath("/users");
}

export async function removeUser(userId: string) {
  await requireAdminSession();
  await deleteUser(userId);
  revalidatePath("/users");
}
