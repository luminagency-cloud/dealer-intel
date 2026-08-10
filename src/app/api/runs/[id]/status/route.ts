import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/session";
import { eq } from "drizzle-orm";
import { getDb, missionResults, collectionRuns } from "@/lib/db";
import { listOffersForRun, listComplianceGradesForRun } from "@/lib/db/repository";
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
  const { response } = await requireApiSession();
  if (response) return response;

  const { id } = await params;

  const db = getDb();
  const [results, analyzing, progress, partialKeys, runRecord, offers, grades] = await Promise.all([
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
    Promise.resolve(isAnalysisRunning(id)),
    Promise.resolve(getAnalysisProgress(id)),
    Promise.resolve(getPartialAnalysisKeys(id)),
    db
      .select({
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
  const executing = run ? isChromeRunLive(run) : false;

  return NextResponse.json({
    executing,
    analyzing,
    analysisStopping: isAnalysisStopping(id),
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
