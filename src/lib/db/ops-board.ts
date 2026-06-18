import { asc, desc, eq, inArray } from "drizzle-orm";
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

export async function getCycleGroupStatus(cycle: string): Promise<GroupCycleStatus[]> {
  const db = getDb();

  const groups = await db
    .select({ id: runGroups.id, name: runGroups.name })
    .from(runGroups)
    .orderBy(asc(runGroups.name));

  if (groups.length === 0) return [];
  const groupIds = groups.map((g) => g.id);

  const cycleRuns = await db
    .select()
    .from(collectionRuns)
    .where(eq(collectionRuns.cycle, cycle))
    .orderBy(desc(collectionRuns.createdAt));

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

  // runId → offer count
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

  // groupId → best run for this cycle (prefer complete > review > running > pending > failed)
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

  // groupId → snapshots
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
