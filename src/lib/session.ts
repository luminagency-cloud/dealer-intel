import { redirect } from "next/navigation";
import { auth } from "@/auth";

/** Guard for any authenticated page (admin or dealer). */
export async function requireSession() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  return session;
}

/** Guard for operator-only pages and server actions. */
export async function requireAdminSession() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (session.user.role !== "admin") redirect("/");
  return session;
}
