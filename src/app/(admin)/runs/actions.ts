"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  createCollectionRun,
  getCollectionRun,
  updateCollectionRunStatus,
} from "@/lib/db/repository";
import { removeEvidence, uploadEvidence } from "@/lib/evidence";
import { collectSiteEvidence } from "@/lib/collector";
import { getDb, sites } from "@/lib/db";
import { eq } from "drizzle-orm";
import {
  evidenceTypeEnum,
  missionTypeEnum,
  type EvidenceType,
  type MissionType,
  type RunStatus,
} from "@/lib/db";
import { RUN_TRANSITIONS } from "@/lib/run-lifecycle";
import { requireSession } from "@/lib/session";

export async function createRun() {
  await requireSession();
  const run = await createCollectionRun();
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

export async function collectEvidence(runId: string, formData: FormData) {
  await requireSession();
  const run = await getCollectionRun(runId);
  if (!run) {
    throw new Error("Run not found");
  }
  if (run.status !== "pending" && run.status !== "running") {
    throw new Error(`Cannot collect on a ${run.status} run`);
  }

  const siteId = formData.get("siteId");
  const missionType = formData.get("missionType");
  if (
    typeof siteId !== "string" ||
    !siteId ||
    !missionTypeEnum.enumValues.includes(missionType as MissionType)
  ) {
    throw new Error("Site and mission type are required");
  }
  const [site] = await getDb()
    .select({ id: sites.id, url: sites.url })
    .from(sites)
    .where(eq(sites.id, siteId));
  if (!site) {
    throw new Error("Site not found");
  }

  const result = await collectSiteEvidence({
    collectionRunId: runId,
    site,
    missionType: missionType as MissionType,
  });

  revalidatePath(`/runs/${runId}`);
  redirect(
    result.status === "success"
      ? `/runs/${runId}?collected=${result.evidence.length}`
      : `/runs/${runId}?collectError=${encodeURIComponent(
          result.error ?? "Collection failed"
        )}`
  );
}

export async function deleteRunEvidence(runId: string, evidenceId: string) {
  await requireSession();
  await removeEvidence(evidenceId);
  revalidatePath(`/runs/${runId}`);
}
