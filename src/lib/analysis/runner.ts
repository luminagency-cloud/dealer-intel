import { eq } from "drizzle-orm";
import { getDb, collectionRuns, type MissionType } from "@/lib/db";
import { getComplianceGrader } from "./compliance";
import {
  loadAnalyzableEvidenceForSiteMission,
  loadDisclaimerEvidenceForSiteMission,
  loadRunScopePairs,
  loadCompletedScopePairs,
  loadCapturedDisclaimers,
  loadScreenshotIndex,
  loadAdImageIndex,
  runAnalysisForScope,
  type ScopePair,
  type RunAnalysisSharedContext,
} from "./pipeline";

/**
 * Phase 9 analysis job queue — pure orchestration, no extraction logic (see
 * pipeline.ts for the atomic per-site+mission pipeline this dispatches).
 * Decides SCOPE and nothing else: a full run, a resume, a manual per-row
 * re-analyze, and a re-collect catch-up are all just different scope-pair
 * lists handed to the same `runAnalysisForScope`.
 */

const globalState = globalThis as unknown as {
  __activeAnalysisRuns?: Set<string>;
  __stoppingAnalyses?: Set<string>;
  __analysisProgress?: Map<string, { processed: number; total: number }>;
  __analysisRemaining?: Map<string, ScopePair[]>;
  __analysisQueueState?: {
    queue: AnalysisQueueTask[];
    running: number;
  };
};
const activeAnalyses = (globalState.__activeAnalysisRuns ??= new Set<string>());
const stoppingAnalyses = (globalState.__stoppingAnalyses ??= new Set<string>());
const analysisProgress = (globalState.__analysisProgress ??= new Map<
  string,
  { processed: number; total: number }
>());
/** Pairs a paused run had not reached yet, kept from pause to resume.
 *  Authoritative because a pair that extracted zero offers leaves no DB trace
 *  of having been analyzed — the offers-based filter alone re-does every such
 *  pair, which is why resume behaved like a restart.
 *  ponytail: server memory, same lifetime as the analysis engine itself; a
 *  process restart falls back to the offers-based filter. Persist per-pair
 *  completion in the DB if resume must survive restarts. */
const analysisRemaining = (globalState.__analysisRemaining ??= new Map<string, ScopePair[]>());
const ANALYSIS_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.ANALYSIS_CONCURRENCY ?? "1", 10)
);

export function isAnalysisRunning(runId: string): boolean {
  return activeAnalyses.has(runId);
}

/** Signal a running analysis to pause after the site+mission pair it's on.
 *  Extraction of a single pair can involve AI and OCR calls, so this is
 *  cooperative rather than immediate — the loop checks BETWEEN scope-pair
 *  units, never mid-page. A pair's own evidence set is small, so the wait is
 *  short.
 *
 *  Whatever has been extracted stays in place, and `analysisCompletedAt` is
 *  deliberately left unset, which is exactly the state "Resume Analysis"
 *  already keys off. Pause then Resume picks up at the first pair with no
 *  offers yet; pause then Re-run Analysis starts clean. */
export function stopAnalysis(runId: string): void {
  if (activeAnalyses.has(runId)) stoppingAnalyses.add(runId);
}

export function isAnalysisStopping(runId: string): boolean {
  return stoppingAnalyses.has(runId);
}

/** Returns the set of "siteId:missionType" pairs currently being partially
 *  re-analyzed within this run. Empty set = no partial analyses in flight. */
export function getPartialAnalysisKeys(runId: string): Set<string> {
  const prefix = `${runId}:`;
  const keys = new Set<string>();
  for (const key of activeAnalyses) {
    if (key.startsWith(prefix)) {
      keys.add(key.slice(prefix.length));
    }
  }
  return keys;
}

export function getAnalysisProgress(
  runId: string
): { processed: number; total: number } | null {
  return analysisProgress.get(runId) ?? null;
}

/** Summed live progress across several concurrently-analyzing runs (e.g. one
 *  per group), for a single "N of M pages" figure across a week's groups. */
export function getAnalysisProgressForRuns(runIds: string[]): { processed: number; total: number } {
  let processed = 0, total = 0;
  for (const runId of runIds) {
    const p = analysisProgress.get(runId);
    if (p) {
      processed += p.processed;
      total += p.total;
    }
  }
  return { processed, total };
}

interface AnalysisQueueTask {
  runId: string;
  scopePairs: ScopePair[];
}

const analysisQueueState = (globalState.__analysisQueueState ??= {
  queue: [],
  running: 0,
});

function enqueueAnalysis(task: AnalysisQueueTask): void {
  analysisQueueState.queue.push(task);
  drainAnalysisQueue();
}

function drainAnalysisQueue(): void {
  while (
    analysisQueueState.running < ANALYSIS_CONCURRENCY &&
    analysisQueueState.queue.length > 0
  ) {
    const task = analysisQueueState.queue.shift()!;
    analysisQueueState.running++;
    void runScopePairs(task.runId, task.scopePairs)
      .catch((err) => {
        console.error(`analysis for run ${task.runId} crashed:`, err);
      })
      .finally(() => {
        analysisQueueState.running--;
        drainAnalysisQueue();
      });
  }
}

/** Runs every scope pair for a run sequentially, sharing one compliance
 *  grader and one set of run-scoped evidence indexes across all of them (see
 *  pipeline.ts's `RunAnalysisSharedContext`) — this is what keeps a full
 *  run's AdScore usage at one batch per run rather than one per site+mission,
 *  matching what the old single full-run entry point did.
 *
 *  Checks the pause signal BETWEEN pairs, never mid-pair — this is the only
 *  place pause granularity is enforced; `runAnalysisForScope` itself has no
 *  pause-awareness. */
