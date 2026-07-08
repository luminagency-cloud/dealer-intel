"use client";

import Link from "next/link";
import { useState } from "react";
import type { ReportSnapshot } from "@/lib/db";
import { fmtDateTime } from "@/lib/fmt-date";

function formatDate(date: Date | null) {
  return fmtDateTime(date);
}

/** Phase 10 run-page panel: publish the run's current analysis output as a
 *  frozen reporting snapshot, and list the snapshots already cut from it.
 *
 *  Pass `runGroups` for combined multi-group runs — the panel renders
 *  per-group rows with checkboxes so the operator can publish selected groups. */
export function SnapshotSection({
  snapshots,
  canPublish,
  hasOffers,
  publishAction,
  defaultLabel,
  runGroups,
}: {
  snapshots: ReportSnapshot[];
  canPublish: boolean;
  hasOffers: boolean;
  publishAction: (formData: FormData) => Promise<void>;
  defaultLabel?: string;
  runGroups?: { id: string; name: string }[];
}) {
  const [label, setLabel] = useState(defaultLabel ?? "");
  const isMultiGroup = runGroups && runGroups.length > 1;

  // Default: unpublished groups checked, already-published unchecked.
  const [checked, setChecked] = useState<Record<string, boolean>>(() => {
    if (!runGroups) return {};
    return Object.fromEntries(
      runGroups.map((g) => [
        g.id,
        !snapshots.some((s) => s.runGroupId === g.id),
      ])
    );
  });

  const allChecked =
    (runGroups?.length ?? 0) > 0 && (runGroups?.every((g) => checked[g.id]) ?? false);
  const someChecked = runGroups?.some((g) => checked[g.id]) ?? false;

  function toggleAll() {
    if (!runGroups) return;
    const next = !allChecked;
    setChecked(Object.fromEntries(runGroups.map((g) => [g.id, next])));
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-700 dark:bg-zinc-900">
      <div className="border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
        <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
          Snapshots{" "}
          {isMultiGroup && runGroups ? (
            <span className="font-normal text-zinc-700 dark:text-zinc-200">
              — {runGroups.length} groups
            </span>
          ) : snapshots.length > 0 ? (
            <span className="font-normal text-zinc-700 dark:text-zinc-200">
              — {snapshots.length}
            </span>
          ) : null}
        </h2>
        <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-200">
          {isMultiGroup
            ? "Combined run — check the groups to publish, then hit Publish Selected. Reports never cross group boundaries."
            : "Publish this run's offers as an immutable snapshot for reporting. Reports read snapshots only, never the live run."}
        </p>
      </div>

      {/* Multi-group: shared label + checkbox rows */}
      {isMultiGroup && canPublish ? (
        <form action={publishAction}>
          <input type="hidden" name="label" value={label} />
          <div className="border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Optional date label (e.g. Jun 2026)"
              className="w-full rounded-md border border-zinc-300 px-3 py-1.5 text-sm focus:border-zinc-400 focus:outline-none dark:border-zinc-600 dark:focus:border-zinc-500"
            />
          </div>
          <table className="w-full text-sm">
            <thead className="border-b border-zinc-100 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-700 dark:border-zinc-800 dark:bg-zinc-800 dark:text-zinc-200">
              <tr>
                <th className="w-10 px-4 py-2 text-left">
                  <input
                    type="checkbox"
                    checked={allChecked}
                    onChange={toggleAll}
                    className="rounded border-zinc-300"
                    title="Select all"
                  />
                </th>
                <th className="px-4 py-2 text-left">Group</th>
                <th className="px-4 py-2 text-right">Status</th>
                <th className="px-4 py-2 text-right">Published</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {runGroups.map((group) => {
                const existing = snapshots.find((s) => s.runGroupId === group.id);
                return (
                  <tr key={group.id}>
                    <td className="px-4 py-3">
                      {checked[group.id] && (
                        <input type="hidden" name="groupId" value={group.id} />
                      )}
                      <input
                        type="checkbox"
                        checked={!!checked[group.id]}
                        onChange={(e) =>
                          setChecked((prev) => ({
                            ...prev,
                            [group.id]: e.target.checked,
                          }))
                        }
                        className="rounded border-zinc-300"
                      />
                    </td>
                    <td className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-100">
                      {group.name}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {existing ? (
                        <Link
                          href={`/snapshots/${existing.id}`}
                          className="text-zinc-700 hover:underline dark:text-zinc-300"
                        >
                          ✓ {existing.offerCount} offers
                        </Link>
                      ) : (
                        <span className="text-zinc-600 dark:text-zinc-200">not published</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-zinc-700 dark:text-zinc-200">
                      {existing ? formatDate(existing.approvedAt) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="border-t border-zinc-100 px-4 py-3 flex justify-end dark:border-zinc-800">
            <button
              type="submit"
              disabled={!hasOffers || !someChecked}
              title={
                !hasOffers
                  ? "Run analysis first — no offers to publish"
                  : !someChecked
                    ? "Select at least one group"
                    : undefined
              }
              className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              Publish Selected
            </button>
          </div>
        </form>
      ) : (
        /* Single-group / all-sites: original single form */
        canPublish && (
          <form
            action={publishAction}
            className="flex items-center gap-2 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800"
          >
            <input
              type="text"
              name="label"
              defaultValue={defaultLabel}
              placeholder="Optional label (e.g. Week of Jun 9)"
              className="flex-1 rounded-md border border-zinc-300 px-3 py-1.5 text-sm focus:border-zinc-400 focus:outline-none dark:border-zinc-600 dark:focus:border-zinc-500"
            />
            <button
              type="submit"
              disabled={!hasOffers}
              title={hasOffers ? undefined : "Run analysis first — no offers to publish"}
              className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              Publish Snapshot
            </button>
          </form>
        )
      )}

      {/* Existing snapshots list (shown below the per-group rows for multi-group) */}
      {!isMultiGroup && (
        snapshots.length === 0 ? (
          <p className="px-4 py-6 text-sm text-zinc-700 dark:text-zinc-200">
            No snapshots published from this run yet.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {snapshots.map((snap) => (
              <li
                key={snap.id}
                className="flex items-center justify-between px-4 py-3 text-sm"
              >
                <Link
                  href={`/snapshots/${snap.id}`}
                  className="font-medium text-zinc-900 hover:underline dark:text-zinc-100"
                >
                  {snap.runGroupName || snap.label || `Snapshot ${snap.id.slice(0, 8)}`}
                </Link>
                <span className="text-xs text-zinc-700 dark:text-zinc-200">
                  {snap.label && snap.runGroupName && (
                    <span className="mr-2 text-zinc-700 dark:text-zinc-200">{snap.label}</span>
                  )}
                  {snap.offerCount} offers · {snap.siteCount} sites ·{" "}
                  {formatDate(snap.approvedAt)}
                </span>
              </li>
            ))}
          </ul>
        )
      )}
    </div>
  );
}
