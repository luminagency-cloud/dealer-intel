"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  createCollectionRun,
  getCollectionRun,
  updateCollectionRunStatus,
} from "@/lib/db/repository";
import { removeEvidence, uploadEvidence } from "@/lib/evidence";
import {
  forceReCollectSingle,
  markContentRemoved,
  requeueStalledRun,
  retryMissionResult,
  startRunExecution,
} from "@/lib/run-executor";
import { startAnalysis, startAnalysisForSiteMission } from "@/lib/analysis";
import { createSnapshotFromRun } from "@/lib/snapshot";
import { deleteRunDeep } from "@/lib/deep-delete";
import {
  collectionRunMissions,
  collectionRunSites,
  evidenceTypeEnum,
  getDb,
  missionTypeEnum,
  missions,
  runGroupMembers,
  runGroups,
  type EvidenceType,
  type MissionType,
  type RunStatus,
} from "@/lib/db";
import { eq, inArray } from "drizzle-orm";
import { resolveRunGroups } from "@/lib/db/repository";
import { RUN_TRANSITIONS } from "@/lib/run-lifecycle";
import { requireSession } from "@/lib/session";
import { getISOWeekLabel } from "@/lib/cycle";

export async function createRun(formData?: FormData) {
  await requireSession();
  // Scope select encodes "all-groups" (every group combined), "groups"
  // (multi-group checkboxes in groupIds), or "custom" (ad-hoc dealer checkboxes).
  const scopeValue = formData?.get("scope");
  const scope = typeof scopeValue === "string" ? scopeValue : "all-groups";

  let siteIds: string[] = [];

  if (scope === "custom") {
    siteIds =
      formData
        ?.getAll("siteIds")
        .filter((v): v is string => typeof v === "string" && v.length > 0) ??
      [];
    if (siteIds.length === 0) {
      redirect(`/runs?error=${encodeURIComponent("Pick at least one dealer")}`);
    }
  }

  // For "all-groups" scope: load every group, mirror the "groups" path.
  let resolvedRunGroupIdFromAllGroups: string | null = null;
  if (scope === "all-groups") {
    const allGroups = await getDb().select({ id: runGroups.id }).from(runGroups);
    if (allGroups.length === 0) {
      redirect(`/runs?error=${encodeURIComponent("No groups defined — create a group before running")}`);
    }
    if (allGroups.length === 1) {
      resolvedRunGroupIdFromAllGroups = allGroups[0].id;
    } else {
      const members = await getDb()
        .select({ siteId: runGroupMembers.siteId })
        .from(runGroupMembers);
      siteIds = [...new Set(members.map((m) => m.siteId))];
      if (siteIds.length === 0) {
        redirect(`/runs?error=${encodeURIComponent("Groups have no member sites")}`);
      }
    }
  }

  // For "groups" scope: resolve selected groups to site IDs.
  // Single group → store as runGroupId (preserves reporting group history).
  // Multiple groups → expand to site IDs and store as ad-hoc collectionRunSites.
  let resolvedRunGroupId: string | null = null;
  if (scope === "groups") {
    const groupIds =
      formData
        ?.getAll("groupIds")
        .filter((v): v is string => typeof v === "string" && v.length > 0) ??
      [];
    if (groupIds.length === 0) {
      redirect(`/runs?error=${encodeURIComponent("Pick at least one group")}`);
    }
    if (groupIds.length === 1) {
      resolvedRunGroupId = groupIds[0];
    } else {
      const members = await getDb()
        .select({ siteId: runGroupMembers.siteId })
        .from(runGroupMembers)
        .where(inArray(runGroupMembers.runGroupId, groupIds));
      siteIds = [...new Set(members.map((m) => m.siteId))];
      if (siteIds.length === 0) {
        redirect(
          `/runs?error=${encodeURIComponent("Selected groups have no member sites")}`
        );
      }
    }
  }

  // Mission checkboxes: storing a subset restricts the run; all checked (or
  // none rendered) means every active mission, stored as no rows.
  const missionIds =
    formData
      ?.getAll("missionIds")
      .filter((v): v is string => typeof v === "string" && v.length > 0) ?? [];
  if (formData?.has("missionPickerShown") && missionIds.length === 0) {
    redirect(`/runs?error=${encodeURIComponent("Pick at least one mission")}`);
  }
  const activeMissionCount = await getDb().$count(
    missions,
    eq(missions.active, true)
  );
  const restrictMissions =
    missionIds.length > 0 && missionIds.length < activeMissionCount;

  const cycleValue = formData?.get("cycle");
  const cycle =
    typeof cycleValue === "string" && cycleValue.trim()
      ? cycleValue.trim()
      : getISOWeekLabel();

  const run = await createCollectionRun({ runGroupId: resolvedRunGroupId ?? resolvedRunGroupIdFromAllGroups, cycle });
  if (siteIds.length > 0) {
    await getDb()
      .insert(collectionRunSites)
      .values(siteIds.map((siteId) => ({ collectionRunId: run.id, siteId })));
  }
  if (restrictMissions) {
    await getDb()
      .insert(collectionRunMissions)
      .values(
        missionIds.map((missionId) => ({ collectionRunId: run.id, missionId }))
      );
  }
  revalidatePath("/runs");

  if (process.env.AUTO_START_RUN === "true") {
    void startRunExecution(run.id).catch((err) => {
      console.error(`AUTO_START_RUN: failed to start run ${run.id}:`, err);
    });
  }

  redirect(`/runs/${run.id}`);
}