async function runScopePairs(runId: string, scopePairs: ScopePair[]): Promise<void> {
  const db = getDb();
  try {
    if (stoppingAnalyses.has(runId)) {
      console.log(`[analysis] run=${runId} stopped before it began`);
      analysisRemaining.set(runId, scopePairs);
      return;
    }

    analysisProgress.set(runId, { processed: 0, total: scopePairs.length });
    const shared: RunAnalysisSharedContext = {
      grader: getComplianceGrader(runId),
      capturedDisclaimers: await loadCapturedDisclaimers(runId),
      screenshotIndex: await loadScreenshotIndex(runId),
      adImageIndex: await loadAdImageIndex(runId),
    };

    for (let i = 0; i < scopePairs.length; i++) {
      const { siteId, missionType } = scopePairs[i];
      if (stoppingAnalyses.has(runId)) {
        console.log(`[analysis] run=${runId} pausing before site=${siteId} mission=${missionType}`);
        analysisRemaining.set(runId, scopePairs.slice(i));
        break;
      }
      await runAnalysisForScope(runId, siteId, missionType, shared);
      const prog = analysisProgress.get(runId);
      if (prog) prog.processed += 1;
    }

    // A paused analysis is unfinished by definition — leaving
    // analysisCompletedAt null is what surfaces "Resume Analysis".
    if (stoppingAnalyses.has(runId)) {
      console.log(
        `[analysis] run=${runId} paused by operator, ${analysisRemaining.get(runId)?.length ?? 0} pairs left`
      );
    } else {
      analysisRemaining.delete(runId);
      await db
        .update(collectionRuns)
        .set({ analysisCompletedAt: new Date() })
        .where(eq(collectionRuns.id, runId));
    }
  } finally {
    activeAnalyses.delete(runId);
    analysisProgress.delete(runId);
    stoppingAnalyses.delete(runId);
  }
}

export async function startAnalysis(runId: string, { resume = false }: { resume?: boolean } = {}): Promise<number | null> {
  if (activeAnalyses.has(runId)) return null;
  try {
    let scopePairs = await loadRunScopePairs(runId);
    if (resume) {
      const pending = analysisRemaining.get(runId);
      if (pending) {
        // Exactly where the pause stopped, including pairs that yielded no
        // offers — those leave no DB trace and the filter below re-does them.
        scopePairs = pending;
      } else {
        // No in-memory pause point (server restarted): fall back to pairs with
        // no offers yet.
        const done = new Set(
          (await loadCompletedScopePairs(runId)).map((p) => `${p.siteId}:${p.missionType}`)
        );
        scopePairs = scopePairs.filter((p) => !done.has(`${p.siteId}:${p.missionType}`));
      }
    } else {
      analysisRemaining.delete(runId);
    }
    console.log(`[analysis] startAnalysis run=${runId} scope pairs=${scopePairs.length} resume=${resume}`);
    if (scopePairs.length === 0) {
      console.warn(`[analysis] no scope pairs for run=${runId} — returning 0`);
      return 0;
    }
    activeAnalyses.add(runId);
    // Clear any stop signal from a previous pass before this one queues.
    stoppingAnalyses.delete(runId);
    await getDb()
      .update(collectionRuns)
      .set({ analysisStartedAt: new Date() })
      .where(eq(collectionRuns.id, runId));
    enqueueAnalysis({ runId, scopePairs });
    return scopePairs.length;
  } catch (err) {
    activeAnalyses.delete(runId);
    throw err;
  }
}

/** For scripts/CLI: runs the full analysis pipeline and waits for completion. */
export async function runAnalysisDirect(runId: string): Promise<void> {
  const scopePairs = await loadRunScopePairs(runId);
  await getDb()
    .update(collectionRuns)
    .set({ analysisStartedAt: new Date() })
    .where(eq(collectionRuns.id, runId));
  await runScopePairs(runId, scopePairs);
}

/** Re-run extraction for a single site+mission within a run.
 *
 *  Deletes only the offers and compliance grades sourced from this site+mission's
 *  evidence, then re-inserts fresh results (see `runAnalysisForScope`). Safe to
 *  call while the rest of the run's offers are intact. Blocked if a full-run
 *  analysis is in flight. */
export async function startAnalysisForSiteMission(
  runId: string,
  siteId: string,
  missionType: MissionType
): Promise<"started" | "busy" | "no_evidence"> {
  // Block if a full-run analysis is already running.
  if (activeAnalyses.has(runId)) return "busy";
  const key = `${runId}:${siteId}:${missionType}`;
  if (activeAnalyses.has(key)) return "busy";

  const htmlRows = await loadAnalyzableEvidenceForSiteMission(runId, siteId, missionType);
  const disclaimerRows = await loadDisclaimerEvidenceForSiteMission(runId, siteId, missionType);
  if (htmlRows.length === 0 && disclaimerRows.length === 0) return "no_evidence";

  activeAnalyses.add(key);
  void runAnalysisForScope(runId, siteId, missionType)
    .catch((err) => {
      console.error(`partial analysis for ${runId} ${siteId} ${missionType} crashed:`, err);
    })
    .finally(() => {
      activeAnalyses.delete(key);
    });

  return "started";
}
