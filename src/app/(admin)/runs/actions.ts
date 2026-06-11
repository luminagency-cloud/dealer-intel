"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  createCollectionRun,
  getCollectionRun,
  listExecutableMissions,
  updateCollectionRunStatus,
} from "@/lib/db/repository";
import { removeEvidence, uploadEvidence } from "@/lib/evidence";
import { runMission, type MissionRunResult } from "@/lib/collector";
import {
  evidenceTypeEnum,
  missionTypeEnum,
  type EvidenceType,
  type MissionType,
  type RunStatus,
} from "@/lib/db";
import { RUN_TRANSITIONS } from "@/lib/run-lifecycle";
import { requireSession } from "@/lib/session";

export async function createRun(formData?: FormData) {
  await requireSession();
  const groupValue = formData?.get("runGroupId");
  const runGroupId =
    typeof groupValue === "string" && groupValue ? groupValue : null;
  const run = await createCollectionRun({ runGroupId });
  revalidatePath("/runs");
  redirect(`/runs/${run.id}`);
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
  return run;
}

function summarizeResults(runId: string, results: MissionRunResult[]): string {
  const ok = results.filter((r) => r.status === "success");
  const failed = results.filter((r) => r.status === "failure");
  const pages = ok.reduce((n, r) => n + r.pagesCaptured, 0);
  const params = new URLSearchParams({
    ok: String(ok.length),
    failed: String(failed.length),
    pages: String(pages),
  });
  const firstError = failed.find((r) => r.error)?.error;
  if (firstError) params.set("error", firstError);
  return `/runs/${runId}?${params}`;
}

export async function executeMission(runId: string, missionId: string) {
  await requireSession();
  const run = await requireCollectableRun(runId);

  // Scoped to the run's group (when set) — a grouped run only ever
  // executes its member sites' missions.
  const row = (await listExecutableMissions(run.runGroupId)).find(
    (r) => r.mission.id === missionId
  );
  if (!row) {
    throw new Error("Mission not found in this run's scope");
  }

  const result = await runMission({
    collectionRunId: runId,
    mission: row.mission,
    site: row.site,
  });

  revalidatePath(`/runs/${runId}`);
  redirect(summarizeResults(runId, [result]));
}

export async function executeAllMissions(runId: string) {
  await requireSession();
  const run = await requireCollectableRun(runId);

  const rows = await listExecutableMissions(run.runGroupId);
  if (rows.length === 0) {
    redirect(`/runs/${runId}?error=${encodeURIComponent("No active missions")}`);
  }

  const results: MissionRunResult[] = [];
  for (const row of rows) {
    results.push(
      await runMission({
        collectionRunId: runId,
        mission: row.mission,
        site: row.site,
      })
    );
  }

  revalidatePath(`/runs/${runId}`);
  redirect(summarizeResults(runId, results));
}

export async function deleteRunEvidence(runId: string, evidenceId: string) {
  await requireSession();
  await removeEvidence(evidenceId);
  revalidatePath(`/runs/${runId}`);
}
