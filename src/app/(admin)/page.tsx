import Link from "next/link";
import { isDatabaseConfigured } from "@/lib/db";
import { getISOWeekLabel, getPriorISOWeekLabel } from "@/lib/cycle";
import { getCycleGroupStatus, type GroupCycleStatus } from "@/lib/db/ops-board";
import { fetchNewsOverview, isNewsConfigured, type NewsOverview } from "@/lib/news";

export const dynamic = "force-dynamic";

// ── cell helpers ─────────────────────────────────────────────────────────────

type CellState = "done" | "running" | "action" | "blocked" | "warn";

function Cell({
  state,
  children,
}: {
  state: CellState;
  children: React.ReactNode;
}) {
  const cls = {
    done: "text-emerald-700",
    running: "text-blue-600",
    action: "font-medium text-amber-700",
    blocked: "text-zinc-300",
    warn: "text-amber-600",
  }[state];
  return <td className={`px-4 py-2.5 text-sm ${cls}`}>{children}</td>;
}

// ── per-group row ─────────────────────────────────────────────────────────────

function GroupRow({ g, dim }: { g: GroupCycleStatus; dim?: boolean }) {
  const run = g.run;
  const snaps = g.snapshots;

  // ── collect ──
  let collectState: CellState = "blocked";
  let collectLabel = "—";
  if (run) {
    if (run.status === "running") {
      collectState = "running";
      collectLabel = `${run.doneMissions}/${run.totalMissions}`;
    } else if (run.status === "complete" || run.status === "review") {
      collectState = "done";
      collectLabel = `✓ ${run.totalMissions}`;
    } else if (run.status === "failed") {
      collectState = "warn";
      collectLabel = "✗ failed";
    } else {
      collectState = "action";
      collectLabel = "Queued";
    }
  } else if (!dim) {
    collectState = "action";
    collectLabel = "Not run";
  }

  const collectDone = run?.status === "complete" || run?.status === "review";

  // ── analyze ──
  let analyzeState: CellState = "blocked";
  let analyzeLabel = "—";
  if (run && collectDone) {
    if (run.analysisRunning) {
      analyzeState = "running";
      analyzeLabel = "analyzing…";
    } else if (run.analysisDone) {
      if (run.offerCount > 0) {
        analyzeState = "done";
        analyzeLabel = `✓ ${run.offerCount} offers`;
      } else {
        analyzeState = "warn";
        analyzeLabel = "0 offers";
      }
    } else if (!dim) {
      analyzeState = "action";
      analyzeLabel = "Not run";
    }
  }

  const analyzeDone = run?.analysisDone && (run?.offerCount ?? 0) > 0;

  // ── freeze ──
  let freezeState: CellState = "blocked";
  let freezeLabel = "—";
  if (snaps.length > 0) {
    freezeState = "done";
    freezeLabel = `✓ ${snaps.length === 1 ? "Frozen" : `${snaps.length} snapshots`}`;
  } else if (analyzeDone) {
    freezeState = dim ? "blocked" : "action";
    freezeLabel = dim ? "—" : "Not frozen";
  }

  const freezeDone = snaps.length > 0;

  // ── reports ──
  let reportsState: CellState = "blocked";
  let reportsLabel = "—";
  if (freezeDone) {
    const live = snaps.filter((s) => s.clientVisible).length;
    const total = snaps.length;
    if (live === total) {
      reportsState = "done";
      reportsLabel = `✓ Live`;
    } else if (live > 0) {
      reportsState = "warn";
      reportsLabel = `${live}/${total} live`;
    } else {
      reportsState = dim ? "blocked" : "action";
      reportsLabel = dim ? "—" : "Not published";
    }
  }

  const runHref = run ? `/runs/${run.id}` : "/runs";

  return (
    <tr className="border-t border-zinc-100 hover:bg-zinc-50/50">
      <td className="py-2.5 pl-4 pr-3 text-sm font-medium text-zinc-800">
        {run ? (
          <Link href={runHref} className="hover:underline">
            {g.groupName}
          </Link>
        ) : (
          g.groupName
        )}
      </td>

      {/* Collect */}
      <Cell state={collectState}>
        {collectState === "action" && !dim ? (
          <Link href="/runs" className="hover:underline">
            {collectLabel} →
          </Link>
        ) : (
          collectLabel
        )}
      </Cell>

      {/* Analyze */}
      <Cell state={analyzeState}>
        {analyzeState === "action" && run ? (
          <Link href={`/runs/${run.id}`} className="hover:underline">
            {analyzeLabel} →
          </Link>
        ) : (
          analyzeLabel
        )}
      </Cell>

      {/* Freeze */}
      <Cell state={freezeState}>
        {freezeState === "action" && run ? (
          <Link href={`/runs/${run.id}`} className="hover:underline">
            {freezeLabel} →
          </Link>
        ) : freezeState === "done" && snaps[0] ? (
          <Link href={`/snapshots/${snaps[0].id}`} className="hover:underline">
            {freezeLabel}
          </Link>
        ) : (
          freezeLabel
        )}
      </Cell>

      {/* Reports */}
      <Cell state={reportsState}>
        {reportsState === "action" && snaps[0] ? (
          <Link href={`/snapshots/${snaps[0].id}`} className="hover:underline">
            {reportsLabel} →
          </Link>
        ) : reportsState === "done" && snaps[0] ? (
          <Link href={`/reports/${snaps[0].id}`} className="hover:underline">
            {reportsLabel}
          </Link>
        ) : (
          reportsLabel
        )}
      </Cell>
    </tr>
  );
}

