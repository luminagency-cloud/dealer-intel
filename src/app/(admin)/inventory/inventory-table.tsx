"use client";

import { useRouter } from "next/navigation";
import { useState, useCallback } from "react";
import { runInventoryForSite } from "./actions";
import { fmtDateTime } from "@/lib/fmt-date";

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
    error: { message: string; code: string; statusCode?: number; isRateLimited?: boolean } | null;
  } | null;
};

type RowPhase =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "ok"; totals?: { inStock: number; inTransit: number; displayValue: string } }
  | { kind: "failed"; error: { message: string; code: string; statusCode?: number } };

export function InventoryTable({
  sites,
  configured,
  groupSiteIds,
}: {
  sites: InventorySiteRow[];
  configured: boolean;
  /** When set, "Run Group" fires all these site IDs in parallel. */
  groupSiteIds?: string[];
}) {
  const router = useRouter();
  const [phases, setPhases] = useState<Record<string, RowPhase>>({});

  const setPhase = useCallback((id: string, phase: RowPhase) => {
    setPhases((prev) => ({ ...prev, [id]: phase }));
  }, []);

  async function runSite(siteId: string) {
    setPhase(siteId, { kind: "running" });
    try {
      const result = await runInventoryForSite(siteId);
      if (result.status === "ok") {
        setPhase(siteId, { kind: "ok", totals: result.totals });
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

  async function runGroup() {
    if (!groupSiteIds?.length) return;
    // Fire all in parallel — each manages its own phase
    await Promise.all(groupSiteIds.map((id) => runSite(id)));
  }

  return (
    <div>
      {groupSiteIds && configured && (
        <div className="mb-4 flex justify-end">
          <button
            onClick={runGroup}
            disabled={groupSiteIds.some((id) => phases[id]?.kind === "running")}
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50"
          >
            Run Group
          </button>
        </div>
      )}

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
                  onRun={() => runSite(site.id)}
                />
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

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
  // Resolve display values: in-flight state takes priority over persisted data
  const showTotals =
    phase.kind === "ok"
      ? phase.totals
      : phase.kind === "idle"
      ? site.lastResult?.totals
      : null;

  const showError =
    phase.kind === "failed"
      ? phase.error
      : phase.kind === "idle" && site.lastResult?.status === "failed"
      ? site.lastResult.error
      : null;

  const statusDisplay = (() => {
    if (phase.kind === "running")
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
          Running…
        </span>
      );
    if (phase.kind === "ok")
      return (
        <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
          ok
        </span>
      );
    if (phase.kind === "failed")
      return <ErrorBadge error={phase.error} />;
    if (!site.lastResult) return <span className="text-xs text-zinc-400">—</span>;
    if (site.lastResult.status === "ok")
      return (
        <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
          ok
        </span>
      );
    if (site.lastResult.error)
      return <ErrorBadge error={site.lastResult.error} />;
    return (
      <span className="inline-flex items-center rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">
        failed
      </span>
    );
  })();

  return (
    <tr className={site.active ? "" : "opacity-50"}>
      <td className="px-4 py-3 font-medium text-zinc-900">
        {site.name}
        <div className="text-xs font-normal text-zinc-400">{site.url}</div>
      </td>
      <td className="px-4 py-3 text-zinc-600">
        {site.makes.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {site.makes.map((m) => (
              <span key={m} className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-700">
                {m}
              </span>
            ))}
          </div>
        ) : (
          <span className="text-zinc-400">—</span>
        )}
      </td>
      <td className="px-4 py-3 text-xs text-zinc-500">
        {site.platform ?? <span className="text-zinc-400">—</span>}
      </td>
      <td className="px-4 py-3 text-xs text-zinc-500">
        {phase.kind !== "idle" ? (
          <span className="text-zinc-500">just now</span>
        ) : site.lastResult ? (
          fmtDateTime(site.lastResult.collectedAt)
        ) : (
          <span className="text-zinc-400">never</span>
        )}
      </td>
      <td className="px-4 py-3">
        <div>{statusDisplay}</div>
        {showError && (
          <div className="mt-1 text-xs text-red-600">{showError.message}</div>
        )}
        {showTotals && (
          <div className="mt-1 font-mono text-xs text-zinc-600">
            {showTotals.displayValue ?? `${showTotals.inStock} / ${showTotals.inTransit}*`}
          </div>
        )}
      </td>
      <td className="px-4 py-3 text-right">
        {configured ? (
          <button
            onClick={onRun}
            disabled={phase.kind === "running"}
            className="rounded border border-zinc-300 px-3 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {phase.kind === "running" ? "Running…" : "Run"}
          </button>
        ) : (
          <span className="text-xs text-zinc-400">—</span>
        )}
      </td>
    </tr>
  );
}

function ErrorBadge({
  error,
}: {
  error: { message: string; code: string; statusCode?: number };
}) {
  const label = [error.code, error.statusCode].filter(Boolean).join(" · ");
  return (
    <div>
      <span className="inline-flex items-center rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">
        {label || "failed"}
      </span>
    </div>
  );
}
