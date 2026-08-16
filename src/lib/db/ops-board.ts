import { and, asc, desc, gte, inArray, lte } from "drizzle-orm";
import { getDb } from "./index";
import {
  collectionRuns,
  collectionRunSites,
  evidence,
  missionResults,
  offers,
  reportSnapshots,
  runGroups,
  type RunStatus,
} from "./schema";
import { getSiteIdsForRunGroups } from "./repository";
import { getISOWeekBounds } from "@/lib/cycle";

export type RunSummary = {
  id: string;
  status: RunStatus;
  doneMissions: number;
  totalMissions: number;
  /** Evidence pages captured, summed over this group's member sites only
   *  (an ad-hoc run's sites can span more than one group — see
   *  `getCycleGroupStatus`). */
  pageCount: number;
  /** Ads found, summed over this group's member sites only — same caveat. */
  offerCount: number;
  analysisRunning: boolean;
  analysisDone: boolean;
};

export type SnapshotSummary = {
  id: string;
  clientVisible: boolean;
  offerCount: number;
};

export type GroupCycleStatus = {
  groupId: string;
  groupName: string;
  run: RunSummary | null;
  snapshots: SnapshotSummary[];
};

export type WeekAggregate = {
  doneMissions: number;
  totalMissions: number;
  collectRunning: boolean;
  anyRunComplete: boolean;
  offerCount: number;
  analysisRunning: boolean;
  analysisDone: boolean;
  frozenGroupCount: number;
  liveGroupCount: number;
  totalGroupCount: number;
  latestRunId: string | null;
};

/** Query runs that belong to a given ISO week (by createdAt date range). */
async function getRunsForWeek(weekLabel: string) {
  const { start, end } = getISOWeekBounds(weekLabel);
  return getDb()
    .select()
    .from(collectionRuns)
    .where(and(gte(collectionRuns.createdAt, start), lte(collectionRuns.createdAt, end)))
    .orderBy(desc(collectionRuns.createdAt));
}

