import Link from "next/link";
import { isDatabaseConfigured, getDb, runGroups } from "@/lib/db";
import { count } from "drizzle-orm";
import { getISOWeekLabel, getPriorISOWeekLabel } from "@/lib/cycle";
import {
  getCycleGroupStatus,
  getWeekAggregate,
  summarizeCollectCoverage,
  summarizeAnalyzeCoverage,
  type GroupCycleStatus,
  type WeekAggregate,
} from "@/lib/db/ops-board";
import { getLocalNewsPullStatus, isNewsConfigured } from "@/lib/news";
import { getInventoryFreshnessStatus, isInventoryConfigured } from "@/lib/inventory";
import { getActiveInventoryBatch, getInventoryBatchStatus } from "@/lib/inventory-batch";
import { refreshNews } from "./actions";

export const dynamic = "force-dynamic";

/** Joins non-empty detail fragments with "·", e.g. ["11 of 14 groups", "2 failed", null] → "11 of 14 groups · 2 failed". */
function joinDetail(parts: (string | null | false)[]): string {
  return parts.filter((p): p is string => Boolean(p)).join(" · ");
}

// ── step dot ──────────────────────────────────────────────────────────────────

function StepDot({ state, n }: { state: "done" | "active" | "action" | "waiting"; n: number }) {
  if (state === "done")
    return (
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-emerald-300 bg-emerald-50 text-emerald-600">
        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
        </svg>
      </div>
    );
  if (state === "active")
    return (
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-blue-300 bg-blue-50 text-sm font-medium text-blue-600">
        …
      </div>
    );
  if (state === "action")
    return (
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-zinc-300 bg-white text-sm font-medium text-zinc-800">
        {n}
      </div>
    );
  return (
    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-zinc-100 bg-zinc-50 text-sm font-medium text-zinc-600">
      {n}
    </div>
  );
}

// ── step ──────────────────────────────────────────────────────────────────────

function Step({
  n,
  label,
  state,
  detail,
  isLast,
  children,
}: {
  n: number;
  label: string;
  state: "done" | "active" | "action" | "waiting";
  detail: string;
  isLast?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-1 items-start gap-3">
      <div className="flex flex-col items-center gap-1">
        <StepDot state={state} n={n} />
        {!isLast && <div className="h-full w-px bg-zinc-100" style={{ minHeight: 32 }} />}
      </div>
      <div className="pb-8">
        <p className={`text-sm font-medium ${state === "waiting" ? "text-zinc-600" : "text-zinc-800"}`}>
          {label}
        </p>
        <p className={`mt-0.5 text-sm ${
          state === "done" ? "text-emerald-600"
          : state === "active" ? "text-blue-600"
          : state === "action" ? "text-amber-700 font-medium"
          : "text-zinc-600"
        }`}>
          {detail}
        </p>
        {children}
      </div>
    </div>
  );
}

// ── exception list ────────────────────────────────────────────────────────────

