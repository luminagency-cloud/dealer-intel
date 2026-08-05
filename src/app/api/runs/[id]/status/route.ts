import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { eq } from "drizzle-orm";
import { getDb, missionResults, collectionRuns } from "@/lib/db";
import { listOffersForRun, listComplianceGradesForRun } from "@/lib/db/repository";
import { isRunExecuting, isPausedRun } from "@/lib/run-executor";
import { isChromeRunLive } from "@/lib/chrome-collector";
import {
  isAnalysisRunning,
  isAnalysisStopping,
  getAnalysisProgress,
  getPartialAnalysisKeys,
} from "@/lib/analysis";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  const db = getDb();
  const [results, currentExecuting, analyzing, progress, partialKeys, runRecord, offers, grades] = await Promise.all([
    db
      .select({
        id: missionResults.id,
        siteId: missionResults.siteId,
        missionId: missionResults.missionId,
        status: missionResults.status,
        pagesCaptured: missionResults.pagesCaptured,
        successfulUrl: missionResults.successfulUrl,
        error: missionResults.error,
      })
      .from(missionResults)
      .where(eq(missionResults.collectionRunId, id)),
    Promise.resolve(isRunExecuting(id)),
    Promise.resolve(isAnalysisRunning(id)),
    Promise.resolve(getAnalysisProgress(id)),
    Promise.resolve(getPartialAnalysisKeys(id)),
    db
      .select({
        collectorMode: collectionRuns.collectorMode,
        status: collectionRuns.status,
        chromeHeartbeatAt: collectionRuns.chromeHeartbeatAt,
        startedAt: collectionRuns.startedAt,
        completedAt: collectionRuns.completedAt,
        analysisStartedAt: collectionRuns.analysisStartedAt,
        analysisCompletedAt: collectionRuns.analysisCompletedAt,
      })
      .from(collectionRuns)
      .where(eq(collectionRuns.id, id)),
    // Offers + grades so the Analysis panel updates live during analysis and
    // lands its final populated state without a manual reload.
    listOffersForRun(id),
    listComplianceGradesForRun(id),
  ]);

  const run = runRecord[0];
  const chromeRun = run?.collectorMode === "chrome_extension";
  const executing = chromeRun
    ? !!run && isChromeRunLive(run)
    : currentExecuting;

  const paused = isPausedRun(id);
  // Chrome's interrupted state is surfaced by its own recovery button, not the
  // Current collector's Resume banner — an unfinished Chrome run is never
  // "stalled" in the sense this flag means.
  const stalled =
    !chromeRun &&
    !executing &&
    !paused &&
    results.some((r) => r.status === "pending" || r.status === "running");

  return NextResponse.json({
    executing,
    analyzing,
    analysisStopping: isAnalysisStopping(id),
    paused,
    stalled,
    progress,
    partialAnalysisKeys: [...partialKeys],
    results,
    offers,
    grades,
    collectionStartedAt: runRecord[0]?.startedAt ?? null,
    collectionCompletedAt: runRecord[0]?.completedAt ?? null,
    analysisStartedAt: runRecord[0]?.analysisStartedAt ?? null,
    analysisCompletedAt: runRecord[0]?.analysisCompletedAt ?? null,
  });
}
