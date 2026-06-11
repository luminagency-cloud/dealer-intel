import { CollectionError, capturePage } from "./engine";
import { uploadEvidence } from "@/lib/evidence";
import type { Evidence, MissionType, Site } from "@/lib/db";

export { CollectionError, capturePage } from "./engine";

export interface CollectionResult {
  status: "success" | "failure";
  evidence: Evidence[];
  finalUrl?: string;
  error?: string;
}

// Strips ANSI styling (ESC [ ... m) — Playwright error messages embed
// terminal escape codes. Built via fromCharCode so no raw control
// character lives in this source file.
const ANSI_PATTERN = new RegExp(
  String.fromCharCode(27) + "\\[[0-9;]*m",
  "g"
);

/**
 * Visits a site and stores the captured evidence against a run (Phase 5
 * success criteria). The mission type is a label supplied by the caller —
 * the collector itself attaches no meaning to it (AD-003); URL selection
 * beyond the site homepage arrives with the mission framework in Phase 6.
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
    // First line only, without ANSI codes — Playwright errors append a
    // multi-line call log meant for terminals.
    const message = (err instanceof Error ? err.message : String(err))
      .split("\n")[0]
      .replace(ANSI_PATTERN, "")
      .trim();
    return { status: "failure", evidence, error: message };
  }
}
