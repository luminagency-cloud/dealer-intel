import { CollectionError, capturePage, cleanErrorMessage } from "./engine";
import { uploadEvidence } from "@/lib/evidence";
import type { Evidence, MissionType, Site } from "@/lib/db";

export { CollectionError, capturePage } from "./engine";
export { runMission, type MissionRunResult } from "./mission-runner";

export interface CollectionResult {
  status: "success" | "failure";
  evidence: Evidence[];
  finalUrl?: string;
  error?: string;
}

/**
 * Generic single-page collection (Phase 5): visits a site's URL and stores
 * the captured evidence against a run. Kept for ad-hoc captures; mission
 * execution (Phase 6) lives in mission-runner.ts.
 */
export async function collectSiteEvidence(input: {
  collectionRunId: string;
  site: Pick<Site, "id" | "url">;
  missionType: MissionType;
}): Promise<CollectionResult> {
  const base = {
    collectionRunId: input.collectionRunId,
    siteId: input.site.id,
    missionType: input.missionType,
  };

  try {
    const capture = await capturePage(input.site.url);
    const evidence = [
      await uploadEvidence({
        ...base,
        evidenceType: "screenshot",
        fileName: "screenshot.png",
        body: capture.screenshot,
      }),
      await uploadEvidence({
        ...base,
        evidenceType: "html_snapshot",
        fileName: "snapshot.html",
        body: Buffer.from(capture.html, "utf-8"),
      }),
    ];
    return { status: "success", evidence, finalUrl: capture.finalUrl };
  } catch (err) {
    const evidence: Evidence[] = [];
    if (err instanceof CollectionError && err.failureScreenshot) {
      try {
        evidence.push(
          await uploadEvidence({
            ...base,
            evidenceType: "failure_screenshot",
            fileName: "failure.png",
            body: err.failureScreenshot,
          })
        );
      } catch {
        // Evidence storage failing must not mask the original error.
      }
    }
    return { status: "failure", evidence, error: cleanErrorMessage(err) };
  }
}
