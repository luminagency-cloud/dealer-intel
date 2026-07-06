import Link from "next/link";
import packageJson from "../../../package.json";
import { signOut } from "@/auth";
import { requireSession } from "@/lib/session";
import { SettingsDropdown } from "@/components/settings-dropdown";
import { and, eq, inArray, ne } from "drizzle-orm";
import { getDb, collectionRuns, missionResults } from "@/lib/db";

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

  const reviewItems = await getDb()
    .select({ id: missionResults.id })
    .from(missionResults)
    .innerJoin(collectionRuns, eq(missionResults.collectionRunId, collectionRuns.id))
    .where(
      and(
        inArray(missionResults.status, ["needs_review", "failure", "not_found"]),
        ne(collectionRuns.status, "complete"),
      )
    )
    .limit(1);
  const hasReviewItems = reviewItems.length > 0;

  return (
    <div className="min-h-screen bg-zinc-50">
      <header className="border-b border-zinc-200 bg-white">
        <div className="app-shell flex h-14 items-center justify-between px-4">
          <div className="flex items-center gap-8">
            <Link href="/" className="text-sm font-semibold text-zinc-900">
              Dealer Intel <span className="font-normal text-zinc-600">v{packageJson.version}</span>
            </Link>
            <nav className="flex items-center gap-4 text-sm text-zinc-600">
              <Link href="/runs" className="hover:text-zinc-900">
                Runs
              </Link>
              <Link href="/review" className="relative hover:text-zinc-900">
                Review
                {hasReviewItems && (
                  <span className="absolute -right-2 -top-1 h-2 w-2 rounded-full bg-red-500" />
                )}
              </Link>
              <Link href="/snapshots" className="hover:text-zinc-900">
                Snapshots
              </Link>
              <Link href="/inventory" className="hover:text-zinc-900">
                Inventory
              </Link>
              <Link href="/reports" className="hover:text-zinc-900">
                Reports
              </Link>
              <SettingsDropdown />
            </nav>
          </div>
          <div className="flex items-center gap-4">
            <Link href="/account" className="text-sm text-zinc-700 hover:text-zinc-900">
              {session.user?.email}
            </Link>
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
