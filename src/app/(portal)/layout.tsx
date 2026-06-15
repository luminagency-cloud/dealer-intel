import Link from "next/link";
import { redirect } from "next/navigation";
import { signOut } from "@/auth";
import { auth } from "@/auth";

async function logout() {
  "use server";
  await signOut({ redirectTo: "/login" });
}

export default async function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  return (
    <div className="min-h-screen bg-zinc-50">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto max-w-4xl flex h-14 items-center justify-between px-4">
          <Link href="/portal" className="text-sm font-semibold text-zinc-900">
            Dealer Intel
          </Link>
          <div className="flex items-center gap-4">
            <span className="text-sm text-zinc-500">{session.user?.email}</span>
            <form action={logout}>
              <button
                type="submit"
                className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-4 py-8">{children}</main>
    </div>
  );
}
