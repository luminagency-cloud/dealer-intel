import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import {
  listUserRunGroups,
  listClientSnapshotsForGroups,
} from "@/lib/db/repository";

export const dynamic = "force-dynamic";

function formatDate(date: Date | null) {
  if (!date) return "—";
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export default async function PortalPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  // Admins belong in the admin UI, not the dealer portal.
  if (session.user.role === "admin") redirect("/");

  const userId = session.user.id!;
  const groups = await listUserRunGroups(userId);
  const groupIds = groups.map((g) => g.runGroupId);
  const snapshots =
    groupIds.length > 0 ? await listClientSnapshotsForGroups(groupIds) : [];

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-zinc-900">
          {session.user.name ? `Welcome, ${session.user.name}` : "Your Reports"}
        </h1>
        {groups.length > 0 && (
          <p className="mt-1 text-sm text-zinc-500">
            {groups.map((g) => g.runGroupName).join(" · ")}
          </p>
        )}
        {groups.length === 0 && (
          <p className="mt-1 text-sm text-zinc-500">
            No dealer groups assigned yet. Contact your administrator.
          </p>
        )}
      </div>

      {snapshots.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-300 bg-white px-8 py-14 text-center">
          <p className="text-base font-medium text-zinc-700">
            No reports available yet
          </p>
          <p className="mt-1 text-sm text-zinc-500">
            Reports will appear here once your administrator publishes them.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {snapshots.map((snap) => (
            <Link
              key={snap.id}
              href={`/r/${snap.id}`}
              className="group flex items-center justify-between rounded-xl border border-zinc-200 bg-white p-5 shadow-sm transition hover:border-zinc-300 hover:shadow-md"
            >
              <div>
                <p className="font-semibold text-zinc-900">
                  {snap.label ||
                    `Competitive Market Analysis — ${formatDate(snap.approvedAt)}`}
                </p>
                <p className="mt-0.5 text-sm text-zinc-500">
                  {[
                    snap.runGroupName,
                    `${snap.offerCount} offer${snap.offerCount !== 1 ? "s" : ""}`,
                    `${snap.siteCount} site${snap.siteCount !== 1 ? "s" : ""}`,
                    formatDate(snap.approvedAt),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              <span className="text-sm font-medium text-blue-600 group-hover:underline">
                View report →
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
