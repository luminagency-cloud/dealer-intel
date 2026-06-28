import { asc } from "drizzle-orm";
import { getDb, runGroups } from "@/lib/db";
import { listUsers, listUserRunGroups } from "@/lib/db/repository";
import { requireAdminSession } from "@/lib/session";
import { ConfirmSubmitButton } from "@/components/confirm-submit-button";
import {
  createDealerUser,
  removeUser,
  resetUserPassword,
  updateUserGroups,
} from "./actions";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  await requireAdminSession();

  const [userList, allGroups] = await Promise.all([
    listUsers(),
    getDb().select().from(runGroups).orderBy(asc(runGroups.name)),
  ]);

  const userGroups = Object.fromEntries(
    await Promise.all(
      userList.map(async (u) => [u.id, await listUserRunGroups(u.id)])
    )
  );

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-zinc-900">Users</h1>
      </div>

      {/* Create dealer user */}
      <div className="mb-8 rounded-lg border border-zinc-200 bg-white shadow-sm">
        <div className="border-b border-zinc-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-zinc-900">
            Add Dealer User
          </h2>
        </div>
        <form action={createDealerUser} className="space-y-3 px-4 py-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-700">
                Name
              </label>
              <input
                type="text"
                name="name"
                placeholder="Dealer contact name"
                className="w-full rounded-md border border-zinc-300 px-3 py-1.5 text-sm focus:border-zinc-400 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-700">
                Email *
              </label>
              <input
                type="email"
                name="email"
                required
                placeholder="dealer@example.com"
                className="w-full rounded-md border border-zinc-300 px-3 py-1.5 text-sm focus:border-zinc-400 focus:outline-none"
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-700">
              Password *
            </label>
            <input
              type="password"
              name="password"
              required
              minLength={8}
              placeholder="Minimum 8 characters"
              className="w-full rounded-md border border-zinc-300 px-3 py-1.5 text-sm focus:border-zinc-400 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-700">
              Run Groups
            </label>
            <div className="flex flex-wrap gap-2">
              {allGroups.map((g) => (
                <label
                  key={g.id}
                  className="flex cursor-pointer items-center gap-1.5 rounded-md border border-zinc-200 px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-50"
                >
                  <input
                    type="checkbox"
                    name="runGroupIds"
                    value={g.id}
                    className="h-3.5 w-3.5 rounded"
                  />
                  {g.name}
                </label>
              ))}
            </div>
          </div>
          <div className="flex justify-end pt-1">
            <button
              type="submit"
              className="rounded-md bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-zinc-700"
            >
              Create User
            </button>
          </div>
        </form>
      </div>

      {/* User list */}
      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm">
        {userList.length === 0 ? (
          <p className="px-4 py-6 text-sm text-zinc-700">No users yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-100 text-left">
                <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-zinc-700">
                  User
                </th>
                <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-zinc-700">
                  Role
                </th>
                <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-zinc-700">
                  Run Groups
                </th>
                <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-zinc-700">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {userList.map((user) => {
                const groups = userGroups[user.id] ?? [];
                return (
                  <tr key={user.id} className="align-top">
                    <td className="px-4 py-3">
                      <div className="font-medium text-zinc-900">
                        {user.name || "—"}
                      </div>
                      <div className="text-xs text-zinc-700">{user.email}</div>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={
                          user.role === "admin"
                            ? "rounded-full bg-zinc-900 px-2 py-0.5 text-xs font-medium text-white"
                            : "rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800"
                        }
                      >
                        {user.role}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {user.role === "admin" ? (
                        <span className="text-xs text-zinc-700">
                          All groups
                        </span>
                      ) : (
                        <form
                          action={updateUserGroups.bind(null, user.id)}
                          className="flex flex-wrap gap-1.5"
                        >
                          {allGroups.map((g) => (
                            <label
                              key={g.id}
                              className="flex cursor-pointer items-center gap-1 rounded border border-zinc-200 px-2 py-0.5 text-xs text-zinc-700 hover:bg-zinc-50"
                            >
                              <input
                                type="checkbox"
                                name="runGroupIds"
                                value={g.id}
                                defaultChecked={groups.some(
                                  (ug: { runGroupId: string }) => ug.runGroupId === g.id
                                )}
                                className="h-3 w-3 rounded"
                              />
                              {g.name}
                            </label>
                          ))}
                          <button
                            type="submit"
                            className="ml-1 rounded bg-zinc-100 px-2 py-0.5 text-xs text-zinc-700 hover:bg-zinc-200"
                          >
                            Save
                          </button>
                        </form>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {user.role !== "admin" && (
                          <form action={resetUserPassword.bind(null, user.id)}>
                            <input
                              type="password"
                              name="password"
                              required
                              minLength={8}
                              placeholder="New password"
                              className="rounded border border-zinc-200 px-2 py-0.5 text-xs focus:outline-none"
                            />
                            <button
                              type="submit"
                              className="ml-1 rounded border border-zinc-300 px-2 py-0.5 text-xs text-zinc-600 hover:bg-zinc-50"
                            >
                              Reset
                            </button>
                          </form>
                        )}
                        {user.role !== "admin" && (
                          <form action={removeUser.bind(null, user.id)}>
                            <ConfirmSubmitButton
                              confirmMessage={`Delete user ${user.email}? They will lose all report access immediately.`}
                              className="rounded border border-red-200 px-2 py-0.5 text-xs text-red-600 hover:bg-red-50"
                            >
                              Delete
                            </ConfirmSubmitButton>
                          </form>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