/** Per-group pipeline status for a given ISO week. */
export async function getCycleGroupStatus(weekLabel: string): Promise<GroupCycleStatus[]> {
  const db = getDb();

  const groups = await db
    .select({ id: runGroups.id, name: runGroups.name })
    .from(runGroups)
    .orderBy(asc(runGroups.name));

  if (groups.length === 0) return [];
  const groupIds = groups.map((g) => g.id);

  const cycleRuns = await getRunsForWeek(weekLabel);

  if (cycleRuns.length === 0) {
    return groups.map((g) => ({ groupId: g.id, groupName: g.name, run: null, snapshots: [] }));
  }

  const runIds = cycleRuns.map((r) => r.id);

  const [allMissionResults, allEvidence, allOffers, snapshots, adHocSiteRows, allMembers] = await Promise.all([
    db
      .select({ runId: missionResults.collectionRunId, siteId: missionResults.siteId, status: missionResults.status })
      .from(missionResults)
      .where(inArray(missionResults.collectionRunId, runIds)),
    db
      .select({ runId: evidence.collectionRunId, siteId: evidence.siteId })
      .from(evidence)
      .where(inArray(evidence.collectionRunId, runIds)),
    db
      .select({ runId: offers.collectionRunId, siteId: offers.siteId })
      .from(offers)
      .where(inArray(offers.collectionRunId, runIds)),
    db
      .select({
        id: reportSnapshots.id,
        runGroupId: reportSnapshots.runGroupId,
        clientVisible: reportSnapshots.clientVisible,
        offerCount: reportSnapshots.offerCount,
      })
      .from(reportSnapshots)
      .where(inArray(reportSnapshots.collectionRunId, runIds)),
    (async () => {
      const adHocIds = cycleRuns.filter((r) => !r.runGroupId).map((r) => r.id);
      return adHocIds.length > 0
        ? db
            .select({ runId: collectionRunSites.collectionRunId, siteId: collectionRunSites.siteId })
            .from(collectionRunSites)
            .where(inArray(collectionRunSites.collectionRunId, adHocIds))
        : [];
    })(),
    getSiteIdsForRunGroups(groupIds),
  ]);

  // The hierarchy is runs -> groups -> sites -> pages/ads. A shared ad-hoc
  // run's sites can span more than one group, so group-level totals can't
  // just read a run's raw counts — they have to be built by summing
  // per-(run, site) numbers over that group's own member sites. This map is
  // the one source of truth every group total is derived from.
  type SiteMetrics = { missionsTotal: number; missionsDone: number; pages: number; ads: number };
  const runSiteMetrics = new Map<string, Map<string, SiteMetrics>>(); // runId -> siteId -> metrics
  function bump(runId: string, siteId: string, patch: Partial<SiteMetrics>) {
    const bySite = runSiteMetrics.get(runId) ?? new Map<string, SiteMetrics>();
    const cur = bySite.get(siteId) ?? { missionsTotal: 0, missionsDone: 0, pages: 0, ads: 0 };
    cur.missionsTotal += patch.missionsTotal ?? 0;
    cur.missionsDone += patch.missionsDone ?? 0;
    cur.pages += patch.pages ?? 0;
    cur.ads += patch.ads ?? 0;
    bySite.set(siteId, cur);
    runSiteMetrics.set(runId, bySite);
  }
  for (const mr of allMissionResults) {
    bump(mr.runId, mr.siteId, {
      missionsTotal: 1,
      missionsDone: mr.status !== "pending" && mr.status !== "running" ? 1 : 0,
    });
  }
  for (const e of allEvidence) bump(e.runId, e.siteId, { pages: 1 });
  for (const o of allOffers) bump(o.runId, o.siteId, { ads: 1 });

  // siteId → groupIds (for resolving which group(s) an ad-hoc run's sites belong to)
  const siteToGroups = new Map<string, Set<string>>();
  for (const m of allMembers) {
    const s = siteToGroups.get(m.siteId) ?? new Set();
    s.add(m.groupId);
    siteToGroups.set(m.siteId, s);
  }

  // groupId → member siteIds (for filtering a shared run's totals down to
  // just this group's own sites)
  const groupToSites = new Map<string, Set<string>>();
  for (const m of allMembers) {
    const s = groupToSites.get(m.groupId) ?? new Set();
    s.add(m.siteId);
    groupToSites.set(m.groupId, s);
  }

  // adHoc runId → groupIds (via site membership)
  const adHocRunToGroups = new Map<string, Set<string>>();
  for (const row of adHocSiteRows) {
    const gids = siteToGroups.get(row.siteId);
    if (!gids) continue;
    const s = adHocRunToGroups.get(row.runId) ?? new Set();
    for (const gid of gids) s.add(gid);
    adHocRunToGroups.set(row.runId, s);
  }

  const priority = (s: RunStatus) =>
    ({ complete: 4, review: 3, running: 2, paused: 2, pending: 1, failed: 0 }[s] ?? 0);

  const groupToRun = new Map<string, (typeof cycleRuns)[0]>();
  const tryAssign = (gid: string, run: (typeof cycleRuns)[0]) => {
    const existing = groupToRun.get(gid);
    if (!existing || priority(run.status) > priority(existing.status))
      groupToRun.set(gid, run);
  };
  for (const run of cycleRuns) {
    if (run.runGroupId) {
      tryAssign(run.runGroupId, run);
    } else {
      const gids = adHocRunToGroups.get(run.id);
      if (gids) for (const gid of gids) tryAssign(gid, run);
    }
  }

  const groupToSnapshots = new Map<string, SnapshotSummary[]>();
  for (const snap of snapshots) {
    if (!snap.runGroupId) continue;
    const list = groupToSnapshots.get(snap.runGroupId) ?? [];
    list.push({ id: snap.id, clientVisible: snap.clientVisible, offerCount: snap.offerCount });
    groupToSnapshots.set(snap.runGroupId, list);
  }

  return groups.map((g) => {
    const run = groupToRun.get(g.id) ?? null;
    if (!run) {
      return { groupId: g.id, groupName: g.name, run: null, snapshots: groupToSnapshots.get(g.id) ?? [] };
    }

    const memberSites = groupToSites.get(g.id) ?? new Set<string>();
    const bySite = runSiteMetrics.get(run.id) ?? new Map<string, SiteMetrics>();
    let doneMissions = 0, totalMissions = 0, pageCount = 0, offerCount = 0;
    for (const [siteId, m] of bySite) {
      if (!memberSites.has(siteId)) continue; // exclude other groups' sites on a shared ad-hoc run
      doneMissions += m.missionsDone;
      totalMissions += m.missionsTotal;
      pageCount += m.pages;
      offerCount += m.ads;
    }

    return {
      groupId: g.id,
      groupName: g.name,
      run: {
        id: run.id,
        status: run.status,
        doneMissions,
        totalMissions,
        pageCount,
        offerCount,
        analysisRunning: run.analysisStartedAt !== null && run.analysisCompletedAt === null,
        analysisDone: run.analysisCompletedAt !== null,
      },
      snapshots: groupToSnapshots.get(g.id) ?? [],
    };
  });
}

