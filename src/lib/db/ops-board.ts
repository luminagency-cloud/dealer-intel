import { and, asc, desc, gte, inArray, lte } from "drizzle-orm";
import { getDb } from "./index";
import {
  collectionRuns,
  collectionRunSites,
  missionResults,
  offers,
  reportSnapshots,
  runGroupMembers,
  runGroups,
  type RunStatus,
} from "./schema";
import { getISOWeekBounds } from "@/lib/cycle";

export type RunSummary = {
  id: string;
  status: RunStatus;
  doneMissions: number;
  totalMissions: number;
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

  const [allMissionResults, allOffers, snapshots, adHocSiteRows, allMembers] = await Promise.all([
    db
      .select({ runId: missionResults.collectionRunId, status: missionResults.status })
      .from(missionResults)
      .where(inArray(missionResults.collectionRunId, runIds)),
    db
      .select({ runId: offers.collectionRunId })
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
    db
      .select({ groupId: runGroupMembers.runGroupId, siteId: runGroupMembers.siteId })
      .from(runGroupMembers)
      .where(inArray(runGroupMembers.runGroupId, groupIds)),
  ]);

  // runId → { total, done }
  const missionMap = new Map<string, { total: number; done: number }>();
  for (const mr of allMissionResults) {
    const e = missionMap.get(mr.runId) ?? { total: 0, done: 0 };
    e.total++;
    if (mr.status !== "pending" && mr.status !== "running") e.done++;
    missionMap.set(mr.runId, e);
  }

  const offerMap = new Map<string, number>();
  for (const o of allOffers) offerMap.set(o.runId, (offerMap.get(o.runId) ?? 0) + 1);

  // siteId → groupIds
  const siteToGroups = new Map<string, Set<string>>();
  for (const m of allMembers) {
    const s = siteToGroups.get(m.siteId) ?? new Set();
    s.add(m.groupId);
    siteToGroups.set(m.siteId, s);
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
    ({ complete: 4, review: 3, running: 2, pending: 1, failed: 0 }[s] ?? 0);

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
    const mc = run ? (missionMap.get(run.id) ?? { total: 0, done: 0 }) : null;
    return {
      groupId: g.id,
      groupName: g.name,
      run: run
        ? {
            id: run.id,
            status: run.status,
            doneMissions: mc!.done,
            totalMissions: mc!.total,
            offerCount: offerMap.get(run.id) ?? 0,
            analysisRunning: run.analysisStartedAt !== null && run.analysisCompletedAt === null,
            analysisDone: run.analysisCompletedAt !== null,
          }
        : null,
      snapshots: groupToSnapshots.get(g.id) ?? [],
    };
  });
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
