"use client";

import { useRouter } from "next/navigation";

export function InventoryGroupPicker({
  groups,
  selectedGroupId,
}: {
  groups: { id: string; name: string }[];
  selectedGroupId?: string;
}) {
  const router = useRouter();

  return (
    <select
      value={selectedGroupId ?? ""}
      onChange={(e) => {
        const val = e.target.value;
        router.push(val ? `/inventory?group=${val}` : "/inventory");
      }}
      className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-700 shadow-sm focus:outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200"
    >
      <option value="">All active dealers</option>
      {groups.map((g) => (
        <option key={g.id} value={g.id}>
          {g.name}
        </option>
      ))}
    </select>
  );
}
