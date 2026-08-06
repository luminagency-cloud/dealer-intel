"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  createCollectionRun,
  getCollectionRun,
  updateCollectionRunStatus,
} from "@/lib/db/repository";
import { getEvidenceText, removeEvidence, uploadEvidence } from "@/lib/evidence";
import { getOfferVerifier, verifyBand } from "@/lib/analysis/ai-enrich";
import { htmlToText } from "@/lib/analysis/extract";
import {
  forceReCollectSingle,
  markContentRemoved,
  pauseRunExecution,
  requeueStalledRun,
  resumeRunExecution,
  retryMissionResult,
  startRunExecution,
} from "@/lib/run-executor";
import {
  startAnalysis,
  startAnalysisForSiteMission,
  stopAnalysis as signalAnalysisStop,
} from "@/lib/analysis";
import { createSnapshotFromRun, reportMinConfidence } from "@/lib/snapshot";
import { deleteRunDeep } from "@/lib/deep-delete";
import {
  collectionRunMissions,
  collectionRunSites,
  collectionRuns,
  collectorModeEnum,
  evidence,
  evidenceTypeEnum,
  getDb,
  missionTypeEnum,
  missionResults,
  missions,
  offerDispositions,
  offers,
  runGroupMembers,
  runGroups,
  sites,
  type Evidence,
  type CollectorMode,
  type EvidenceType,
  type MissionType,
  type OfferDisposition,
  type RunStatus,
} from "@/lib/db";
import { and, eq, gte, inArray, lt } from "drizzle-orm";
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

  const collectorModeValue = formData?.get("collectorMode");
  const collectorMode = collectorModeEnum.enumValues.includes(
    collectorModeValue as CollectorMode
  )
    ? (collectorModeValue as CollectorMode)
    : "current";

  const run = await createCollectionRun({
    runGroupId: resolvedRunGroupId ?? resolvedRunGroupIdFromAllGroups,
    cycle,
    collectorMode,
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

  // AUTO_START_RUN jumps straight from creation to collection for either
  // collector. The current collector runs server-side so it starts here;
  // Chrome collection is driven by the operator's browser, so the run page
  // picks the `autostart` flag up on arrival and claims the run itself.
  const autoStart = process.env.AUTO_START_RUN === "true";
  if (autoStart && collectorMode === "current") {
    void startRunExecution(run.id).catch((err) => {
      console.error(`AUTO_START_RUN: failed to start run ${run.id}:`, err);
    });
  }

  redirect(
    autoStart && collectorMode === "chrome_extension"
      ? `/runs/${run.id}?autostart=1`
      : `/runs/${run.id}`
  );
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
  if (run.status !== "pending" && run.status !== "running" && run.status !== "paused" && run.status !== "complete") {
    throw new Error(`Cannot collect on a ${run.status} run`);
  }
  if (run.status === "pending") {
    await updateCollectionRunStatus(runId, "running", { startedAt: new Date() });
  }
  return run;
}

async function requireCurrentCollector(runId: string) {
  const run = await getCollectionRun(runId);
  if (!run) throw new Error("Run not found");
  if (run.collectorMode !== "current") {
    throw new Error("This run is assigned to the Chrome extension collector");
  }
  return run;
}

export async function executeWorkItem(
  runId: string,
  siteId: string,
  missionId: string
) {
  await requireSession();
  await requireCurrentCollector(runId);
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
  await requireCurrentCollector(runId);
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

/** Hard fallback for a Chrome run that has not written evidence. This keeps
 *  the run scope/id, clears any pre-evidence attempt rows, and hands execution
 *  back to the proven collector. */
export async function switchToCurrentCollector(runId: string) {
  await requireSession();
  const run = await getCollectionRun(runId);
  if (!run) throw new Error("Run not found");

  const evidenceCount = await getDb().$count(
    evidence,
    eq(evidence.collectionRunId, runId)
  );
  if (evidenceCount > 0) {
    redirect(
      `/runs/${runId}?error=${encodeURIComponent(
        "Chrome evidence already exists. Create a replacement run with the Current collector so collector outputs are not mixed."
      )}`
    );
  }

  const db = getDb();
  await db
    .delete(missionResults)
    .where(eq(missionResults.collectionRunId, runId));
  await db
    .update(collectionRuns)
    .set({
      collectorMode: "current",
      status: "pending",
      startedAt: null,
      completedAt: null,
    })
    .where(eq(collectionRuns.id, runId));

  revalidatePath("/runs");
  revalidatePath(`/runs/${runId}`);
  redirect(
    `/runs/${runId}?notice=${encodeURIComponent(
      "Switched to the Current collector. The Chrome attempt did not write evidence."
    )}`
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

/** Stop a running analysis after the page it's on. Extracted offers stay put;
 *  the run is left resumable rather than deleted. */
export async function stopAnalysis(runId: string) {
  await requireSession();
  signalAnalysisStop(runId);
  revalidatePath(`/runs/${runId}`);
  redirect(`/runs/${runId}#analysis`);
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

/** Signal the running executor to pause after the current site finishes. */
export async function pauseRun(runId: string) {
  await requireSession();
  await pauseRunExecution(runId);
  revalidatePath(`/runs/${runId}`);
  redirect(`/runs/${runId}`);
}

/** Resume a paused run, picking up where it left off. */
export async function resumePausedRun(runId: string) {
  await requireSession();
  await resumeRunExecution(runId);
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

/** Records an operator's disposition of an offer as a durable calibration label
 *  (see offerDispositions). Reads the offer joined to its evidence provenance
 *  and snapshots confidence/type/source at this moment — BEFORE any delete, so
 *  a deleted offer still leaves its "this was junk" label behind. Best-effort:
 *  a logging failure must never block the operator's actual pass/delete. */
async function recordDisposition(
  offerId: string,
  disposition: OfferDisposition,
  operator: string | null
) {
  const db = getDb();
  const [row] = await db
    .select({
      collectionRunId: offers.collectionRunId,
      siteId: offers.siteId,
      sourceEvidenceId: offers.sourceEvidenceId,
      confidence: offers.confidence,
      offerType: offers.offerType,
      normalizedJson: offers.normalizedJson,
      vehicleMake: offers.vehicleMake,
      vehicleModel: offers.vehicleModel,
      monthlyPayment: offers.monthlyPayment,
      apr: offers.apr,
      cashIncentive: offers.cashIncentive,
      rawText: offers.rawText,
      missionType: evidence.missionType,
      evidenceType: evidence.evidenceType,
    })
    .from(offers)
    .leftJoin(evidence, eq(evidence.id, offers.sourceEvidenceId))
    .where(eq(offers.id, offerId));
  if (!row) return;

  const nj = (row.normalizedJson ?? {}) as Record<string, unknown>;
  try {
    await db.insert(offerDispositions).values({
      collectionRunId: row.collectionRunId,
      siteId: row.siteId,
      sourceEvidenceId: row.sourceEvidenceId,
      disposition,
      confidence: row.confidence,
      offerType: row.offerType,
      aiAssisted: nj.aiAssisted === true,
      missionType: row.missionType ?? null,
      evidenceType: row.evidenceType ?? null,
      offerSnapshot: {
        vehicleMake: row.vehicleMake,
        vehicleModel: row.vehicleModel,
        monthlyPayment: row.monthlyPayment,
        apr: row.apr,
        cashIncentive: row.cashIncentive,
        rawText: row.rawText,
      },
      operator,
    });
  } catch (err) {
    // Calibration logging is best-effort — never let it block the operator's
    // pass/delete (e.g. the migration hasn't been applied yet). Just note it.
    console.error("recordDisposition failed (non-fatal):", err);
  }
}

/** "Pass" a flagged offer: mark it human-reviewed so its uncertainty badge
 *  clears and it stops counting toward "N to check". The offer stays in the run
 *  and in any published report. The mark lives in normalized_json (no schema
 *  change) and, like the offer itself, is reset if analysis is re-run. A Pass is
 *  also logged as a positive calibration label (offer confidence was trusted). */
export async function passOffer(runId: string, offerId: string) {
  const session = await requireSession();
  const db = getDb();
  const [row] = await db
    .select({ normalizedJson: offers.normalizedJson })
    .from(offers)
    .where(eq(offers.id, offerId));
  const nj = (row?.normalizedJson ?? {}) as Record<string, unknown>;
  await recordDisposition(offerId, "passed", session.user?.email ?? null);
  await db
    .update(offers)
    .set({ normalizedJson: { ...nj, reviewed: true } })
    .where(eq(offers.id, offerId));
  revalidatePath(`/runs/${runId}`);
}

/** "Delete" an offer: hard-remove it so it can't reach a report. Re-running
 *  analysis re-extracts from evidence, so a deleted offer reappears then. The
 *  disposition is logged FIRST (as a negative calibration label) so the "this
 *  was junk" signal survives the row's deletion. */
export async function deleteOffer(runId: string, offerId: string) {
  const session = await requireSession();
  await recordDisposition(offerId, "deleted", session.user?.email ?? null);
  await getDb().delete(offers).where(eq(offers.id, offerId));
  revalidatePath(`/runs/${runId}`);
}

/** On-demand AI verification of a run's DECISION-BAND offers — those whose
 *  rule-based confidence straddles the publish floor (verifyBand()). For each,
 *  Claude judges whether it's a real, correctly-extracted advertised offer and
 *  returns a calibrated confidence. CONFIRM/DROP only: the verdict replaces the
 *  offer's confidence (a real offer keeps the model's calibrated number; a
 *  not-real one is forced below the publish floor so it can't reach a report).
 *  It never touches offers below the band (no rescue) or above it (already
 *  trusted), and never edits offer fields — only the confidence + a stored
 *  `aiVerified` note. Fields are corrected by the enrichment pass, not here. */
export async function verifyBorderlineOffers(runId: string) {
  await requireSession();
  if (!process.env.ANTHROPIC_API_KEY) {
    redirect(
      `/runs/${runId}?error=${encodeURIComponent(
        "AI verifier is not configured (no ANTHROPIC_API_KEY)."
      )}`
    );
  }

  const db = getDb();
  const verifier = getOfferVerifier();
  const [lo, hi] = verifyBand();
  const floor = reportMinConfidence();
  const maxOffers = Number(process.env.ANALYSIS_VERIFY_MAX ?? 40);

  const bandOffers = await db
    .select({ offer: offers, brand: sites.brand })
    .from(offers)
    .innerJoin(sites, eq(sites.id, offers.siteId))
    .where(
      and(
        eq(offers.collectionRunId, runId),
        gte(offers.confidence, lo),
        lt(offers.confidence, hi)
      )
    );

  const capped = bandOffers.length > maxOffers;
  const work = bandOffers.slice(0, maxOffers);

  // Resolve each offer's evidence page once (many offers share a page).
  const evidenceIds = [
    ...new Set(
      work.map((w) => w.offer.sourceEvidenceId).filter((id): id is string => !!id)
    ),
  ];
  const evidenceById = new Map<string, Evidence>();
  if (evidenceIds.length > 0) {
    const evRows = await db
      .select()
      .from(evidence)
      .where(inArray(evidence.id, evidenceIds));
    for (const ev of evRows) evidenceById.set(ev.id, ev);
  }

  const pageTextCache = new Map<string, string | null>();
  async function pageTextFor(ev: Evidence): Promise<string | null> {
    const cached = pageTextCache.get(ev.id);
    if (cached !== undefined) return cached;
    let text: string | null = null;
    try {
      const html = await getEvidenceText(ev);
      text = html ? htmlToText(html) : null;
    } catch {
      text = null;
    }
    pageTextCache.set(ev.id, text);
    return text;
  }

  let kept = 0;
  let dropped = 0;
  let skipped = 0;

  // Small concurrency pool: responsive on demand without hammering the API.
  let cursor = 0;
  async function worker() {
    while (cursor < work.length) {
      const { offer, brand } = work[cursor++];
      const ev = offer.sourceEvidenceId
        ? evidenceById.get(offer.sourceEvidenceId)
        : undefined;
      const pageText = ev ? await pageTextFor(ev) : null;
      if (!pageText) {
        skipped++;
        continue;
      }
      const verdict = await verifier.verify({
        pageText,
        brand: brand ?? null,
        offer: {
          offerType: offer.offerType,
          vehicle:
            [offer.vehicleMake, offer.vehicleModel, offer.vehicleTrim]
              .filter(Boolean)
              .join(" ") || null,
          monthlyPayment: offer.monthlyPayment,
          apr: offer.apr,
          cashIncentive: offer.cashIncentive,
          salePrice: offer.salePrice,
          termMonths: offer.termMonths,
          dueAtSigning: offer.dueAtSigning,
          disclaimerText: offer.disclaimerText,
          rawText: offer.rawText,
        },
      });
      if (!verdict) {
        skipped++;
        continue;
      }
      const calibrated = Math.max(0, Math.min(1, verdict.calibratedConfidence));
      // Confirm/drop: a not-real verdict is forced below the floor so the drop
      // is guaranteed regardless of the model's own number.
      const newConfidence = verdict.real
        ? calibrated
        : Math.min(calibrated, Math.max(0, floor - 0.05));
      const nj = (offer.normalizedJson ?? {}) as Record<string, unknown>;
      await db
        .update(offers)
        .set({
          confidence: newConfidence,
          normalizedJson: {
            ...nj,
            aiVerified: {
              real: verdict.real,
              reason: verdict.reason,
              confidence: calibrated,
            },
          },
        })
        .where(eq(offers.id, offer.id));
      if (newConfidence >= floor) kept++;
      else dropped++;
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(4, work.length) }, () => worker())
  );

  revalidatePath(`/runs/${runId}`);
  const summary =
    work.length === 0
      ? `No offers in the ${lo}–${hi} confidence band to verify.`
      : `Verified ${kept + dropped} borderline offer(s): ${kept} kept, ${dropped} dropped` +
        `${skipped ? `, ${skipped} skipped (no page text)` : ""}` +
        `${capped ? ` — capped at ${maxOffers}` : ""}.`;
  redirect(`/runs/${runId}?notice=${encodeURIComponent(summary)}`);
}
