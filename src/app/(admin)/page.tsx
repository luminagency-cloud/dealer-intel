import Link from "next/link";
import { isDatabaseConfigured, getDb, runGroups } from "@/lib/db";
import { count } from "drizzle-orm";
import { getISOWeekLabel, getPriorISOWeekLabel } from "@/lib/cycle";
import { getCycleGroupStatus, getWeekAggregate, type GroupCycleStatus, type WeekAggregate } from "@/lib/db/ops-board";
import { fetchNewsOverview, isNewsConfigured, type NewsOverview } from "@/lib/news";

export const dynamic = "force-dynamic";

// ── step dot (same visual as RunWorkflowStrip) ────────────────────────────────

function StepDot({ done, active, n }: { done: boolean; active: boolean; n: number }) {
  if (active)
    return <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-100 text-xs font-semibold text-blue-700">…</span>;
  if (done)
    return <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-green-100 text-xs font-semibold text-green-700">✓</span>;
  return <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-xs font-semibold text-zinc-500">{n}</span>;
}

// ── aggregate strip ───────────────────────────────────────────────────────────

function WeekStrip({
  agg,
  news,
  cycle,
}: {
  agg: WeekAggregate;
  news: NewsOverview | null;
  cycle: string;
}) {
  const collectDone = agg.anyRunComplete;
  const analyzeDone = agg.analysisDone && agg.offerCount > 0;
  const newsDone = news?.fresh === true;
  const freezeDone = agg.frozenGroupCount > 0;
  const reportsDone = agg.liveGroupCount === agg.totalGroupCount && agg.totalGroupCount > 0;

  return (
    <div className="flex items-center gap-0 divide-x divide-zinc-100 overflow-x-auto">

      {/* Collect */}
      <Link
        href={agg.latestRunId ? `/runs/${agg.latestRunId}` : "/runs"}
        className="flex min-w-0 shrink-0 items-center gap-3 px-5 py-4 hover:bg-zinc-50"
      >
        <StepDot done={collectDone} active={agg.collectRunning} n={1} />
        <span className="text-base font-semibold text-zinc-800">Collect</span>
        <span className="text-sm text-zinc-400">
          {agg.collectRunning
            ? `${agg.doneMissions}/${agg.totalMissions} running`
            : agg.totalMissions === 0
              ? "not run"
              : `${agg.doneMissions}/${agg.totalMissions}`}
        </span>
      </Link>

      <span className="px-3 text-lg text-zinc-300">→</span>

      {/* Analyze */}
      <Link
        href={agg.latestRunId ? `/runs/${agg.latestRunId}` : "/runs"}
        className="flex min-w-0 shrink-0 items-center gap-3 px-5 py-4 hover:bg-zinc-50"
      >
        <StepDot done={analyzeDone} active={agg.analysisRunning} n={2} />
        <span className="text-base font-semibold text-zinc-800">Analyze</span>
        <span className="text-sm text-zinc-400">
          {agg.analysisRunning
            ? "running…"
            : agg.offerCount > 0
              ? `${agg.offerCount} offers`
              : agg.anyRunComplete
                ? "ready"
                : "waiting"}
        </span>
      </Link>

      <span className="px-3 text-lg text-zinc-300">→</span>

      {/* News */}
      <div className="flex min-w-0 shrink-0 items-center gap-3 px-5 py-4">
        <StepDot done={newsDone} active={false} n={3} />
        <span className="text-base font-semibold text-zinc-800">News</span>
        {news === null && isNewsConfigured() ? (
          <span className="text-sm text-zinc-400">unavailable</span>
        ) : news ? (
          <>
            <span className="text-sm text-zinc-400">
              {news.fresh ? news.week : `stale · last ${news.week}`}
            </span>
            {news.brandCounts.length > 0 && (
              <span className="hidden text-xs text-zinc-400 lg:inline">
                {[
                  news.generalCount > 0 ? `General: ${news.generalCount}` : null,
                  ...news.brandCounts.map((b) => `${b.brand}: ${b.count}`),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            )}
          </>
        ) : (
          <span className="text-sm text-zinc-400">not configured</span>
        )}
        {isNewsConfigured() && (
          <a
            href="https://news.dlrtools.com/admin"
            target="_blank"
            rel="noreferrer"
            className="ml-1 rounded bg-zinc-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-zinc-700"
          >
            Manage
          </a>
        )}
      </div>

      <span className="px-3 text-lg text-zinc-300">→</span>

      {/* Freeze */}
      <Link
        href={agg.latestRunId ? `/runs/${agg.latestRunId}` : "/runs"}
        className="flex min-w-0 shrink-0 items-center gap-3 px-5 py-4 hover:bg-zinc-50"
      >
        <StepDot done={freezeDone && agg.frozenGroupCount >= agg.totalGroupCount} active={false} n={4} />
        <span className="text-base font-semibold text-zinc-800">Freeze</span>
        <span className="text-sm text-zinc-400">
          {agg.frozenGroupCount > 0
            ? `${agg.frozenGroupCount}/${agg.totalGroupCount} frozen`
            : analyzeDone
              ? "ready"
              : "waiting"}
        </span>
      </Link>

      <span className="px-3 text-lg text-zinc-300">→</span>

      {/* Reports */}
      <Link
        href="/reports"
        className="flex min-w-0 shrink-0 items-center gap-3 px-5 py-4 hover:bg-zinc-50"
      >
        <StepDot done={reportsDone} active={false} n={5} />
        <span className="text-base font-semibold text-zinc-800">Reports</span>
        <span className="text-sm text-zinc-400">
          {agg.liveGroupCount > 0
            ? `${agg.liveGroupCount}/${agg.totalGroupCount} live`
            : agg.frozenGroupCount > 0
              ? "not published"
              : "waiting"}
        </span>
      </Link>
    </div>
  );
}

// ── per-group exception table ─────────────────────────────────────────────────

function GroupTable({ groups }: { groups: GroupCycleStatus[] }) {
  if (groups.every((g) => g.run === null)) return null;

  return (
    <div className="overflow-hidden border-t border-zinc-100">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-zinc-400">
            <th className="py-2 pl-5 pr-3 font-medium">Group</th>
            <th className="px-4 py-2 font-medium">Collect</th>
            <th className="px-4 py-2 font-medium">Analyze</th>
            <th className="px-4 py-2 font-medium">Freeze</th>
            <th className="px-4 py-2 font-medium">Reports</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-50">
          {groups.map((g) => {
            const run = g.run;
            const snaps = g.snapshots;
            const collectDone = run?.status === "complete" || run?.status === "review";
            const analyzeDone = run?.analysisDone && (run?.offerCount ?? 0) > 0;
            const liveCount = snaps.filter((s) => s.clientVisible).length;

            return (
              <tr key={g.groupId} className="hover:bg-zinc-50/50">
                <td className="py-2 pl-5 pr-3 font-medium text-zinc-700">
                  {run ? (
                    <Link href={`/runs/${run.id}`} className="hover:underline">
                      {g.groupName}
                    </Link>
                  ) : (
                    g.groupName
                  )}
                </td>

                {/* Collect */}
                <td className={`px-4 py-2 ${!run ? "text-zinc-300" : run.status === "running" ? "text-blue-600" : collectDone ? "text-emerald-600" : "text-amber-600"}`}>
                  {!run
                    ? "—"
                    : run.status === "running"
                      ? `${run.doneMissions}/${run.totalMissions}`
                      : collectDone
                        ? `✓ ${run.totalMissions}`
                        : run.status === "failed"
                          ? "✗ failed"
                          : "queued"}
                </td>

                {/* Analyze */}
                <td className={`px-4 py-2 ${!collectDone ? "text-zinc-300" : run?.analysisRunning ? "text-blue-600" : analyzeDone ? "text-emerald-600" : "text-amber-600"}`}>
                  {!collectDone
                    ? "—"
                    : run?.analysisRunning
                      ? "analyzing…"
                      : analyzeDone
                        ? `✓ ${run!.offerCount}`
                        : run?.analysisDone
                          ? "0 offers"
                          : "ready →"}
                </td>

                {/* Freeze */}
                <td className={`px-4 py-2 ${snaps.length > 0 ? "text-emerald-600" : !analyzeDone ? "text-zinc-300" : "text-amber-600"}`}>
                  {snaps.length > 0 ? (
                    <Link href={`/snapshots/${snaps[0].id}`} className="hover:underline">
                      ✓ frozen
                    </Link>
                  ) : !analyzeDone ? (
                    "—"
                  ) : (
                    <Link href={run ? `/runs/${run.id}` : "/runs"} className="hover:underline">
                      freeze →
                    </Link>
                  )}
                </td>

                {/* Reports */}
                <td className={`px-4 py-2 ${liveCount > 0 ? "text-emerald-600" : snaps.length === 0 ? "text-zinc-300" : "text-amber-600"}`}>
                  {snaps.length === 0 ? (
                    "—"
                  ) : liveCount === snaps.length ? (
                    <Link href={`/reports/${snaps[0].id}`} className="hover:underline">
                      ✓ live
                    </Link>
                  ) : liveCount > 0 ? (
                    `${liveCount}/${snaps.length} live`
                  ) : (
                    <Link href={`/snapshots/${snaps[0].id}`} className="hover:underline">
                      publish →
                    </Link>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── cycle block ───────────────────────────────────────────────────────────────

function CycleBlock({
  cycle,
  label,
  agg,
  groups,
  news,
  dim,
}: {
  cycle: string;
  label: string;
  agg: WeekAggregate;
  groups: GroupCycleStatus[];
  news?: NewsOverview | null;
  dim?: boolean;
}) {
  return (
    <div className={`mb-5 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm ${dim ? "opacity-60" : ""}`}>
      <div className="flex items-center gap-2 border-b border-zinc-100 px-5 py-2.5">
        <span className="font-mono text-sm font-semibold text-zinc-700">{cycle}</span>
        <span className="text-xs text-zinc-400">{label}</span>
        {agg.totalGroupCount > 0 && (
          <span className="ml-auto text-xs text-zinc-400">
            {agg.liveGroupCount}/{agg.totalGroupCount} groups live
          </span>
        )}
      </div>
      <WeekStrip agg={agg} news={news ?? null} cycle={cycle} />
      <GroupTable groups={groups} />
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

  const [{ n: groupCount }] = await getDb().select({ n: count() }).from(runGroups);
  const total = groupCount ?? 0;

  const [currentGroups, priorGroups, currentAgg, priorAgg, newsOverview] = await Promise.all([
    getCycleGroupStatus(currentCycle),
    getCycleGroupStatus(priorCycle),
    getWeekAggregate(currentCycle, total),
    getWeekAggregate(priorCycle, total),
    isNewsConfigured() ? fetchNewsOverview() : Promise.resolve(null),
  ]);

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-zinc-900">Weekly Ops</h1>
        <div className="flex items-center gap-4 text-sm text-zinc-500">
          <Link href="/runs" className="hover:text-zinc-900">Runs</Link>
          <Link href="/snapshots" className="hover:text-zinc-900">Snapshots</Link>
          <Link href="/reports" className="hover:text-zinc-900">Reports</Link>
        </div>
      </div>

      <CycleBlock
        cycle={currentCycle}
        label="Current Cycle"
        agg={currentAgg}
        groups={currentGroups}
        news={newsOverview}
      />

      <CycleBlock
        cycle={priorCycle}
        label="Prior Cycle"
        agg={priorAgg}
        groups={priorGroups}
        dim
      />
    </div>
  );
}
