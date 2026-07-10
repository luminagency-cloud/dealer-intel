import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { eq } from "drizzle-orm";
import { getDb, missionResults, collectionRuns } from "@/lib/db";
import { isRunExecuting, isPausedRun } from "@/lib/run-executor";
import {
  isAnalysisRunning,
  getAnalysisProgress,
  getPartialAnalysisKeys,
} from "@/lib/analysis";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  const db = getDb();
  const [results, executing, analyzing, progress, partialKeys, runRecord] = await Promise.all([
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
        startedAt: collectionRuns.startedAt,
        completedAt: collectionRuns.completedAt,
      })
      .from(collectionRuns)
      .where(eq(collectionRuns.id, id)),
  ]);

  const paused = isPausedRun(id);
  const stalled =
    !executing &&
    !paused &&
    results.some((r) => r.status === "pending" || r.status === "running");

  return NextResponse.json({
    executing,
    analyzing,
    paused,
    stalled,
    progress,
    partialAnalysisKeys: [...partialKeys],
    results,
    collectionStartedAt: runRecord[0]?.startedAt ?? null,
    collectionCompletedAt: runRecord[0]?.completedAt ?? null,
  });
}
