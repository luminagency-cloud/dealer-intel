"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import type { Mission, MissionResult, MissionResultStatus, Site, SiteMission } from "@/lib/db";
import { MissionStatusBadge } from "@/components/mission-status-badge";

export interface PanelWorkItem {
  site: Site;
  mission: Mission;
  siteMission: SiteMission | null;
}

const FILTER_STATUSES: MissionResultStatus[] = [
  "success",
  "needs_review",
  "failure",
  "not_found",
  "content_removed",
];

const FILTER_LABELS: Record<MissionResultStatus, string> = {
  pending: "Queued",
  running: "Running",
  success: "Success",
  needs_review: "Needs Review",
  failure: "Failure",
  not_found: "Not Found",
  content_removed: "Content Removed",
};

/** Mission-driven collection with live background progress: start the whole
 *  run (or one site+mission pair) and watch statuses update. */
function fmtTime(d: Date | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function totalMin(start: Date | null | undefined, end: Date | null | undefined): string {
  if (!start || !end) return "";
  const mins = Math.round((end.getTime() - start.getTime()) / 60000);
  return mins < 1 ? "< 1 min" : `${mins} min`;
}

export function MissionRunPanel({
  runId,
  items,
  results,
  offerCountsBySiteMission,
  executing,
  canCollect,
  stalled,
  collectionStartedAt,
  collectionCompletedAt,
  executeItemAction,
  executeAllAction,
  retryAction,
  forceReCollectAction,
  reAnalyzeSiteMissionAction,
  partialAnalysisKeys,
  resumeAction,
  error,
}: {
  runId: string;
  items: PanelWorkItem[];
  results: Map<string, MissionResult>;
  /** Offer count per "siteId:missionType" after analysis runs. Empty map before analysis. */
  offerCountsBySiteMission: Map<string, number>;
  executing: boolean;
  /** Run is in a state where collection is allowed (pending or running). */
  canCollect: boolean;
  /** Pending/running rows with no live executor — interrupted run, recoverable. */
  stalled?: boolean;
  collectionStartedAt?: Date | null;
  collectionCompletedAt?: Date | null;
  executeItemAction: (siteId: string, missionId: string) => Promise<void>;
  executeAllAction: () => Promise<void>;
  retryAction: (resultId: string) => Promise<void>;
  /** Force-requeue a specific dealer+mission on a completed/any-status run. */
  forceReCollectAction?: (siteId: string, missionId: string) => Promise<void>;
  /** Re-run offer extraction for one dealer+mission without touching the rest of the run. */
  reAnalyzeSiteMissionAction?: (siteId: string, missionType: string) => Promise<void>;
  /** "siteId:missionType" keys currently being partially re-analyzed. */
  partialAnalysisKeys?: Set<string>;
  resumeAction?: () => Promise<void>;
  error?: string;
}) {
  // Auto-collapse when the run is done — but stay open if a partial re-analysis
  // is in flight so the operator can see the per-row "Analyzing…" indicator.
  const anyPartialAnalysis = (partialAnalysisKeys?.size ?? 0) > 0;
  const [collapsed, setCollapsed] = useState(!canCollect && !executing && !anyPartialAnalysis);
  // null = All (no filter); Set = only rows whose result.status is in the set.
  const [filter, setFilter] = useState<Set<MissionResultStatus> | null>(null);
  // Bulk selection: Set of "siteId:missionId" keys.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkPending, startBulkTransition] = useTransition();

  const all = [...results.values()];
  const done = all.filter(
    (r) => r.status !== "pending" && r.status !== "running"
  ).length;
  const showProgress = executing && all.length > 0;

  const isAll = filter === null;

  function toggleAll() {
    setFilter(null);
  }

  function toggleStatus(status: MissionResultStatus) {
    setFilter((prev) => {
      const next = new Set(prev ?? FILTER_STATUSES);
      if (next.has(status)) {
        next.delete(status);
      } else {
        next.add(status);
      }
      // Empty set is valid — it collapses the table.
      return next;
    });
  }

  const visibleItems = isAll
    ? items
    : items.filter(({ site, mission }) => {
        const result = results.get(`${site.id}:${mission.id}`);
        return result ? filter!.has(result.status) : false;
      });

  const canBulkRecollect = !executing && (canCollect || !!forceReCollectAction);

  function toggleRow(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleSelectAll() {
    const allKeys = visibleItems.map(({ site, mission }) => `${site.id}:${mission.id}`);
    const allSelected = allKeys.every((k) => selected.has(k));
    setSelected(allSelected ? new Set() : new Set(allKeys));
  }

  const visibleKeys = visibleItems.map(({ site, mission }) => `${site.id}:${mission.id}`);
  const allVisibleSelected = visibleKeys.length > 0 && visibleKeys.every((k) => selected.has(k));
  const someVisibleSelected = visibleKeys.some((k) => selected.has(k));

  function handleBulkRecollect() {
    startBulkTransition(async () => {
      for (const { site, mission } of visibleItems) {
        const key = `${site.id}:${mission.id}`;
        if (!selected.has(key)) continue;
        const result = results.get(key);
        const retryable = result && ["needs_review", "failure", "not_found"].includes(result.status);
        if (canCollect && !executing) {
          if (retryable && result) {
            await retryAction(result.id);
          } else {
            await executeItemAction(site.id, mission.id);
          }
        } else if (!canCollect && !executing && forceReCollectAction) {
          await forceReCollectAction(site.id, mission.id);
        }
      }
      setSelected(new Set());
    });
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-3">
        <div>
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className="text-xl font-semibold text-zinc-900 hover:text-zinc-600"
          >
            Collection{" "}
            {showProgress && (
              <span className="font-normal text-zinc-500">
                — collecting {done}/{all.length}
              </span>
            )}
            <span className="ml-2 text-sm font-normal text-zinc-400">
              {collapsed ? "▸ expand" : "▾ collapse"}
            </span>
          </button>
          <p className="mt-1 text-sm text-zinc-500">
            Runs in the background; this page refreshes itself while work is
            in flight. Roughly a minute per page.
          </p>
          {(collectionStartedAt || collectionCompletedAt) && (
            <p className="mt-1 text-sm text-zinc-500">
              {collectionStartedAt && <>Started {fmtTime(collectionStartedAt)}</>}
              {collectionCompletedAt && <> · Completed {fmtTime(collectionCompletedAt)}</>}
              {totalMin(collectionStartedAt, collectionCompletedAt) && (
                <> · {totalMin(collectionStartedAt, collectionCompletedAt)}</>
              )}
            </p>
          )}
        </div>
        {items.length > 0 &&
          (executing ? (
            <button
              type="button"
              disabled
              className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              Collecting…
            </button>
          ) : canCollect && stalled && resumeAction ? (
            <form action={resumeAction}>
              <button
                type="submit"
                className="rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700"
              >
                Resume
              </button>
            </form>
          ) : canCollect && !stalled ? (
            <form action={executeAllAction}>
              <button
                type="submit"
                className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700"
              >
                Start Run
              </button>
            </form>
          ) : null)}
      </div>

      {/* Status filters + bulk actions */}
      {!collapsed && items.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 border-b border-zinc-100 px-4 py-2">
          <label className="flex cursor-pointer items-center gap-1.5 text-xs font-medium text-zinc-700">
            <input
              type="checkbox"
              checked={isAll}
              onChange={toggleAll}
              className="h-3.5 w-3.5 rounded border-zinc-300 accent-zinc-900"
            />
            All
          </label>
          <span className="h-4 w-px bg-zinc-200" />
          {FILTER_STATUSES.map((status) => (
            <label
              key={status}
              className="flex cursor-pointer items-center gap-1.5 text-xs text-zinc-600"
            >
              <input
                type="checkbox"
                checked={isAll || (filter?.has(status) ?? false)}
                onChange={() => toggleStatus(status)}
                className="h-3.5 w-3.5 rounded border-zinc-300 accent-zinc-900"
              />
              {FILTER_LABELS[status]}
            </label>
          ))}
          {canBulkRecollect && someVisibleSelected && (
            <>
              <span className="h-4 w-px bg-zinc-200" />
              <button
                type="button"
                onClick={handleBulkRecollect}
                disabled={bulkPending}
                className="rounded-md bg-zinc-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-zinc-700 disabled:opacity-50"
              >
                {bulkPending
                  ? "Queuing…"
                  : `Re-collect selected (${visibleKeys.filter((k) => selected.has(k)).length})`}
              </button>
            </>
          )}
        </div>
      )}

      {!collapsed && (
        <>
          {stalled && (
            <p className="mx-4 mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
              This run was interrupted — items left mid-collection are stalled with
              no active collector. Click <span className="font-medium">Resume</span>{" "}
              to re-queue and finish them.
            </p>
          )}

          {error && (
            <p className="mx-4 mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          )}

          {items.length === 0 ? (
            <p className="px-4 py-6 text-sm text-zinc-500">
              Nothing to collect in this run&apos;s scope.{" "}
              <Link href="/missions" className="underline">
                Check missions
              </Link>{" "}
              and site status.
            </p>
          ) : visibleItems.length === 0 ? (
            <p className="px-4 py-3 text-xs text-zinc-400">
              {filter !== null && filter.size === 0
                ? "All rows hidden — check a filter above to expand."
                : "No results match the selected filters."}
            </p>
          ) : (
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-100 text-xs uppercase tracking-wide text-zinc-500">
                  {canBulkRecollect && (
                    <th className="pl-4 py-2 w-8">
                      <input
                        type="checkbox"
                        checked={allVisibleSelected}
                        ref={(el) => { if (el) el.indeterminate = someVisibleSelected && !allVisibleSelected; }}
                        onChange={toggleSelectAll}
                        className="h-3.5 w-3.5 rounded border-zinc-300 accent-zinc-900"
                      />
                    </th>
                  )}
                  <th className="px-4 py-2 font-medium">Site</th>
                  <th className="px-4 py-2 font-medium">Mission</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Pages</th>
                  <th className="px-4 py-2 font-medium">Offers</th>
                  <th className="px-4 py-2 font-medium">Detail</th>
                  <th className="px-4 py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {visibleItems.map(({ mission, site }) => {
                  const result = results.get(`${site.id}:${mission.id}`);
                  const reAnalyzing = partialAnalysisKeys?.has(`${site.id}:${mission.missionType}`) ?? false;
                  const busy =
                    result?.status === "pending" || result?.status === "running";
                  const retryable =
                    result &&
                    ["needs_review", "failure", "not_found"].includes(
                      result.status
                    );
                  return (
                    <tr key={`${site.id}:${mission.id}`}>
                      {canBulkRecollect && (
                        <td className="pl-4 py-3">
                          <input
                            type="checkbox"
                            checked={selected.has(`${site.id}:${mission.id}`)}
                            onChange={() => toggleRow(`${site.id}:${mission.id}`)}
                            className="h-3.5 w-3.5 rounded border-zinc-300 accent-zinc-900"
                          />
                        </td>
                      )}
                      <td className="px-4 py-3 text-zinc-900">{site.name}</td>
                      <td className="px-4 py-3 text-zinc-900">{mission.name}</td>
                      <td className="px-4 py-3">
                        {result ? (
                          <MissionStatusBadge status={result.status} />
                        ) : (
                          <span className="text-xs text-zinc-400">
                            not collected
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-zinc-600">
                        {result ? result.pagesCaptured : "—"}
                      </td>
                      <td className="px-4 py-3 text-zinc-600">
                        {offerCountsBySiteMission.get(`${site.id}:${mission.missionType}`) ?? "—"}
                      </td>
                      <td className="max-w-xs truncate px-4 py-3 text-xs text-zinc-500">
                        {result?.error ?? result?.successfulUrl ?? "—"}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <Link
                            href={`/runs/${runId}/evidence/${site.id}`}
                            className="text-xs text-zinc-500 underline hover:text-zinc-800"
                          >
                            Evidence
                          </Link>
                          {reAnalyzeSiteMissionAction && !executing && (
                            reAnalyzing ? (
                              <span className="text-xs text-violet-600 font-medium animate-pulse">
                                Analyzing…
                              </span>
                            ) : (
                              <form
                                action={reAnalyzeSiteMissionAction.bind(
                                  null,
                                  site.id,
                                  mission.missionType
                                )}
                              >
                                <button
                                  type="submit"
                                  className="rounded-md border border-zinc-300 px-2.5 py-1 text-xs text-zinc-600 hover:bg-zinc-50"
                                >
                                  Re-analyze
                                </button>
                              </form>
                            )
                          )}
                          {busy ? (
                            <span className="text-xs text-zinc-400">—</span>
                          ) : retryable && canCollect && !executing ? (
                            <form action={retryAction.bind(null, result.id)}>
                              <button
                                type="submit"
                                className="rounded-md border border-zinc-300 px-2.5 py-1 text-sm text-zinc-700 hover:bg-zinc-50"
                              >
                                Retry
                              </button>
                            </form>
                          ) : canCollect && !executing ? (
                            <form
                              action={executeItemAction.bind(
                                null,
                                site.id,
                                mission.id
                              )}
                            >
                              <button
                                type="submit"
                                className="rounded-md border border-zinc-300 px-2.5 py-1 text-sm text-zinc-700 hover:bg-zinc-50"
                              >
                                Re-collect
                              </button>
                            </form>
                          ) : !canCollect && !executing && forceReCollectAction ? (
                            <form
                              action={forceReCollectAction.bind(
                                null,
                                site.id,
                                mission.id
                              )}
                            >
                              <button
                                type="submit"
                                className="rounded-md border border-zinc-300 px-2.5 py-1 text-sm text-zinc-700 hover:bg-zinc-50"
                              >
                                Re-collect
                              </button>
                            </form>
                          ) : (
                            <span className="text-xs text-zinc-400">—</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
