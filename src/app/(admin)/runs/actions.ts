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
  markContentRemoved,
  retryMissionResult,
  startRunExecution,
} from "@/lib/run-executor";
import { deleteRunDeep } from "@/lib/deep-delete";
import {
  collectionRunMissions,
  collectionRunSites,
  evidenceTypeEnum,
  getDb,
  missionTypeEnum,
  missions,
  type EvidenceType,
  type MissionType,
  type RunStatus,
} from "@/lib/db";
import { eq } from "drizzle-orm";
import { RUN_TRANSITIONS } from "@/lib/run-lifecycle";
import { requireSession } from "@/lib/session";

export async function createRun(formData?: FormData) {
  await requireSession();
  // Scope select encodes "group:<id>", "custom" (ad-hoc dealer checkboxes
  // in siteIds), or "" for all sites.
  const scopeValue = formData?.get("scope");
  const scope = typeof scopeValue === "string" ? scopeValue : "";
  const siteIds =
    scope === "custom"
      ? (formData
          ?.getAll("siteIds")
          .filter((v): v is string => typeof v === "string" && v.length > 0) ??
        [])
      : [];
  if (scope === "custom" && siteIds.length === 0) {
    redirect(`/runs?error=${encodeURIComponent("Pick at least one dealer")}`);
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

  const run = await createCollectionRun({
    runGroupId: scope.startsWith("group:") ? scope.slice(6) : null,
  });
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
  redirect(`/runs/${run.id}`);
}

export async function deleteRun(runId: string) {
  await requireSession();
  await deleteRunDeep(runId);
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

export async function retryResult(path: string, resultId: string) {
  await requireSession();
  await retryMissionResult(resultId);
  revalidatePath(path);
  redirect(path);
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
