import Link from "next/link";
import { signOut } from "@/auth";
import { requireSession } from "@/lib/session";

async function logout() {
  "use server";
  await signOut({ redirectTo: "/login" });
}

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireSession();

  return (
    <div className="min-h-screen bg-zinc-50">
      <header className="border-b border-zinc-200 bg-white">
        <div className="app-shell flex h-14 items-center justify-between px-4">
          <div className="flex items-center gap-8">
            <Link href="/sites" className="text-sm font-semibold text-zinc-900">
              Dealer Intel
            </Link>
            <nav className="flex items-center gap-4 text-sm text-zinc-600">
              <Link href="/sites" className="hover:text-zinc-900">
                Sites
              </Link>
              <Link href="/missions" className="hover:text-zinc-900">
                Missions
              </Link>
              <Link href="/groups" className="hover:text-zinc-900">
                Run Groups
              </Link>
              <Link href="/runs" className="hover:text-zinc-900">
                Runs
              </Link>
              <Link href="/review" className="hover:text-zinc-900">
                Review
              </Link>
            </nav>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm text-zinc-500">
              {session.user?.email}
            </span>
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
      <main className="app-shell px-4 py-8">{children}</main>
    </div>
  );
}
