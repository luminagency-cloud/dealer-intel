"use client";

import { useRouter } from "next/navigation";
import { useState, useEffect, useRef } from "react";
import { cancelInventoryBatchAction, runInventoryBatch } from "./actions";
import { fmtDateTime } from "@/lib/fmt-date";
import {
  cancelChromeInventoryCollection,
  requireInventoryExtension,
  runChromeInventoryJob,
} from "./inventory-chrome";
import { supportsChromeInventory } from "@/lib/inventory-platforms";
import { usePolling } from "@/hooks/use-polling";
import { withCollectorLock } from "@/lib/collector-lock";

export type MakeSubtotal = { make: string; inStock: number; inTransit: number | null };
export type ModelRow = { make: string; model: string; inStock: number | null; inTransit: number | null; status: string };

export type InventorySiteRow = {
  id: string;
  name: string;
  url: string;
  brand: string | null;
  platform: string | null;
  active: boolean;
  makes: string[];
  lastResult: {
    status: string;
    collectedAt: Date;
    totals: { inStock: number; inTransit: number | null; displayValue: string } | null;
    makeSubtotals: MakeSubtotal[] | null;
    models: ModelRow[] | null;
    error: { message: string; code: string; statusCode?: number; isRateLimited?: boolean } | null;
  } | null;
};

type RowPhase =
  | { kind: "idle" }
  | { kind: "queued" }
  | { kind: "running" }
  | { kind: "cancelled" }
  | { kind: "ok"; totals?: { inStock: number; inTransit: number | null; displayValue: string }; makeSubtotals?: MakeSubtotal[]; models?: ModelRow[] }
  | { kind: "failed"; error: { message: string; code: string; statusCode?: number } };

type BatchStatusPayload = {
  active: boolean;
  siteIds: string[];
  current: string | null;
  startedAt: string | null;
  results: Record<
    string,
    | { status: "queued" | "running" | "cancelled" }
    | {
        status: "ok" | "failed";
        totals?: { inStock: number; inTransit: number | null; displayValue: string };
        makeSubtotals?: MakeSubtotal[];
        models?: ModelRow[];
        error?: { message: string; code: string; statusCode?: number };
      }
  >;
};

