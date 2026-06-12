import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { getDb, runGroupMembers, runGroups, sites } from "@/lib/db";
import { ConfirmSubmitButton } from "@/components/confirm-submit-button";
import { deleteRunGroup } from "./actions";

export const dynamic = "force-dynamic";

export default async function RunGroupsPage() {
  const db = getDb();
  const [groups, memberRows] = await Promise.all([
    db.select().from(runGroups).orderBy(asc(runGroups.name)),
    db
      .select({
        runGroupId: runGroupMembers.runGroupId,
        isPrimary: runGroupMembers.isPrimary,
        siteName: sites.name,
      })
      .from(runGroupMembers)
      .innerJoin(sites, eq(runGroupMembers.siteId, sites.id)),
  ]);

  const membersByGroup = new Map<
    string,
    { siteName: string; isPrimary: boolean }[]
  >();
  for (const row of memberRows) {
    const list = membersByGroup.get(row.runGroupId) ?? [];
    list.push({ siteName: row.siteName, isPrimary: row.isPrimary });
    membersByGroup.set(row.runGroupId, list);
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-zinc-900">Run Groups</h1>
        <Link
          href="/groups/new"
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700"
        >
          Add Run Group
        </Link>
      </div>

      {groups.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-300 bg-white p-8 text-center text-sm text-zinc-500">
          No run groups yet. A run group is a first-order dealer plus the
          related dealers you want collected together — create one to run a
          subset of your sites.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500">
                <th className="px-4 py-2.5 font-medium">Name</th>
                <th className="px-4 py-2.5 font-medium">Primary</th>
                <th className="px-4 py-2.5 font-medium">Members</th>
                <th className="px-4 py-2.5 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {groups.map((group) => {
                const members = membersByGroup.get(group.id) ?? [];
                const primaries = members.filter((m) => m.isPrimary);
                return (
                  <tr key={group.id}>
                    <td className="px-4 py-3 font-medium text-zinc-900">
                      {group.name}
                    </td>
                    <td className="px-4 py-3 text-zinc-600">
                      {primaries.map((m) => m.siteName).join(", ") || "—"}
                    </td>
                    <td className="px-4 py-3 text-zinc-600">
                      {members.length} site(s)
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <Link
                          href={`/groups/${group.id}/edit`}
                          className="text-zinc-900 underline hover:text-zinc-600"
                        >
                          Edit
                        </Link>
                        <form action={deleteRunGroup.bind(null, group.id)}>
                          <ConfirmSubmitButton
                            confirmMessage={`Delete run group "${group.name}"? This can't be undone.`}
                            className="text-red-700 hover:underline"
                          >
                            Delete
                          </ConfirmSubmitButton>
                        </form>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
