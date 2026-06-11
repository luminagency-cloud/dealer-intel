"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  createCollectionRun,
  getCollectionRun,
  updateCollectionRunStatus,
} from "@/lib/db/repository";
import type { RunStatus } from "@/lib/db";
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