export function InventoryTable({
  sites,
  groups,
  initialActiveBatch,
}: {
  sites: InventorySiteRow[];
  groups: { id: string; name: string; siteIds: string[] }[];
  initialActiveBatch: {
    batchId: string;
    siteIds: string[];
    startedAt: Date;
  } | null;
}) {
  const router = useRouter();
  const [phases, setPhases] = useState<Record<string, RowPhase>>({});
  const [activeBatchId, setActiveBatchId] = useState<string | null>(initialActiveBatch?.batchId ?? null);
  const [batchSiteIds, setBatchSiteIds] = useState<string[]>(initialActiveBatch?.siteIds ?? []);
  const [batchTotal, setBatchTotal] = useState<number | null>(initialActiveBatch?.siteIds.length ?? null);
  const [batchStartedAt, setBatchStartedAt] = useState<Date | null>(initialActiveBatch?.startedAt ?? null);
  const [batchEndedAt, setBatchEndedAt] = useState<Date | null>(null);
  const [chromeBusy, setChromeBusy] = useState(false);
  const [chromeMessage, setChromeMessage] = useState<string | null>(null);
  const [chromeFailed, setChromeFailed] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const chromeAbortRef = useRef<AbortController | null>(null);
  const cancelRequestedRef = useRef(false);
  const autoResumeAttempted = useRef(false);
  const recoveryBatchId = useRef(initialActiveBatch?.batchId ?? null);

  // Scope picker state
  const [scope, setScope] = useState<"all" | "groups" | "custom">("all");
  const [checkedGroups, setCheckedGroups] = useState<Set<string>>(new Set());
  const [checkedSites, setCheckedSites] = useState<Set<string>>(new Set());
  const [scopeOpen, setScopeOpen] = useState(false);

  // Progress lives server-side (see inventory-batch.ts) so a started batch
  // keeps running — and this table keeps reflecting it — no matter what the
  // operator navigates to in the meantime. This just polls for display; it
  // never drives the batch itself.
  usePolling<BatchStatusPayload>(`/api/inventory/batch/${activeBatchId}/status`, {
    enabled: activeBatchId !== null,
    intervalMs: 1500,
    fetchInit: { cache: "no-store" },
    onData: (data) => {
      setPhases((prev) => {
        const next = { ...prev };
        for (const id of data.siteIds) {
          const result = data.results[id];
          if (!result) {
            if (id === data.current) next[id] = { kind: "running" };
            else if (data.active) next[id] = { kind: "queued" };
            continue;
          }

          if (result.status === "queued") {
            next[id] = { kind: "queued" };
          } else if (result.status === "running") {
            next[id] = { kind: "running" };
          } else if (result.status === "cancelled") {
            next[id] = { kind: "cancelled" };
          } else if (result.status === "ok") {
            next[id] = {
              kind: "ok",
              totals: result.totals,
              makeSubtotals: result.makeSubtotals,
              models: result.models,
            };
          } else {
            next[id] = {
              kind: "failed",
              error:
                ("error" in result ? result.error : undefined) ??
                { message: "Unknown error", code: "unknown" },
            };
          }
        }
        return next;
      });
      setBatchSiteIds(data.siteIds);
      setBatchTotal(data.siteIds.length);
      if (data.startedAt) setBatchStartedAt((prev) => prev ?? new Date(data.startedAt!));

      if (!data.active) {
        setBatchEndedAt(new Date());
        setActiveBatchId(null);
        router.refresh();
      }
    },
  });

  async function driveChromeBatch(batchId: string) {
    const controller = new AbortController();
    chromeAbortRef.current = controller;
    if (cancelRequestedRef.current) controller.abort();
    setChromeBusy(true);
    setChromeFailed(false);
    try {
      const version = await requireInventoryExtension();
      setChromeMessage(`Chrome Collector ${version} detected. Preparing visible inventory collection…`);
      const summary = await runChromeInventoryJob(
        batchId,
        setChromeMessage,
        controller.signal
      );
      if (controller.signal.aborted) {
        setChromeMessage("Inventory run cancelled.");
        return;
      }
      setChromeFailed(summary.failed > 0);
      setChromeMessage(
        `Inventory finished: ${summary.succeeded} succeeded, ${summary.failed} failed.`
      );
      router.refresh();
    } catch (error) {
      if (controller.signal.aborted) {
        setChromeFailed(false);
        setChromeMessage("Inventory run cancelled.");
        return;
      }
      await cancelInventoryBatchAction(batchId).catch(() => undefined);
      setPhases((prev) => {
        const next = { ...prev };
        for (const id of Object.keys(next)) {
          if (next[id]?.kind === "queued" || next[id]?.kind === "running") {
            next[id] = { kind: "cancelled" };
          }
        }
        return next;
      });
      setActiveBatchId(null);
      setBatchEndedAt(new Date());
      setChromeFailed(true);
      const detail =
        error instanceof Error ? error.message : "Visible Chrome inventory collection failed";
      setChromeMessage(
        `${detail} Unfinished dealers were cancelled; individual Run buttons are available.`
      );
      router.refresh();
    } finally {
      if (chromeAbortRef.current === controller) chromeAbortRef.current = null;
      setChromeBusy(false);
    }
  }

  async function cancelRun() {
    if (cancelling) return;
    setCancelling(true);
    cancelRequestedRef.current = true;
    setChromeFailed(false);
    setChromeMessage("Cancelling inventory run and closing its Chrome window…");
    chromeAbortRef.current?.abort();

    try {
      await Promise.all([
        cancelChromeInventoryCollection().catch(() => undefined),
        activeBatchId
          ? cancelInventoryBatchAction(activeBatchId)
          : Promise.resolve(),
      ]);
      setPhases((prev) => {
        const next = { ...prev };
        for (const id of batchSiteIds) {
          if (next[id]?.kind === "queued" || next[id]?.kind === "running") {
            next[id] = { kind: "cancelled" };
          }
        }
        return next;
      });
      setActiveBatchId(null);
      setBatchEndedAt(new Date());
      setChromeBusy(false);
      setChromeMessage("Inventory run cancelled. No more dealers will be opened.");
      router.refresh();
    } catch (error) {
      setChromeFailed(true);
      setChromeMessage(
        error instanceof Error ? error.message : "Could not cancel the inventory run"
      );
    } finally {
      setCancelling(false);
    }
  }

  async function claimChromeBatch(batchId: string) {
    await navigator.locks.request(
      `dealer-intel-inventory-${batchId}`,
      { ifAvailable: true },
      async (lock) => {
        if (!lock) {
          // Held by the drive already running this batch — usually this very
          // tab, which is why naming another tab was misleading. That drive
          // re-reads the queue after each dealer, so it picks these up.
          setChromeMessage(
            "Added to the inventory run already in progress; these dealers start when the current one finishes."
          );
          return;
        }
        // Same single extension session the offer collector drives. Whoever
        // holds it keeps it for the whole drive.
        await withCollectorLock(
          () => driveChromeBatch(batchId),
          () => {
            setChromeBusy(false);
            setChromeFailed(true);
            setChromeMessage(
              "An offer collection run is using the Chrome Collector session. Wait for it to finish, then start these dealers again."
            );
          }
        );
      }
    );
  }

  async function runBatchFor(ids: string[]) {
    if (ids.length === 0) return;
    cancelRequestedRef.current = false;
    setChromeBusy(true);
    setChromeFailed(false);
    setChromeMessage("Checking Chrome Collector…");
    try {
      await requireInventoryExtension();
    } catch (error) {
      setChromeFailed(true);
      setChromeMessage(
        error instanceof Error ? error.message : "Chrome Collector is unavailable"
      );
      setChromeBusy(false);
      return;
    }
    setBatchSiteIds((prev) => {
      const next = [...new Set([...prev, ...ids])];
      setBatchTotal(next.length);
      return next;
    });
    setPhases((prev) => {
      const next = { ...prev };
      for (const id of ids) {
        if (prev[id]?.kind !== "running") next[id] = { kind: "queued" };
      }
      return next;
    });
    if (!activeBatchId) {
      setBatchStartedAt(new Date());
      setBatchEndedAt(null);
    }
    try {
      const { batchId } = await runInventoryBatch(ids);
      if (cancelRequestedRef.current) {
        await cancelInventoryBatchAction(batchId);
        return;
      }
      setActiveBatchId(batchId);
      setChromeBusy(false);
      await claimChromeBatch(batchId);
    } catch (error) {
      setPhases((prev) => {
        const next = { ...prev };
        for (const id of ids) {
          if (next[id]?.kind === "queued" || next[id]?.kind === "running") {
            next[id] = { kind: "idle" };
          }
        }
        return next;
      });
      setBatchEndedAt(new Date());
      setChromeFailed(true);
      setChromeMessage(
        error instanceof Error ? error.message : "Could not start the inventory batch"
      );
      setChromeBusy(false);
    }
  }

  useEffect(() => {
    const batchId = recoveryBatchId.current;
    if (!batchId || autoResumeAttempted.current) return;
    autoResumeAttempted.current = true;
    void claimChromeBatch(batchId);
    // Mount-time recovery holds a browser lock until the resumed batch settles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function scopeSiteIds(): string[] {
    if (scope === "all") return sites.map((s) => s.id);
    if (scope === "groups") {
      const ids = new Set<string>();
      for (const g of groups) {
        if (checkedGroups.has(g.id)) g.siteIds.forEach((id) => ids.add(id));
      }
      return [...ids];
    }
    return [...checkedSites];
  }

  const anyActive =
    cancelling ||
    chromeBusy ||
    Boolean(activeBatchId) ||
    Object.values(phases).some((p) => p.kind === "running" || p.kind === "queued");

  // Batch progress derived from phases
  const batchPhaseValues = batchTotal !== null ? batchSiteIds.map((id) => phases[id] ?? { kind: "queued" as const }) : [];
  const batchDone = batchPhaseValues.filter(
    (p) => p.kind === "ok" || p.kind === "failed" || p.kind === "cancelled"
  ).length;
  const batchFailed = batchPhaseValues.filter((p) => p.kind === "failed").length;
  const batchCancelled = batchPhaseValues.filter((p) => p.kind === "cancelled").length;
  const runLabel = scope === "all" ? "All" : scope === "groups" ? "Groups" : "Selected";
  const chromeScopeIds = scopeSiteIds();
  const chromeScopeHasUnsupported = chromeScopeIds.some((id) => {
    const site = sites.find((candidate) => candidate.id === id);
    return !supportsChromeInventory(site?.platform ?? null);
  });
  const scopeDisabled =
    (scope === "groups" && checkedGroups.size === 0) ||
    (scope === "custom" && checkedSites.size === 0);

  const toggleGroup = (id: string) =>
    setCheckedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleSite = (id: string) =>
    setCheckedSites((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div>
      {/* ── Scope toolbar ─────────────────────────────────────────────── */}
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="relative flex items-center gap-3">
          {/* Scope selector */}
          <select
            value={scope}
            onChange={(e) => {
              setScope(e.target.value as "all" | "groups" | "custom");
              setCheckedGroups(new Set());
              setCheckedSites(new Set());
              setScopeOpen(true);
            }}
            className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm focus:outline-none dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
          >
            <option value="all">Scope: All active dealers</option>
            <option value="groups">Pick groups…</option>
            <option value="custom">Pick dealers…</option>
          </select>

          {/* Group picker summary + panel */}
          {scope === "groups" && (
            <>
              <button
                type="button"
                onClick={() => setScopeOpen((v) => !v)}
                className="text-xs text-zinc-700 hover:text-zinc-700"
              >
                {checkedGroups.size === 0 ? "none selected" : `${checkedGroups.size} group${checkedGroups.size !== 1 ? "s" : ""}`} ▾
              </button>
              {scopeOpen && (
                <div className="absolute left-0 top-full z-10 mt-2 max-h-80 w-64 overflow-y-auto rounded-md border border-zinc-200 bg-white p-2 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
                  <p className="px-2 pb-2 pt-1 text-xs text-zinc-700 dark:text-zinc-200">Select one or more groups to run.</p>
                  {groups.map((g) => (
                    <label key={g.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-zinc-900 hover:bg-zinc-50 dark:text-zinc-100 dark:hover:bg-zinc-800">
                      <input
                        type="checkbox"
                        checked={checkedGroups.has(g.id)}
                        onChange={() => toggleGroup(g.id)}
                        className="h-4 w-4 rounded border-zinc-300"
                      />
                      {g.name}
                      <span className="ml-auto text-xs text-zinc-700 dark:text-zinc-200">{g.siteIds.length}</span>
                    </label>
                  ))}
                </div>
              )}
            </>
          )}

          {/* Dealer picker summary + panel */}
          {scope === "custom" && (
            <>
              <button
                type="button"
                onClick={() => setScopeOpen((v) => !v)}
                className="text-xs text-zinc-700 hover:text-zinc-700"
              >
                {checkedSites.size === 0 ? "none selected" : `${checkedSites.size} dealer${checkedSites.size !== 1 ? "s" : ""}`} ▾
              </button>
              {scopeOpen && (
                <div className="absolute left-0 top-full z-10 mt-2 max-h-80 w-72 overflow-y-auto rounded-md border border-zinc-200 bg-white p-2 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
                  <p className="px-2 pb-2 pt-1 text-xs text-zinc-700 dark:text-zinc-200">Select individual dealers to run.</p>
                  {sites.map((s) => (
                    <label key={s.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-zinc-900 hover:bg-zinc-50 dark:text-zinc-100 dark:hover:bg-zinc-800">
                      <input
                        type="checkbox"
                        checked={checkedSites.has(s.id)}
                        onChange={() => toggleSite(s.id)}
                        className="h-4 w-4 rounded border-zinc-300"
                      />
                      {s.name}
                    </label>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex items-center gap-2">
          {anyActive ? (
            <>
              <button
                disabled
                className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
              >
                Running — {batchDone} / {batchTotal ?? batchSiteIds.length}
                {(batchTotal ?? 0) - batchDone > 0
                  ? ` (${(batchTotal ?? 0) - batchDone} left)`
                  : ""}
              </button>
              <button
                type="button"
                onClick={cancelRun}
                disabled={cancelling}
                className="rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-700 dark:bg-zinc-900 dark:text-red-300 dark:hover:bg-red-950"
              >
                {cancelling ? "Cancelling…" : "Cancel Run"}
              </button>
            </>
          ) : (
            <button
              onClick={() => runBatchFor(chromeScopeIds)}
              disabled={scopeDisabled || chromeScopeHasUnsupported}
              title={
                chromeScopeHasUnsupported
                  ? "Some selected dealers have a platform visible Chrome has no adapter for. Choose supported rows individually, or set the dealer's platform if it is missing."
                  : undefined
              }
              className="rounded-md bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50"
            >
              Run — {runLabel}
            </button>
          )}
        </div>
      </div>

      {chromeMessage && (
        <div
          className={`mb-4 rounded-lg border px-4 py-3 text-sm ${
            chromeFailed
              ? "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
              : "border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-200"
          }`}
        >
          {chromeMessage}
        </div>
      )}

      {/* ── Run status bar ────────────────────────────────────────────── */}
      {batchTotal !== null && (
        <div className="mb-4 rounded-lg border border-zinc-200 bg-white px-4 py-3 shadow-sm dark:border-zinc-700 dark:bg-zinc-900">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="font-medium text-zinc-700 dark:text-zinc-300">
              {anyActive
                ? `Running — ${batchDone} of ${batchTotal} complete`
                : batchCancelled > 0
                  ? `Cancelled — ${batchDone} of ${batchTotal} settled`
                  : `Done — ${batchDone} of ${batchTotal} complete`}
              {batchFailed > 0 && (
                <span className="ml-2 text-red-600">({batchFailed} failed)</span>
              )}
              {batchCancelled > 0 && (
                <span className="ml-2 text-zinc-600">({batchCancelled} cancelled)</span>
              )}
            </span>
            <span className="text-xs text-zinc-700 tabular-nums dark:text-zinc-200">
              {batchStartedAt && (
                <>
                  Started {batchStartedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  {batchEndedAt && (
                    <> · Done {batchEndedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</>
                  )}
                </>
              )}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
            <div
              className="h-full rounded-full bg-zinc-800 transition-all duration-300"
              style={{ width: `${batchTotal > 0 ? (batchDone / batchTotal) * 100 : 0}%` }}
            />
          </div>
          {batchFailed > 0 && (
            <div
              className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-zinc-100"
              title="Failed sites"
            >
              <div
                className="h-full rounded-full bg-red-400 transition-all duration-300"
                style={{ width: `${(batchFailed / batchTotal) * 100}%` }}
              />
            </div>
          )}
        </div>
      )}

      {/* ── Dealer table ──────────────────────────────────────────────── */}
      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-700 dark:bg-zinc-900">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
            <tr>
              <th className="px-4 py-3">Dealer</th>
              <th className="px-4 py-3">Make Filter</th>
              <th className="px-4 py-3">Platform</th>
              <th className="px-4 py-3">Last Run</th>
              <th className="px-4 py-3">Result</th>
              <th className="px-4 py-3 text-right">Collect</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {sites.map((site) => {
              const phase = phases[site.id] ?? { kind: "idle" };
              return (
                <SiteRow
                  key={site.id}
                  site={site}
                  phase={phase}
                  supported={supportsChromeInventory(site.platform)}
                  onRun={() => runBatchFor([site.id])}
                />
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

type AgeTier = "none" | "blue" | "green" | "yellow" | "orange" | "red";

function rowAgeTier(site: InventorySiteRow, phase: RowPhase): AgeTier {
  if (phase.kind === "running") return "blue";
  if (phase.kind === "queued") {
    // keep age-based color while queued — fall through to idle logic below
  } else if (phase.kind === "cancelled") {
    // Cancellation is neutral; retain the last completed result's age color.
  } else if (phase.kind === "failed") return "red";
  else if (phase.kind === "ok") return "green";
  // Idle — use persisted last result
  if (!site.lastResult) return "none";
  if (site.lastResult.status === "running") return "blue";
  if (site.lastResult.status !== "ok") return "red";
  const ageMs = Date.now() - new Date(site.lastResult.collectedAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays < 1) return "green";
  if (ageDays < 4) return "yellow";
  return "orange";
}

const TIER_ROW: Record<AgeTier, string> = {
  none:   "!bg-white dark:!bg-zinc-900",
  blue:   "!bg-blue-500",
  green:  "!bg-green-500",
  yellow: "!bg-yellow-400",
  orange: "!bg-orange-500",
  red:    "!bg-red-600",
};
const TIER_TEXT: Record<AgeTier, string> = {
  none:   "!text-zinc-900 dark:!text-zinc-100",
  blue:   "!text-white",
  green:  "!text-white",
  yellow: "!text-yellow-950",
  orange: "!text-white",
  red:    "!text-white",
};
const TIER_SUBTEXT: Record<AgeTier, string> = {
  none:   "!text-zinc-700 dark:!text-zinc-400",
  blue:   "!text-blue-100",
  green:  "!text-green-100",
  yellow: "!text-yellow-800",
  orange: "!text-orange-100",
  red:    "!text-red-200",
};
const TIER_MAKE_CHIP: Record<AgeTier, string> = {
  none:   "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  blue:   "bg-blue-600 text-white",
  green:  "bg-green-600 text-white",
  yellow: "bg-yellow-500 text-yellow-950",
  orange: "bg-orange-600 text-white",
  red:    "bg-red-700 text-white",
};
const TIER_BTN: Record<AgeTier, string> = {
  none:   "border-zinc-300 text-zinc-700 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800",
  blue:   "border-blue-300 text-white hover:bg-blue-600",
  green:  "border-green-300 text-white hover:bg-green-600",
  yellow: "border-yellow-600 text-yellow-950 hover:bg-yellow-500",
  orange: "border-orange-300 text-white hover:bg-orange-600",
  red:    "border-red-400 text-white hover:bg-red-700",
};

function SiteRow({
  site,
  phase,
  supported,
  onRun,
}: {
  site: InventorySiteRow;
  phase: RowPhase;
  supported: boolean;
  onRun: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const tier = rowAgeTier(site, phase);

  const showTotals =
    phase.kind === "ok"
      ? phase.totals
      : phase.kind === "idle"
      ? site.lastResult?.totals
      : null;

  const showMakeSubtotals =
    phase.kind === "ok"
      ? phase.makeSubtotals
      : phase.kind === "idle"
      ? site.lastResult?.makeSubtotals
      : null;

  const showModels =
    phase.kind === "ok"
      ? phase.models
      : phase.kind === "idle"
      ? site.lastResult?.models
      : null;

  const showError =
    phase.kind === "failed"
      ? phase.error
      : phase.kind === "idle" && site.lastResult?.status === "failed"
      ? site.lastResult.error
      : null;

  const hasDetail = !!(showMakeSubtotals?.length || showModels?.length);

  const statusDisplay = (() => {
    if (phase.kind === "queued")
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
          <span className="h-1.5 w-1.5 rounded-full bg-slate-400" />
          Queued
        </span>
      );
    if (phase.kind === "running")
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-600 px-2 py-0.5 text-xs font-medium text-white">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
          Running…
        </span>
      );
    if (phase.kind === "ok")
      return <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">ok</span>;
    if (phase.kind === "failed")
      return <ErrorBadge error={phase.error} />;
    if (!site.lastResult) return <span className="text-xs text-zinc-700">—</span>;
    if (site.lastResult.status === "queued")
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
          <span className="h-1.5 w-1.5 rounded-full bg-slate-400" />
          Queued
        </span>
      );
    if (phase.kind === "cancelled")
      return (
        <span className="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700">
          Cancelled
        </span>
      );
    if (site.lastResult.status === "running")
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-600 px-2 py-0.5 text-xs font-medium text-white">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
          Running…
        </span>
      );
    if (site.lastResult.status === "ok")
      return <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">ok</span>;
    if (site.lastResult.error)
      return <ErrorBadge error={site.lastResult.error} />;
    return <span className="inline-flex items-center rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">failed</span>;
  })();

  const rowBg = TIER_ROW[tier];
  const rowText = TIER_TEXT[tier];
  const rowSub = TIER_SUBTEXT[tier];
  const makeChip = TIER_MAKE_CHIP[tier];
  const btnCls = TIER_BTN[tier];
  const opacity = site.active ? "" : "opacity-50";

  return (
    <>
      <tr className={`${rowBg} ${opacity}`}>
        <td className={`px-4 py-3 font-medium align-top ${rowText}`}>
          {site.name}
          <div className={`text-sm font-normal ${rowSub}`}>{site.url}</div>
        </td>
        <td className="px-4 py-3">
          {site.makes.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {site.makes.map((m) => (
                <span key={m} className={`rounded px-1.5 py-0.5 text-xs ${makeChip}`}>{m}</span>
              ))}
            </div>
          ) : (
            <span className={`text-xs ${rowSub}`}>—</span>
          )}
        </td>
        <td className={`px-4 py-3 text-sm ${rowSub}`}>
          {site.platform ?? <span className={rowSub}>—</span>}
        </td>
        <td className={`px-4 py-3 text-sm ${rowSub}`}>
          {phase.kind !== "idle" ? (
            <span>just now</span>
          ) : site.lastResult ? (
            fmtDateTime(site.lastResult.collectedAt)
          ) : (
            <span>never</span>
          )}
        </td>
        <td className="px-4 py-3">
          <div>{statusDisplay}</div>
          {showError && <div className={`mt-1 text-sm ${rowSub}`}>{showError.message}</div>}
          {showTotals && (
            <div className={`mt-1 font-mono text-sm ${rowSub}`}>
              {showTotals.displayValue ?? `${showTotals.inStock} in stock / ${showTotals.inTransit} in transit`}
            </div>
          )}
        </td>
        <td className="px-4 py-3 text-right">
          <div className="flex items-center justify-end gap-2">
            {hasDetail && (
              <button
                onClick={() => setExpanded((v) => !v)}
                className={`rounded border px-2.5 py-1 text-sm ${btnCls}`}
              >
                {expanded ? "Hide" : "Details"}
              </button>
            )}
            {supported ? (
              <button
                onClick={onRun}
                disabled={phase.kind === "running" || phase.kind === "queued"}
                className={`rounded border px-3 py-1 text-sm disabled:cursor-not-allowed disabled:opacity-40 ${btnCls}`}
              >
                {phase.kind === "running" ? "Running…" : phase.kind === "queued" ? "Queued" : "Run"}
              </button>
            ) : (
              <span className={`text-xs ${rowSub}`}>—</span>
            )}
          </div>
        </td>
      </tr>
      {expanded && hasDetail && (
        <tr className={`${rowBg} ${opacity}`}>
          <td colSpan={6} className="px-6 pb-4 pt-3">
            {showMakeSubtotals && showMakeSubtotals.length > 0 && (
              <div className="mb-3">
                <p className={`mb-1.5 text-xs font-semibold uppercase tracking-wide ${rowSub}`}>By Make</p>
                <table className="w-auto text-sm">
                  <thead>
                    <tr className={`text-xs ${rowSub}`}>
                      <th className="pb-1 pr-6 text-left font-medium">Make</th>
                      <th className="pb-1 pr-6 text-right font-medium">In Stock</th>
                      <th className="pb-1 text-right font-medium">In Transit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {showMakeSubtotals.map((s) => (
                      <tr key={s.make}>
                        <td className={`py-1 pr-6 font-medium ${rowText}`}>{s.make}</td>
                        <td className={`py-1 pr-6 text-right font-mono ${rowText}`}>{s.inStock}</td>
                        <td className={`py-1 text-right font-mono ${rowSub}`}>{s.inTransit ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {showModels && showModels.length > 0 && (
              <div>
                <p className={`mb-1.5 text-xs font-semibold uppercase tracking-wide ${rowSub}`}>By Model</p>
                <table className="w-auto text-sm">
                  <thead>
                    <tr className={`text-xs ${rowSub}`}>
                      <th className="pb-1 pr-6 text-left font-medium">Make</th>
                      <th className="pb-1 pr-6 text-left font-medium">Model</th>
                      <th className="pb-1 pr-6 text-right font-medium">In Stock</th>
                      <th className="pb-1 pr-4 text-right font-medium">In Transit</th>
                      <th className="pb-1 text-left font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {showModels.map((m, i) => (
                      <tr key={i}>
                        <td className={`py-1 pr-6 ${rowSub}`}>{m.make}</td>
                        <td className={`py-1 pr-6 font-medium ${rowText}`}>{m.model}</td>
                        <td className={`py-1 pr-6 text-right font-mono ${rowText}`}>{m.inStock ?? "—"}</td>
                        <td className={`py-1 pr-4 text-right font-mono ${rowSub}`}>{m.inTransit ?? "—"}</td>
                        <td className={`py-1 text-xs ${rowSub}`}>{m.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function ErrorBadge({ error }: { error: { message: string; code: string; statusCode?: number } }) {
  const label = [error.code, error.statusCode].filter(Boolean).join(" · ");
  return (
    <div>
      <span className="inline-flex items-center rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">
        {label || "failed"}
      </span>
    </div>
  );
}
