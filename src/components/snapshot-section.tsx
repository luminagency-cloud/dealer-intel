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
 *  per-group rows so each group can be frozen independently. */
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

  return (
    <div className="rounded-lg border border-zinc-200 bg-white shadow-sm">
      <div className="border-b border-zinc-100 px-4 py-3">
        <h2 className="text-xl font-semibold text-zinc-900">
          Snapshots{" "}
          {snapshots.length > 0 && (
            <span className="font-normal text-zinc-500">
              — {snapshots.length}
            </span>
          )}
        </h2>
        <p className="mt-1 text-sm text-zinc-500">
          {isMultiGroup
            ? "Combined run — freeze each group independently or all at once. Reports never cross group boundaries."
            : "Freeze this run's offers into an immutable snapshot for reporting. Reports read snapshots only, never the live run."}
        </p>
      </div>

      {/* Multi-group: shared label + per-group freeze rows */}
      {isMultiGroup && canPublish ? (
        <>
          <div className="border-b border-zinc-100 px-4 py-3">
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Optional date label (e.g. Jun 2026)"
              className="w-full rounded-md border border-zinc-300 px-3 py-1.5 text-sm focus:border-zinc-400 focus:outline-none"
            />
          </div>
          <ul className="divide-y divide-zinc-100">
            {runGroups.map((group) => {
              const existing = snapshots.find((s) => s.runGroupId === group.id);
              return (
                <li key={group.id} className="flex items-center justify-between px-4 py-3 text-sm">
                  <span className="font-medium text-zinc-900">{group.name}</span>
                  <div className="flex items-center gap-4">
                    {existing ? (
                      <Link
                        href={`/snapshots/${existing.id}`}
                        className="text-sm text-zinc-500 hover:underline"
                      >
                        ✓ {existing.offerCount} offers
                      </Link>
                    ) : (
                      <span className="text-sm text-zinc-300">not frozen</span>
                    )}
                    <span className="w-36 text-right text-sm text-zinc-500">
                      {existing ? formatDate(existing.approvedAt) : "—"}
                    </span>
                    <form action={publishAction}>
                      <input type="hidden" name="groupId" value={group.id} />
                      <input type="hidden" name="label" value={label} />
                      <button
                        type="submit"
                        disabled={!hasOffers}
                        title={hasOffers ? undefined : "Run analysis first — no offers to freeze"}
                        className="rounded-md border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {existing ? "Re-freeze" : "Freeze"}
                      </button>
                    </form>
                  </div>
                </li>
              );
            })}
          </ul>
          {/* Freeze All */}
          <div className="border-t border-zinc-100 px-4 py-3">
            <form action={publishAction} className="flex justify-end">
              <input type="hidden" name="label" value={label} />
              <button
                type="submit"
                disabled={!hasOffers}
                title={hasOffers ? undefined : "Run analysis first — no offers to freeze"}
                className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Freeze All {runGroups.length} Groups
              </button>
            </form>
          </div>
        </>
      ) : (
        /* Single-group / all-sites: original single form */
        canPublish && (
          <form
            action={publishAction}
            className="flex items-center gap-2 border-b border-zinc-100 px-4 py-3"
          >
            <input
              type="text"
              name="label"
              defaultValue={defaultLabel}
              placeholder="Optional label (e.g. Week of Jun 9)"
              className="flex-1 rounded-md border border-zinc-300 px-3 py-1.5 text-sm focus:border-zinc-400 focus:outline-none"
            />
            <button
              type="submit"
              disabled={!hasOffers}
              title={hasOffers ? undefined : "Run analysis first — no offers to freeze"}
              className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Freeze Snapshot
            </button>
          </form>
        )
      )}

      {/* Existing snapshots list (shown below the per-group rows for multi-group) */}
      {!isMultiGroup && (
        snapshots.length === 0 ? (
          <p className="px-4 py-6 text-sm text-zinc-500">
            No snapshots published from this run yet.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-100">
            {snapshots.map((snap) => (
              <li
                key={snap.id}
                className="flex items-center justify-between px-4 py-3 text-sm"
              >
                <Link
                  href={`/snapshots/${snap.id}`}
                  className="font-medium text-zinc-900 hover:underline"
                >
                  {snap.runGroupName || snap.label || `Snapshot ${snap.id.slice(0, 8)}`}
                </Link>
                <span className="text-xs text-zinc-500">
                  {snap.label && snap.runGroupName && (
                    <span className="mr-2 text-zinc-400">{snap.label}</span>
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