// ── news bar ──────────────────────────────────────────────────────────────────

function NewsBar({ overview }: { overview: NewsOverview }) {
  return (
    <div className="mt-3 flex items-center gap-3 rounded-lg border border-zinc-100 bg-zinc-50 px-4 py-2.5 text-sm">
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${overview.fresh ? "bg-emerald-500" : "bg-amber-400"}`}
      />
      <span className="font-medium text-zinc-700">
        News{overview.fresh ? ` ✓ ${overview.week}` : " — stale"}
      </span>
      {overview.generalCount > 0 && (
        <span className="text-zinc-500">General: {overview.generalCount}</span>
      )}
      {overview.brandCounts.map((b) => (
        <span key={b.brand} className="text-zinc-500">
          {b.brand}: {b.count}
        </span>
      ))}
    </div>
  );
}

// ── cycle section ─────────────────────────────────────────────────────────────

function CycleSection({
  cycle,
  groups,
  label,
  newsOverview,
  dim,
}: {
  cycle: string;
  groups: GroupCycleStatus[];
  label: string;
  newsOverview?: NewsOverview | null;
  dim?: boolean;
}) {
  const doneCount = groups.filter(
    (g) => g.snapshots.some((s) => s.clientVisible)
  ).length;
  const total = groups.length;

  return (
    <div className={`mb-6 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm ${dim ? "opacity-60" : ""}`}>
      {/* Header */}
      <div className="flex items-baseline gap-3 border-b border-zinc-100 px-4 py-3">
        <span className="font-mono text-sm font-semibold text-zinc-800">{cycle}</span>
        <span className="text-xs text-zinc-400">{label}</span>
        <span className="ml-auto text-xs text-zinc-400">
          {doneCount}/{total} groups live
        </span>
      </div>

      {/* Table */}
      <table className="w-full">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-zinc-400">
            <th className="py-2 pl-4 pr-3 font-medium">Dealer Group</th>
            <th className="px-4 py-2 font-medium">Collect</th>
            <th className="px-4 py-2 font-medium">Analyze</th>
            <th className="px-4 py-2 font-medium">Freeze</th>
            <th className="px-4 py-2 font-medium">Reports</th>
          </tr>
        </thead>
        <tbody>
          {groups.length === 0 ? (
            <tr>
              <td colSpan={5} className="px-4 py-6 text-center text-sm text-zinc-400">
                No dealer groups configured.
              </td>
            </tr>
          ) : (
            groups.map((g) => <GroupRow key={g.groupId} g={g} dim={dim} />)
          )}
        </tbody>
      </table>

      {/* News bar — current cycle only */}
      {newsOverview && (
        <div className="border-t border-zinc-100 px-4 pb-3 pt-0">
          <NewsBar overview={newsOverview} />
        </div>
      )}
    </div>
  );
}

// ── page ──────────────────────────────────────────────────────────────────────

export default async function HomePage() {
  if (!isDatabaseConfigured()) {
    return (
      <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-8 text-center text-sm text-zinc-500">
        Database not configured.
      </div>
    );
  }

  const currentCycle = getISOWeekLabel();
  const priorCycle = getPriorISOWeekLabel(currentCycle);

  const [currentGroups, priorGroups, newsOverview] = await Promise.all([
    getCycleGroupStatus(currentCycle),
    getCycleGroupStatus(priorCycle),
    isNewsConfigured() ? fetchNewsOverview() : Promise.resolve(null),
  ]);

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-zinc-900">Weekly Ops</h1>
        <div className="flex items-center gap-3 text-sm">
          <Link href="/runs" className="text-zinc-500 hover:text-zinc-900">
            Runs →
          </Link>
          <Link href="/snapshots" className="text-zinc-500 hover:text-zinc-900">
            Snapshots →
          </Link>
          <Link href="/reports" className="text-zinc-500 hover:text-zinc-900">
            Reports →
          </Link>
        </div>
      </div>

      <CycleSection
        cycle={currentCycle}
        groups={currentGroups}
        label="Current Cycle"
        newsOverview={newsOverview}
      />

      <CycleSection
        cycle={priorCycle}
        groups={priorGroups}
        label="Prior Cycle"
        dim
      />
    </div>
  );
}