// ---------------------------------------------------------------------------
// Pure summary reducers — operate on already-fetched GroupCycleStatus[], no
// DB access, so any page that's already called getCycleGroupStatus (home
// page, and eventually /runs) can derive the same numbers without a second
// round trip or a second, possibly-inconsistent query.
// ---------------------------------------------------------------------------

export type CollectCoverage = {
  total: number;
  passing: number;
  failing: number;
  running: number;
  notStarted: number;
};

/** Buckets each group's collection status for the week. "Passing" mirrors
 *  the same complete/review definition used elsewhere (e.g. the home page's
 *  exceptions list) for whether a group's collection is considered done. */
export function summarizeCollectCoverage(groups: GroupCycleStatus[]): CollectCoverage {
  let passing = 0, failing = 0, running = 0, notStarted = 0;
  for (const g of groups) {
    const status = g.run?.status;
    if (status === "complete" || status === "review") passing++;
    else if (status === "failed") failing++;
    else if (status === "running") running++;
    else notStarted++; // no run yet, or still pending
  }
  return { total: groups.length, passing, failing, running, notStarted };
}

export type AnalyzeCoverage = {
  total: number;
  analyzed: number;
  analyzing: number;
  notAnalyzed: number;
  /** Sums of each group's own pageCount/offerCount — informational totals,
   *  not a completion measure (a fully-analyzed week can still find 0 ads). */
  pageCount: number;
  offerCount: number;
};

export function summarizeAnalyzeCoverage(groups: GroupCycleStatus[]): AnalyzeCoverage {
  let analyzed = 0, analyzing = 0, pageCount = 0, offerCount = 0;
  for (const g of groups) {
    if (g.run?.analysisDone) analyzed++;
    else if (g.run?.analysisRunning) analyzing++;
    pageCount += g.run?.pageCount ?? 0;
    offerCount += g.run?.offerCount ?? 0;
  }
  return { total: groups.length, analyzed, analyzing, notAnalyzed: groups.length - analyzed - analyzing, pageCount, offerCount };
}

/** Aggregate pipeline status across all runs in a given ISO week. */
export async function getWeekAggregate(weekLabel: string, totalGroupCount: number): Promise<WeekAggregate> {
  const db = getDb();
  const cycleRuns = await getRunsForWeek(weekLabel);

  if (cycleRuns.length === 0) {
    return {
      doneMissions: 0, totalMissions: 0, collectRunning: false, anyRunComplete: false,
      offerCount: 0, analysisRunning: false, analysisDone: false,
      frozenGroupCount: 0, liveGroupCount: 0, totalGroupCount,
      latestRunId: null,
    };
  }

  const runIds = cycleRuns.map((r) => r.id);

  const [allMR, allOffers, allSnaps] = await Promise.all([
    db
      .select({ runId: missionResults.collectionRunId, status: missionResults.status })
      .from(missionResults)
      .where(inArray(missionResults.collectionRunId, runIds)),
    db
      .select({ runId: offers.collectionRunId })
      .from(offers)
      .where(inArray(offers.collectionRunId, runIds)),
    db
      .select({ runGroupId: reportSnapshots.runGroupId, clientVisible: reportSnapshots.clientVisible })
      .from(reportSnapshots)
      .where(inArray(reportSnapshots.collectionRunId, runIds)),
  ]);

  let doneMissions = 0, totalMissions = 0;
  for (const mr of allMR) {
    totalMissions++;
    if (mr.status !== "pending" && mr.status !== "running") doneMissions++;
  }

  const offerCount = allOffers.length;
  const collectRunning = cycleRuns.some((r) => r.status === "running");
  const anyRunComplete = cycleRuns.some((r) => r.status === "complete" || r.status === "review");
  const analysisRunning = cycleRuns.some((r) => r.analysisStartedAt !== null && r.analysisCompletedAt === null);
  const analysisDone = cycleRuns.some((r) => r.analysisCompletedAt !== null);

  const frozenGroups = new Set(allSnaps.map((s) => s.runGroupId).filter(Boolean));
  const liveGroups = new Set(allSnaps.filter((s) => s.clientVisible).map((s) => s.runGroupId).filter(Boolean));

  return {
    doneMissions,
    totalMissions,
    collectRunning,
    anyRunComplete,
    offerCount,
    analysisRunning,
    analysisDone,
    frozenGroupCount: frozenGroups.size,
    liveGroupCount: liveGroups.size,
    totalGroupCount,
    latestRunId: cycleRuns[0]?.id ?? null,
  };
}