export async function deleteRun(runId: string) {
  await requireSession();
  await deleteRunDeep(runId);
  revalidatePath("/runs");
  redirect("/runs");
}

export async function deleteSelectedRuns(formData: FormData) {
  await requireSession();
  const runIds = formData
    .getAll("runIds")
    .filter((value): value is string => typeof value === "string" && value.length > 0);

  if (runIds.length === 0) {
    redirect(`/runs?error=${encodeURIComponent("Pick at least one run to delete")}`);
  }

  for (const runId of runIds) {
    await deleteRunDeep(runId);
  }

  revalidatePath("/runs");
  redirect("/runs");
}

export async function updateRunStatus(id: string, status: RunStatus) {
  await requireSession();
  const run = await getCollectionRun(id);
  if (!run) {
    throw new Error("Run not found");
  }
  if (!RUN_TRANSITIONS[run.status].includes(status)) {
    throw new Error(`Cannot move a ${run.status} run to ${status}`);
  }
  await updateCollectionRunStatus(id, status, {
    ...(status === "running" ? { startedAt: new Date() } : {}),
    ...(status === "review" || status === "failed"
      ? { completedAt: new Date() }
      : {}),
  });
  revalidatePath("/runs");
  revalidatePath(`/runs/${id}`);
}

export async function uploadRunEvidence(runId: string, formData: FormData) {
  await requireSession();
  const run = await getCollectionRun(runId);
  if (!run) {
    throw new Error("Run not found");
  }

  const siteId = formData.get("siteId");
  const missionType = formData.get("missionType");
  const evidenceType = formData.get("evidenceType");
  const file = formData.get("file");

  if (
    typeof siteId !== "string" ||
    !siteId ||
    !missionTypeEnum.enumValues.includes(missionType as MissionType) ||
    !evidenceTypeEnum.enumValues.includes(evidenceType as EvidenceType) ||
    !(file instanceof File) ||
    file.size === 0
  ) {
    throw new Error("Site, mission type, evidence type, and file are required");
  }

  await uploadEvidence({
    collectionRunId: runId,
    siteId,
    missionType: missionType as MissionType,
    evidenceType: evidenceType as EvidenceType,
    fileName: file.name,
    body: new Uint8Array(await file.arrayBuffer()),
  });
  revalidatePath(`/runs/${runId}`);
}

async function requireCollectableRun(runId: string) {
  const run = await getCollectionRun(runId);
  if (!run) {
    throw new Error("Run not found");
  }
  if (run.status !== "pending" && run.status !== "running") {
    throw new Error(`Cannot collect on a ${run.status} run`);
  }
  if (run.status === "pending") {
    await updateCollectionRunStatus(runId, "running", { startedAt: new Date() });
  }
  return run;
}

export async function executeWorkItem(
  runId: string,
  siteId: string,
  missionId: string
) {
  await requireSession();
  await requireCollectableRun(runId);
  const queued = await startRunExecution(runId, [{ siteId, missionId }]);
  revalidatePath(`/runs/${runId}`);
  redirect(
    queued === null
      ? `/runs/${runId}?error=${encodeURIComponent("Run is already executing")}`
      : `/runs/${runId}`
  );
}

export async function executeAllMissions(runId: string) {
  await requireSession();
  await requireCollectableRun(runId);
  const queued = await startRunExecution(runId);
  revalidatePath(`/runs/${runId}`);
  redirect(
    queued === null
      ? `/runs/${runId}?error=${encodeURIComponent("Run is already executing")}`
      : queued === 0
        ? `/runs/${runId}?error=${encodeURIComponent("No active missions")}`
        : `/runs/${runId}`
  );
}

export async function runAnalysis(runId: string) {
  await requireSession();
  const run = await getCollectionRun(runId);
  if (!run) {
    throw new Error("Run not found");
  }
  const queued = await startAnalysis(runId);
  revalidatePath(`/runs/${runId}`);
  redirect(
    queued === null
      ? `/runs/${runId}?error=${encodeURIComponent("Analysis is already running")}`
      : queued === 0
        ? `/runs/${runId}?error=${encodeURIComponent("No evidence to analyze yet — run collection first")}`
        : `/runs/${runId}`
  );
}

