import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { eq } from "drizzle-orm";
import { getDb, missionResults } from "@/lib/db";
import { isRunExecuting } from "@/lib/run-executor";
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

  const [results, executing, analyzing, progress, partialKeys] = await Promise.all([
    getDb()
      .select({
        id: missionResults.id,
        siteId: missionResults.siteId,
        missionId: missionResults.missionId,
        status: missionResults.status,
        pagesCaptured: missionResults.pagesCaptured,
      })
      .from(missionResults)
      .where(eq(missionResults.collectionRunId, id)),
    Promise.resolve(isRunExecuting(id)),
    Promise.resolve(isAnalysisRunning(id)),
    Promise.resolve(getAnalysisProgress(id)),
    Promise.resolve(getPartialAnalysisKeys(id)),
  ]);

  const stalled =
    !executing &&
    results.some((r) => r.status === "pending" || r.status === "running");

  return NextResponse.json({
    executing,
    analyzing,
    stalled,
    progress,
    partialAnalysisKeys: [...partialKeys],
    results,
  });
}