function Exceptions({ groups, weekLabel }: { groups: GroupCycleStatus[]; weekLabel: string }) {
  const issues: { groupId: string; groupName: string; reason: string; href: string }[] = [];

  for (const g of groups) {
    const run = g.run;
    const snaps = g.snapshots;
    const collectDone = run?.status === "complete" || run?.status === "review";
    const analyzeDone = run?.analysisDone && (run?.offerCount ?? 0) > 0;
    const live = snaps.some((s) => s.clientVisible);

    if (!run || !collectDone) {
      issues.push({ groupId: g.groupId, groupName: g.groupName, reason: "not collected", href: "/runs" });
    } else if (!analyzeDone && !run.analysisRunning) {
      issues.push({ groupId: g.groupId, groupName: g.groupName, reason: "not analyzed", href: `/runs/${run.id}` });
    } else if (snaps.length === 0) {
      issues.push({ groupId: g.groupId, groupName: g.groupName, reason: "not frozen", href: `/runs/${run.id}` });
    } else if (!live) {
      issues.push({ groupId: g.groupId, groupName: g.groupName, reason: "not published", href: `/snapshots/${snaps[0].id}` });
    }
  }

  if (issues.length === 0) return null;

  return (
    <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-amber-700">
        Needs attention
      </p>
      <div className="space-y-1">
        {issues.map((issue) => (
          <div key={issue.groupId} className="flex items-center justify-between text-sm">
            <span className="text-amber-800">{issue.groupName}</span>
            <Link href={issue.href} className="text-amber-600 hover:underline">
              {issue.reason} →
            </Link>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── primary cta ───────────────────────────────────────────────────────────────

function PrimaryCTA({
  agg,
  collectDone,
  analyzeDone,
  newsPulled,
}: {
  agg: WeekAggregate;
  collectDone: boolean;
  analyzeDone: boolean;
  newsPulled: boolean;
}) {
  const newsDone = newsPulled || !isNewsConfigured();
  const allFrozen = agg.frozenGroupCount >= agg.totalGroupCount && agg.totalGroupCount > 0;
  const allLive = agg.liveGroupCount >= agg.totalGroupCount && agg.totalGroupCount > 0;

  if (agg.collectRunning || agg.analysisRunning) {
    return (
      <Link
        href={agg.latestRunId ? `/runs/${agg.latestRunId}` : "/runs"}
        className="block rounded-xl bg-blue-600 px-6 py-4 text-center text-base font-medium text-white hover:bg-blue-700"
      >
        Running — view progress →
      </Link>
    );
  }

  if (!collectDone) {
    return (
      <Link
        href="/runs"
        className="block rounded-xl bg-zinc-900 px-6 py-4 text-center text-base font-medium text-white hover:bg-zinc-700"
      >
        Start this week's collection →
      </Link>
    );
  }

  if (!analyzeDone) {
    return (
      <Link
        href={agg.latestRunId ? `/runs/${agg.latestRunId}` : "/runs"}
        className="block rounded-xl bg-zinc-900 px-6 py-4 text-center text-base font-medium text-white hover:bg-zinc-700"
      >
        Run analysis →
      </Link>
    );
  }

  if (!newsDone) {
    return (
      <form action={refreshNews}>
        <button
          type="submit"
          className="block w-full rounded-xl bg-zinc-900 px-6 py-4 text-center text-base font-medium text-white hover:bg-zinc-700"
        >
          Pull news →
        </button>
      </form>
    );
  }

  if (!allFrozen) {
    return (
      <Link
        href={agg.latestRunId ? `/runs/${agg.latestRunId}` : "/runs"}
        className="block rounded-xl bg-zinc-900 px-6 py-4 text-center text-base font-medium text-white hover:bg-zinc-700"
      >
        Freeze reports →
      </Link>
    );
  }

  if (!allLive) {
    return (
      <Link
        href="/snapshots"
        className="block rounded-xl bg-zinc-900 px-6 py-4 text-center text-base font-medium text-white hover:bg-zinc-700"
      >
        Publish reports →
      </Link>
    );
  }

  return (
    <Link
      href="/reports"
      className="block rounded-xl bg-emerald-600 px-6 py-4 text-center text-base font-medium text-white hover:bg-emerald-700"
    >
      View reports →
    </Link>
  );
}

// ── page ──────────────────────────────────────────────────────────────────────

export default async function HomePage() {
  if (!isDatabaseConfigured()) {
    return (
      <div className="flex min-h-64 items-center justify-center rounded-xl border border-dashed border-zinc-200 bg-white p-8 text-center text-sm text-zinc-700">
        Database not configured.
      </div>
    );
  }

  const currentCycle = getISOWeekLabel();
  const priorCycle = getPriorISOWeekLabel(currentCycle);

  const [{ n: groupCount }] = await getDb().select({ n: count() }).from(runGroups);
  const total = groupCount ?? 0;

  const [currentGroups, priorGroups, currentAgg, priorAgg, newsPullStatus, inventoryStatus, activeInventoryBatch] = await Promise.all([
    getCycleGroupStatus(currentCycle),
    getCycleGroupStatus(priorCycle),
    getWeekAggregate(currentCycle, total),
    getWeekAggregate(priorCycle, total),
    isNewsConfigured() ? getLocalNewsPullStatus() : Promise.resolve(null),
    isInventoryConfigured() ? getInventoryFreshnessStatus() : Promise.resolve(null),
    isInventoryConfigured() ? Promise.resolve(getActiveInventoryBatch()) : Promise.resolve(null),
  ]);

  // Inventory batches run in the background independent of the weekly
  // collect/analyze pipeline (see inventory-batch.ts), so their live progress
  // comes from the in-memory batch registry, not `currentAgg`.
  const inventoryProgress = activeInventoryBatch
    ? await getInventoryBatchStatus(activeInventoryBatch.batchId).then((s) => ({
        done: Object.keys(s.results).length,
        total: s.siteIds.length,
      }))
    : null;

  // Coverage is group-based for collect/analyze (the "hierarchy" is
  // runs -> groups -> sites -> pages/ads — see summarizeCollectCoverage /
  // summarizeAnalyzeCoverage in ops-board.ts) and dealer-based for
  // inventory, since inventory isn't scoped by group.
  const collectCoverage = summarizeCollectCoverage(currentGroups);
  const analyzeCoverage = summarizeAnalyzeCoverage(currentGroups);

  // "Done" means nothing is left un-attempted this week — it does not mean
  // zero failures. Failures/running are called out separately in the detail
  // text below rather than blocking the step from reading as done.
  const collectDone = collectCoverage.total > 0 && collectCoverage.notStarted === 0;
  const collectActive = collectCoverage.running > 0;
  const analyzeDone = analyzeCoverage.total > 0 && analyzeCoverage.notAnalyzed === 0;
  const analyzeActive = analyzeCoverage.analyzing > 0;
  const newsDone = newsPullStatus !== null || !isNewsConfigured();
  const inventoryActive = activeInventoryBatch !== null;
  const inventoryDone =
    !isInventoryConfigured() ||
    (inventoryStatus !== null &&
      inventoryStatus.totalActiveSites > 0 &&
      inventoryStatus.okCount + inventoryStatus.failedCount >= inventoryStatus.totalActiveSites);
  const allFrozen = currentAgg.frozenGroupCount >= total && total > 0;
  const allLive = currentAgg.liveGroupCount >= total && total > 0;

  // Collection, analysis, news, and inventory are independent processes —
  // none of them actually requires another to finish first (inventory and
  // news don't touch collection/analysis data at all), so none of these
  // steps block on each other anymore. Only "Reports live" genuinely depends
  // on the others being settled.
  const collectState = collectActive ? "active" : collectDone ? "done" : "action";
  const analyzeState = collectCoverage.passing === 0 ? "waiting" : analyzeActive ? "active" : analyzeDone ? "done" : "action";
  const newsState = newsDone ? "done" : "action";
  const inventoryState = inventoryActive ? "active" : inventoryDone ? "done" : "action";
  const reportsState = (!newsDone || !inventoryDone) ? "waiting" : allLive ? "done" : allFrozen ? "action" : currentAgg.frozenGroupCount > 0 ? "action" : "waiting";

  // Prior cycle summary
  const priorAllLive = priorAgg.liveGroupCount >= total && total > 0 && priorAgg.liveGroupCount > 0;
  const priorIssues = priorGroups.filter(
    (g) => !g.snapshots.some((s) => s.clientVisible) && (g.run !== null || priorAgg.anyRunComplete)
  );

  return (
    <div className="mx-auto max-w-lg">
      {/* Week label */}
      <div className="mb-6 flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900">
            {allLive ? "This week is done ✓" : "What needs doing"}
          </h1>
          <p className="mt-0.5 text-sm text-zinc-700 font-mono">{currentCycle}</p>
        </div>
        <Link href="/runs" className="text-xs text-zinc-700 hover:text-zinc-700">
          Advanced →
        </Link>
      </div>

      {/* Steps */}
      <div className="mb-6 flex flex-col rounded-xl border border-zinc-200 bg-white px-6 pt-6">
        <Step n={1} label="Collect data" state={collectState}
          detail={
            collectCoverage.total === 0
              ? "No groups configured"
              : collectCoverage.passing + collectCoverage.failing + collectCoverage.running === 0
                ? "Not started this week"
                : joinDetail([
                    `${collectCoverage.passing} of ${collectCoverage.total} groups collected`,
                    collectCoverage.failing > 0 ? `${collectCoverage.failing} failed` : null,
                    collectCoverage.running > 0 ? `${collectCoverage.running} running` : null,
                  ])
          } />
        <Step n={2} label="Analyze offers" state={analyzeState}
          detail={
            collectCoverage.passing === 0
              ? "—"
              : joinDetail([
                  `${analyzeCoverage.analyzed} of ${analyzeCoverage.total} groups analyzed`,
                  analyzeCoverage.analyzing > 0 ? `${analyzeCoverage.analyzing} running` : null,
                  (analyzeCoverage.pageCount > 0 || analyzeCoverage.offerCount > 0)
                    ? `${analyzeCoverage.pageCount} pages → ${analyzeCoverage.offerCount} ads found`
                    : null,
                ])
          } />
        <Step n={3} label="Load news" state={newsState}
          detail={
            newsPullStatus
              ? `Last pulled ${newsPullStatus.pulledAt.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · ${newsPullStatus.itemCount} items`
              : "Not pulled this week"
          }>
          {isNewsConfigured() && (
            <form action={refreshNews} className="mt-1.5">
              <button type="submit" className="text-xs text-zinc-700 hover:text-zinc-600 underline underline-offset-2">
                Refresh
              </button>
            </form>
          )}
        </Step>
        {isInventoryConfigured() && (
          <Step n={4} label="Run inventory" state={inventoryState}
            detail={
              inventoryActive
                ? `Running — ${inventoryProgress?.done ?? 0} of ${inventoryProgress?.total ?? 0} dealers`
                : inventoryStatus?.ranThisWeek
                  ? joinDetail([
                      `${inventoryStatus.okCount} of ${inventoryStatus.totalActiveSites} dealers`,
                      inventoryStatus.failedCount > 0 ? `${inventoryStatus.failedCount} failed` : null,
                      `last run ${inventoryStatus.lastRunAt?.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`,
                    ])
                  : "Not run this week"
            }>
            <Link href="/inventory" className="mt-1.5 inline-block text-xs text-zinc-700 hover:text-zinc-600 underline underline-offset-2">
              {inventoryActive ? "View progress →" : "Go to inventory →"}
            </Link>
          </Step>
        )}
        <Step n={isInventoryConfigured() ? 5 : 4} label="Reports live" state={reportsState} isLast
          detail={
            !newsDone ? "—"
            : allLive ? `${currentAgg.liveGroupCount} of ${total} groups live`
            : allFrozen ? "Ready to publish"
            : currentAgg.frozenGroupCount > 0 ? `${currentAgg.frozenGroupCount} of ${total} frozen`
            : "Not frozen yet"
          } />
      </div>

      {/* Primary CTA */}
      <PrimaryCTA agg={currentAgg} collectDone={collectDone} analyzeDone={analyzeDone} newsPulled={newsDone} />

      {/* Exceptions */}
      {!allLive && <Exceptions groups={currentGroups} weekLabel={currentCycle} />}

      {/* Prior week */}
      <div className="mt-8 flex items-center gap-3 border-t border-zinc-100 pt-5">
        <div className={`h-2 w-2 shrink-0 rounded-full ${priorAllLive ? "bg-emerald-400" : "bg-amber-400"}`} />
        <span className="text-sm text-zinc-700">
          {priorCycle}
          {priorAllLive
            ? " — complete"
            : priorIssues.length > 0
              ? ` — ${priorIssues.length} group${priorIssues.length > 1 ? "s" : ""} not published`
              : " — no runs"}
        </span>
        {!priorAllLive && priorIssues.length > 0 && (
          <Link href="/snapshots" className="ml-auto text-xs text-zinc-700 hover:text-zinc-700">
            Fix →
          </Link>
        )}
      </div>
    </div>
  );
}
