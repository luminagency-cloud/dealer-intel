"use client";

import { useRouter } from "next/navigation";
import { useState, useCallback, useRef } from "react";
import { runInventoryForSite } from "./actions";
import { fmtDateTime } from "@/lib/fmt-date";

export type MakeSubtotal = { make: string; inStock: number; inTransit: number };
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
    totals: { inStock: number; inTransit: number; displayValue: string } | null;
    makeSubtotals: MakeSubtotal[] | null;
    models: ModelRow[] | null;
    error: { message: string; code: string; statusCode?: number; isRateLimited?: boolean } | null;
  } | null;
};

type RowPhase =
  | { kind: "idle" }
  | { kind: "queued" }
  | { kind: "running" }
  | { kind: "ok"; totals?: { inStock: number; inTransit: number; displayValue: string }; makeSubtotals?: MakeSubtotal[]; models?: ModelRow[] }
  | { kind: "failed"; error: { message: string; code: string; statusCode?: number } };

export function InventoryTable({
  sites,
  groups,
  configured,
}: {
  sites: InventorySiteRow[];
  groups: { id: string; name: string; siteIds: string[] }[];
  configured: boolean;
}) {
  const router = useRouter();
  const [phases, setPhases] = useState<Record<string, RowPhase>>({});
  const [batchTotal, setBatchTotal] = useState<number | null>(null);
  const [batchStartedAt, setBatchStartedAt] = useState<Date | null>(null);
  const [batchEndedAt, setBatchEndedAt] = useState<Date | null>(null);

  // Scope picker state
  const [scope, setScope] = useState<"all" | "groups" | "custom">("all");
  const [checkedGroups, setCheckedGroups] = useState<Set<string>>(new Set());
  const [checkedSites, setCheckedSites] = useState<Set<string>>(new Set());
  const [scopeOpen, setScopeOpen] = useState(false);

  const setPhase = useCallback((id: string, phase: RowPhase) => {
    setPhases((prev) => ({ ...prev, [id]: phase }));
  }, []);

  // Shared queue — both individual clicks and batch runs feed into this.
  const queueRef = useRef<string[]>([]);
  const processingRef = useRef(false);

  async function processQueue() {
    if (processingRef.current) return;
    processingRef.current = true;
    while (queueRef.current.length > 0) {
      const siteId = queueRef.current.shift()!;
      setPhase(siteId, { kind: "running" });
      try {
        const result = await runInventoryForSite(siteId);
        if (result.status === "ok") {
          setPhase(siteId, { kind: "ok", totals: result.totals, makeSubtotals: result.makeSubtotals, models: result.models });
        } else {
          setPhase(siteId, { kind: "failed", error: result.error ?? { message: "Unknown error", code: "unknown" } });
        }
      } catch (err) {
        setPhase(siteId, {
          kind: "failed",
          error: { message: err instanceof Error ? err.message : String(err), code: "client_error" },
        });
      }
      router.refresh();
    }
    processingRef.current = false;
  }

  function enqueue(ids: string[]) {
    const fresh = ids.filter((id) => !queueRef.current.includes(id));
    queueRef.current.push(...fresh);
    setPhases((prev) => {
      const next = { ...prev };
      for (const id of fresh) {
        if (prev[id]?.kind !== "running") next[id] = { kind: "queued" };
      }
      return next;
    });
    processQueue();
  }

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

  async function runScope() {
    const ids = scopeSiteIds();
    if (ids.length === 0) return;
    setBatchTotal((ids.length + (batchTotal ?? 0)));
    setBatchStartedAt((prev) => prev ?? new Date());
    setBatchEndedAt(null);
    enqueue(ids);
    // Wait for the queue to drain so we can set batch end time
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (!processingRef.current && queueRef.current.length === 0) {
          clearInterval(interval);
          resolve();
        }
      }, 200);
    });
    setBatchEndedAt(new Date());
    setBatchTotal(null);
  }

  const anyActive = Object.values(phases).some((p) => p.kind === "running" || p.kind === "queued");

  // Batch progress derived from phases
  const batchPhaseValues = batchTotal !== null ? Object.values(phases) : [];
  const batchDone = batchPhaseValues.filter((p) => p.kind === "ok" || p.kind === "failed").length;
  const batchFailed = batchPhaseValues.filter((p) => p.kind === "failed").length;
  const batchRunning = batchPhaseValues.filter((p) => p.kind === "running").length;
  const runLabel = scope === "all" ? "Run All" : scope === "groups" ? "Run Groups" : "Run Selected";

  const toggleGroup = (id: string) =>
    setCheckedGroups((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleSite = (id: string) =>
    setCheckedSites((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

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
            className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm focus:outline-none"
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
                className="text-xs text-zinc-500 hover:text-zinc-700"
              >
                {checkedGroups.size === 0 ? "none selected" : `${checkedGroups.size} group${checkedGroups.size !== 1 ? "s" : ""}`} ▾
              </button>
              {scopeOpen && (
                <div className="absolute left-0 top-full z-10 mt-2 max-h-80 w-64 overflow-y-auto rounded-md border border-zinc-200 bg-white p-2 shadow-lg">
                  <p className="px-2 pb-2 pt-1 text-xs text-zinc-500">Select one or more groups to run.</p>
                  {groups.map((g) => (
                    <label key={g.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-zinc-900 hover:bg-zinc-50">
                      <input
                        type="checkbox"
                        checked={checkedGroups.has(g.id)}
                        onChange={() => toggleGroup(g.id)}
                        className="h-4 w-4 rounded border-zinc-300"
                      />
                      {g.name}
                      <span className="ml-auto text-xs text-zinc-400">{g.siteIds.length}</span>
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
                className="text-xs text-zinc-500 hover:text-zinc-700"
              >
                {checkedSites.size === 0 ? "none selected" : `${checkedSites.size} dealer${checkedSites.size !== 1 ? "s" : ""}`} ▾
              </button>
              {scopeOpen && (
                <div className="absolute left-0 top-full z-10 mt-2 max-h-80 w-72 overflow-y-auto rounded-md border border-zinc-200 bg-white p-2 shadow-lg">
                  <p className="px-2 pb-2 pt-1 text-xs text-zinc-500">Select individual dealers to run.</p>
                  {sites.map((s) => (
                    <label key={s.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-zinc-900 hover:bg-zinc-50">
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

        {configured && (
          <button
            onClick={runScope}
            disabled={anyActive || (scope === "groups" && checkedGroups.size === 0) || (scope === "custom" && checkedSites.size === 0)}
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50"
          >
            {batchTotal !== null
              ? `Running — ${batchDone} / ${batchTotal}${batchTotal - batchDone > 0 ? ` (${batchTotal - batchDone} left)` : ""}`
              : runLabel}
          </button>
        )}
      </div>

      {/* ── Run status bar ────────────────────────────────────────────── */}
      {batchTotal !== null && (
        <div className="mb-4 rounded-lg border border-zinc-200 bg-white px-4 py-3 shadow-sm">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="font-medium text-zinc-700">
              {anyActive
                ? `Running — ${batchDone} of ${batchTotal} complete`
                : `Done — ${batchDone} of ${batchTotal} complete`}
              {batchFailed > 0 && (
                <span className="ml-2 text-red-600">({batchFailed} failed)</span>
              )}
            </span>
            <span className="text-xs text-zinc-400 tabular-nums">
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
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-100">
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
      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-4 py-3">Dealer</th>
              <th className="px-4 py-3">Make Filter</th>
              <th className="px-4 py-3">Platform</th>
              <th className="px-4 py-3">Last Run</th>
              <th className="px-4 py-3">Result</th>
              <th className="px-4 py-3 text-right">Collect</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {sites.map((site) => {
              const phase = phases[site.id] ?? { kind: "idle" };
              return (
                <SiteRow
                  key={site.id}
                  site={site}
                  phase={phase}
                  configured={configured}
                  onRun={() => enqueue([site.id])}
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
  } else if (phase.kind === "failed") return "red";
  else if (phase.kind === "ok") return "green";
  // Idle — use persisted last result
  if (!site.lastResult) return "none";
  if (site.lastResult.status !== "ok") return "red";
  const ageMs = Date.now() - new Date(site.lastResult.collectedAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays < 1) return "green";
  if (ageDays < 4) return "yellow";
  return "orange";
}

const TIER_ROW: Record<AgeTier, string> = {
  none:   "!bg-white",
  blue:   "!bg-blue-500",
  green:  "!bg-green-500",
  yellow: "!bg-yellow-400",
  orange: "!bg-orange-500",
  red:    "!bg-red-600",
};
const TIER_TEXT: Record<AgeTier, string> = {
  none:   "!text-zinc-900",
  blue:   "!text-white",
  green:  "!text-white",
  yellow: "!text-yellow-950",
  orange: "!text-white",
  red:    "!text-white",
};
const TIER_SUBTEXT: Record<AgeTier, string> = {
  none:   "!text-zinc-500",
  blue:   "!text-blue-100",
  green:  "!text-green-100",
  yellow: "!text-yellow-800",
  orange: "!text-orange-100",
  red:    "!text-red-200",
};
const TIER_MAKE_CHIP: Record<AgeTier, string> = {
  none:   "bg-zinc-100 text-zinc-700",
  blue:   "bg-blue-600 text-white",
  green:  "bg-green-600 text-white",
  yellow: "bg-yellow-500 text-yellow-950",
  orange: "bg-orange-600 text-white",
  red:    "bg-red-700 text-white",
};
const TIER_BTN: Record<AgeTier, string> = {
  none:   "border-zinc-300 text-zinc-700 hover:bg-zinc-50",
  blue:   "border-blue-300 text-white hover:bg-blue-600",
  green:  "border-green-300 text-white hover:bg-green-600",
  yellow: "border-yellow-600 text-yellow-950 hover:bg-yellow-500",
  orange: "border-orange-300 text-white hover:bg-orange-600",
  red:    "border-red-400 text-white hover:bg-red-700",
};

function SiteRow({
  site,
  phase,
  configured,
  onRun,
}: {
  site: InventorySiteRow;
  phase: RowPhase;
  configured: boolean;
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
        <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
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
    if (!site.lastResult) return <span className="text-xs text-zinc-400">—</span>;
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
            {configured ? (
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
                        <td className={`py-1 text-right font-mono ${rowSub}`}>{s.inTransit}</td>
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