export async function resumeAnalysis(runId: string) {
  await requireSession();
  const run = await getCollectionRun(runId);
  if (!run) {
    throw new Error("Run not found");
  }
  const queued = await startAnalysis(runId, { resume: true });
  revalidatePath(`/runs/${runId}`);
  redirect(
    queued === null
      ? `/runs/${runId}?error=${encodeURIComponent("Analysis is already running")}`
      : queued === 0
        ? `/runs/${runId}?error=${encodeURIComponent("No evidence to analyze yet — run collection first")}`
        : `/runs/${runId}`
  );
}

export async function runAnalysisForSiteMission(
  runId: string,
  siteId: string,
  missionType: string
) {
  await requireSession();
  const result = await startAnalysisForSiteMission(
    runId,
    siteId,
    missionType as import("@/lib/db").MissionType
  );
  revalidatePath(`/runs/${runId}`);
  if (result === "busy") {
    redirect(
      `/runs/${runId}?error=${encodeURIComponent("Analysis already running for this run — wait for it to finish")}#collection`
    );
  }
  if (result === "no_evidence") {
    redirect(
      `/runs/${runId}?error=${encodeURIComponent("No evidence to analyze for this dealer + mission")}#collection`
    );
  }
  redirect(`/runs/${runId}#analysis`);
}

/** Phase 10: freeze the run's current analysis output into a report snapshot,
 *  the immutable reporting input. Advances a run still in review to published.
 *
 *  For multi-group runs (no runGroupId, sites stored ad-hoc in
 *  collectionRunSites), creates one snapshot per resolved group so reports
 *  never cross group boundaries. */
export async function publishSnapshot(runId: string, formData: FormData) {
  const session = await requireSession();
  const run = await getCollectionRun(runId);
  if (!run) {
    throw new Error("Run not found");
  }
  const labelValue = formData.get("label");
  const label = typeof labelValue === "string" ? labelValue : null;
  const approvedBy = session.user?.email ?? "operator";

  // Multi-group run: fan out one snapshot per group (or just one if groupId
  // is specified — the UI lets the operator freeze groups individually).
  if (!run.runGroupId) {
    const groups = await resolveRunGroups(runId);
    if (groups.length > 1) {
      const groupIds = formData
        .getAll("groupId")
        .filter((v): v is string => typeof v === "string" && v.length > 0);
      const targetGroups =
        groupIds.length > 0
          ? groups.filter((g) => groupIds.includes(g.id))
          : groups;

      const created = (
        await Promise.all(
          targetGroups.map((g) => createSnapshotFromRun(runId, approvedBy, label, g))
        )
      ).filter((s): s is NonNullable<typeof s> => s !== null);

      if (created.length === 0) {
        redirect(
          `/runs/${runId}?error=${encodeURIComponent("No analyzed offers to publish — run analysis first")}`
        );
      }
      if (run.status === "review") {
        await updateCollectionRunStatus(runId, "complete", {
          completedAt: run.completedAt ?? new Date(),
        });
      }
      revalidatePath(`/runs/${runId}`);
      revalidatePath("/runs");
      revalidatePath("/snapshots");
      redirect(`/runs/${runId}`);
    }
  }

  // Single-group or all-sites run: one snapshot.
  const snapshot = await createSnapshotFromRun(runId, approvedBy, label);
  if (!snapshot) {
    redirect(
      `/runs/${runId}?error=${encodeURIComponent("No analyzed offers to publish — run analysis first")}`
    );
  }

  if (run.status === "review") {
    await updateCollectionRunStatus(runId, "complete", {
      completedAt: run.completedAt ?? new Date(),
    });
  }
  revalidatePath(`/runs/${runId}`);
  revalidatePath("/runs");
  revalidatePath("/snapshots");
  redirect(`/runs/${runId}`);
}

export async function retryResult(path: string, resultId: string) {
  await requireSession();
  await retryMissionResult(resultId);
  revalidatePath(path);
  redirect(path);
}

/** Force re-collect a single dealer+mission on any run, including completed
 *  runs. Resets the result to pending and kicks the drainer. */
export async function forceReCollect(
  runId: string,
  siteId: string,
  missionId: string
) {
  await requireSession();
  await forceReCollectSingle(runId, siteId, missionId);
  revalidatePath(`/runs/${runId}`);
  redirect(`/runs/${runId}`);
}

/** Resume a run whose in-flight rows were orphaned by an interrupted executor. */
export async function resumeRun(runId: string) {
  await requireSession();
  await requeueStalledRun(runId);
  revalidatePath(`/runs/${runId}`);
  redirect(`/runs/${runId}`);
}

export async function resolveContentRemoved(path: string, resultId: string) {
  await requireSession();
  await markContentRemoved(resultId);
  revalidatePath(path);
}

export async function deleteRunEvidence(runId: string, evidenceId: string) {
  await requireSession();
  await removeEvidence(evidenceId);
  revalidatePath(`/runs/${runId}`);
}
