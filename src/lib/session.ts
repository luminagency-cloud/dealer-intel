import { redirect } from "next/navigation";
import { auth } from "@/auth";

/** Server-side guard for admin pages and server actions. */
export async function requireSession() {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }
  return session;
}
