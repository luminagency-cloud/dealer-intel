import { redirect } from "next/navigation";
import Link from "next/link";
import { auth, signOut } from "@/auth";
import {
  getAllRunGroups,
  getUserRunGroups,
  listAllSnapshots,
  listVisibleSnapshots,
} from "@/lib/db/repository";

export const dynamic = "force-dynamic";

function formatDate(date: Date | null) {
  return date ? date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";
}

async function logout() {
  "use server";
  await signOut({ redirectTo: "/login" });
}

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const isAdmin = session.user.role === "admin";

  const groups = isAdmin
    ? await getAllRunGroups()
    : await getUserRunGroups(session.user.id);

  const groupIds = groups.map((g) => g.id);
  const snapshots = isAdmin
    ? await listAllSnapshots()
    : await listVisibleSnapshots(groupIds);

  // Group snapshots by run group
  const snapshotsByGroup = new Map<string, typeof snapshots>();
  for (const snap of snapshots) {
    if (!snap.runGroupId) continue;
    const arr = snapshotsByGroup.get(snap.runGroupId) ?? [];
    arr.push(snap);
    snapshotsByGroup.set(snap.runGroupId, arr);
  }

  return (
    <div className="min-h-screen bg-zinc-50">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
          <span className="text-sm font-semibold text-zinc-900">Dealer Intel</span>
          <div className="flex items-center gap-4">
            {isAdmin && (
              <span className="rounded-full bg-zinc-900 px-2 py-0.5 text-xs font-medium text-white">
                admin
              </span>
            )}
            <span className="text-sm text-zinc-500">{session.user.email}</span>
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

      <main className="mx-auto max-w-5xl px-4 py-8">
        <h1 className="mb-6 text-xl font-semibold text-zinc-900">Reports</h1>

        {groups.length === 0 ? (
          <p className="rounded-lg border border-dashed border-zinc-300 bg-white p-8 text-center text-sm text-zinc-500">
            No reports available yet.
          </p>
        ) : (
          <div className="space-y-6">
            {groups.map((group) => {
              const snaps = snapshotsByGroup.get(group.id) ?? [];
              return (
                <div
                  key={group.id}
                  className="overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm"
                >
                  <div className="border-b border-zinc-100 bg-zinc-50 px-4 py-3">
                    <h2 className="text-sm font-semibold text-zinc-900">
                      {group.name}
                    </h2>
                  </div>
                  {snaps.length === 0 ? (
                    <p className="px-4 py-4 text-sm text-zinc-500">
                      No reports published yet.
                    </p>
                  ) : (
                    <ul className="divide-y divide-zinc-100">
                      {snaps.map((snap, i) => (
                        <li key={snap.id}>
                          <Link
                            href={`/reports/${snap.id}`}
                            className="flex items-center justify-between px-4 py-3 hover:bg-zinc-50"
                          >
                            <div>
                              <span className="text-sm font-medium text-zinc-900">
                                {snap.label || formatDate(snap.approvedAt)}
                              </span>
                              {i === 0 && (
                                <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
                                  Latest
                                </span>
                              )}
                            </div>
                            <span className="text-xs text-zinc-500">
                              {snap.offerCount} offers · {snap.siteCount} sites ·{" "}
                              {formatDate(snap.approvedAt)}
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
