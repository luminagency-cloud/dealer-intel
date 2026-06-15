"use client";

import type { MissionResult, ReportSnapshot } from "@/lib/db";

export function RunWorkflowStrip({
  runResults,
  totalWorkItems,
  offerCount,
  snapshots,
  executing,
  stalled,
  canCollect,
  analyzing,
  canAnalyze,
  canPublish,
  runAnalysisAction,
  publishSnapshotAction,
  executeAllAction,
  resumeAction,
  defaultSnapshotLabel,
}: {
  runResults: MissionResult[];
  totalWorkItems: number;
  offerCount: number;
  snapshots: ReportSnapshot[];
  executing: boolean;
  stalled: boolean;
  canCollect: boolean;
  analyzing: boolean;
  canAnalyze: boolean;
  canPublish: boolean;
  runAnalysisAction: () => Promise<void>;
  publishSnapshotAction: (formData: FormData) => Promise<void>;
  executeAllAction: () => Promise<void>;
  resumeAction: () => Promise<void>;
  defaultSnapshotLabel?: string;
}) {
  const succeeded = runResults.filter((r) => r.status === "success").length;
  const failed = runResults.filter((r) =>
    ["failure", "not_found", "needs_review"].includes(r.status)
  ).length;
  const settled = runResults.filter(
    (r) => r.status !== "pending" && r.status !== "running"
  ).length;
  const hasSnapshot = snapshots.length > 0;

  // Step states
  const collectDone = succeeded > 0 && !executing;
  const analyzeDone = offerCount > 0 && !analyzing;

  return (
    <div className="sticky top-0 z-20 border-b border-zinc-200 bg-white shadow-sm">
      <div className="flex items-center gap-0 divide-x divide-zinc-100 text-sm">

        {/* Step 1 — Collect */}
        <a
          href="#collection"
          className="flex min-w-0 items-center gap-2 px-4 py-3 hover:bg-zinc-50"
        >
          <StepDot done={collectDone} active={executing} n={1} />
          <span className="font-medium text-zinc-800">Collect</span>
          <span className="text-xs text-zinc-400">
            {executing
              ? `${settled}/${totalWorkItems} running`
              : stalled
                ? "stalled"
                : settled === 0
                  ? totalWorkItems > 0 ? "not started" : "no scope"
                  : `${succeeded}/${totalWorkItems}${failed > 0 ? ` · ${failed} failed` : ""}`}
          </span>
          {canCollect && !executing && stalled && (
            <form action={resumeAction} onClick={(e) => e.stopPropagation()}>
              <button
                type="submit"
                className="ml-1 rounded bg-amber-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-amber-700"
              >
                Resume
              </button>
            </form>
          )}
          {canCollect && !executing && !stalled && settled === 0 && totalWorkItems > 0 && (
            <form action={executeAllAction} onClick={(e) => e.stopPropagation()}>
              <button
                type="submit"
                className="ml-1 rounded bg-zinc-900 px-2 py-0.5 text-xs font-medium text-white hover:bg-zinc-700"
              >
                Start
              </button>
            </form>
          )}
        </a>

        <span className="px-2 text-zinc-300">→</span>

        {/* Step 2 — Analyze */}
        <a
          href="#analysis"
          className="flex min-w-0 items-center gap-2 px-4 py-3 hover:bg-zinc-50"
        >
          <StepDot done={analyzeDone} active={analyzing} n={2} />
          <span className="font-medium text-zinc-800">Analyze</span>
          <span className="text-xs text-zinc-400">
            {analyzing
              ? "running…"
              : offerCount > 0
                ? `${offerCount} offers`
                : canAnalyze
                  ? "ready"
                  : "waiting"}
          </span>
          {canAnalyze && !analyzing && (
            <form action={runAnalysisAction} onClick={(e) => e.stopPropagation()}>
              <button
                type="submit"
                className="ml-1 rounded bg-zinc-900 px-2 py-0.5 text-xs font-medium text-white hover:bg-zinc-700"
              >
                {offerCount > 0 ? "Re-run" : "Run"}
              </button>
            </form>
          )}
        </a>

        <span className="px-2 text-zinc-300">→</span>

        {/* Step 3 — Freeze */}
        <a
          href="#snapshot"
          className="flex min-w-0 items-center gap-2 px-4 py-3 hover:bg-zinc-50"
        >
          <StepDot done={hasSnapshot} active={false} n={3} />
          <span className="font-medium text-zinc-800">Freeze</span>
          <span className="text-xs text-zinc-400">
            {hasSnapshot
              ? `${snapshots.length} snapshot${snapshots.length > 1 ? "s" : ""}`
              : offerCount > 0
                ? "ready to freeze"
                : "waiting for offers"}
          </span>
          {canPublish && offerCount > 0 && (
            <form
              action={publishSnapshotAction}
              onClick={(e) => e.stopPropagation()}
            >
              <input type="hidden" name="label" value={defaultSnapshotLabel ?? ""} />
              <button
                type="submit"
                className="ml-1 rounded bg-zinc-900 px-2 py-0.5 text-xs font-medium text-white hover:bg-zinc-700"
              >
                {hasSnapshot ? "Re-freeze" : "Freeze"}
              </button>
            </form>
          )}
        </a>
      </div>
    </div>
  );
}

function StepDot({
  done,
  active,
  n,
}: {
  done: boolean;
  active: boolean;
  n: number;
}) {
  if (active)
    return (
      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-blue-100 text-[10px] font-semibold text-blue-700">
        …
      </span>
    );
  if (done)
    return (
      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-green-100 text-[10px] font-semibold text-green-700">
        ✓
      </span>
    );
  return (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-[10px] font-semibold text-zinc-500">
      {n}
    </span>
  );
}
