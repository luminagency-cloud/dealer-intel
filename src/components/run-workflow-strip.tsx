"use client";

import type { MissionResult, ReportSnapshot } from "@/lib/db";

export function RunWorkflowStrip({
  runResults,
  totalWorkItems,
  offerCount,
  snapshots,
  executing,
  analyzing,
  canAnalyze,
  canPublish,
  runAnalysisAction,
  publishSnapshotAction,
  defaultSnapshotLabel,
}: {
  runResults: MissionResult[];
  totalWorkItems: number;
  offerCount: number;
  snapshots: ReportSnapshot[];
  executing: boolean;
  analyzing: boolean;
  canAnalyze: boolean;
  canPublish: boolean;
  runAnalysisAction: () => Promise<void>;
  publishSnapshotAction: (formData: FormData) => Promise<void>;
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
    <div className="sticky top-0 z-20 border-b border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center gap-0 divide-x divide-zinc-100 dark:divide-zinc-800">

        {/* Step 1 — Collect */}
        <a
          href="#collection"
          className="flex min-w-0 items-center gap-3 px-5 py-4 hover:bg-zinc-50 dark:hover:bg-zinc-800"
        >
          <StepDot done={collectDone} active={executing} n={1} />
          <span className="text-base font-semibold text-zinc-800 dark:text-zinc-200">Collect</span>
          <span className="text-sm text-zinc-700 dark:text-zinc-200">
            {executing
              ? `${settled}/${totalWorkItems} running`
              : settled === 0
                ? totalWorkItems > 0 ? "not started" : "no scope"
                : `${succeeded}/${totalWorkItems}${failed > 0 ? ` · ${failed} failed` : ""}`}
          </span>
        </a>

        <span className="px-3 text-lg text-zinc-600 dark:text-zinc-200">→</span>

        {/* Step 2 — Analyze */}
        <a
          href="#analysis"
          className="flex min-w-0 items-center gap-3 px-5 py-4 hover:bg-zinc-50 dark:hover:bg-zinc-800"
        >
          <StepDot done={analyzeDone} active={analyzing} n={2} />
          <span className="text-base font-semibold text-zinc-800 dark:text-zinc-200">Analyze</span>
          <span className="text-sm text-zinc-700 dark:text-zinc-200">
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
                className="ml-1 rounded bg-zinc-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-zinc-700"
              >
                {offerCount > 0 ? "Re-run" : "Run"}
              </button>
            </form>
          )}
        </a>

        <span className="px-3 text-lg text-zinc-600 dark:text-zinc-200">→</span>

        {/* Step 3 — Freeze */}
        <a
          href="#snapshot"
          className="flex min-w-0 items-center gap-3 px-5 py-4 hover:bg-zinc-50 dark:hover:bg-zinc-800"
        >
          <StepDot done={hasSnapshot} active={false} n={3} />
          <span className="text-base font-semibold text-zinc-800 dark:text-zinc-200">Freeze</span>
          <span className="text-sm text-zinc-700 dark:text-zinc-200">
            {hasSnapshot
              ? `${snapshots.length} snapshot${snapshots.length > 1 ? "s" : ""}`
              : analyzing
                ? "waiting for analysis"
                : offerCount > 0
                  ? "ready to freeze"
                  : "waiting for offers"}
          </span>
          {canPublish && offerCount > 0 && !analyzing && (
            <form
              action={publishSnapshotAction}
              onClick={(e) => e.stopPropagation()}
            >
              <input type="hidden" name="label" value={defaultSnapshotLabel ?? ""} />
              <button
                type="submit"
                className="ml-1 rounded bg-zinc-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-zinc-700"
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
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-100 text-xs font-semibold text-blue-700 dark:bg-blue-900 dark:text-blue-200">
        …
      </span>
    );
  if (done)
    return (
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-green-100 text-xs font-semibold text-green-700 dark:bg-green-900 dark:text-green-200">
        ✓
      </span>
    );
  return (
    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-xs font-semibold text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
      {n}
    </span>
  );
}
