"use server";

import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/session";
import { getDb, users } from "@/lib/db";
import { updateUserEmail, updateUserPassword } from "@/lib/db/repository";

export async function changeEmail(_prev: unknown, formData: FormData) {
  const session = await requireSession();
  const newEmail = (formData.get("email") as string).trim().toLowerCase();
  if (!newEmail) return { error: "Email is required." };

  const [existing] = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, newEmail));
  if (existing && existing.id !== session.user.id) {
    return { error: "That email is already in use." };
  }

  await updateUserEmail(session.user.id, newEmail);
  revalidatePath("/account");
  return { success: "Email updated. Sign out and back in for the change to take effect." };
}

export async function changePassword(_prev: unknown, formData: FormData) {
  const session = await requireSession();
  const current = formData.get("current") as string;
  const next = formData.get("password") as string;
  const confirm = formData.get("confirm") as string;

  if (!current || !next || !confirm) return { error: "All fields are required." };
  if (next !== confirm) return { error: "New passwords do not match." };
  if (next.length < 8) return { error: "Password must be at least 8 characters." };

  const [user] = await getDb()
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, session.user.id));
  if (!user) return { error: "User not found." };

  const ok = await bcrypt.compare(current, user.passwordHash);
  if (!ok) return { error: "Current password is incorrect." };

  const passwordHash = await bcrypt.hash(next, 12);
  await updateUserPassword(session.user.id, passwordHash);
  revalidatePath("/account");
  return { success: "Password updated." };
}
