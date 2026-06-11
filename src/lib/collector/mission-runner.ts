import { eq } from "drizzle-orm";
import { getDb, missions, type Evidence, type Mission, type Site } from "@/lib/db";
import { uploadEvidence } from "@/lib/evidence";
import {
  CollectionError,
  cleanErrorMessage,
  withCollectorSession,
  type CollectorSession,
} from "./engine";
import {
  DISCOVERY_KEYWORDS,
  MISSION_EXPLORATION,
  PLATFORM_DEFAULT_PATHS,
  missionTargetsHomepage,
} from "./mission-knowledge";

/**
 * Mission-driven collection (Phase 6, AD-004): deterministic URL resolution
 * first — configured URLs, then platform-default paths, then navigation
 * discovery. AI fallback is reserved for Phase 13.
 */

const MAX_PAGES_PER_MISSION = 6;

export interface MissionRunResult {
  missionId: string;
  status: "success" | "failure";
  pagesCaptured: number;
  evidence: Evidence[];
  /** URL that produced the first successful capture. */
  successfulUrl?: string;
  error?: string;
}

function configuredUrls(mission: Mission, site: Site): string[] {
  const urls = [mission.lastKnownUrl, ...(mission.alternateUrls ?? [])]
    .map((u) => u?.trim())
    .filter((u): u is string => Boolean(u));
  if (urls.length === 0 && missionTargetsHomepage(mission.missionType)) {
    urls.push(site.url);
  }
  return [...new Set(urls)].slice(0, MAX_PAGES_PER_MISSION);
}

/** Recovery sequence steps 3-4: platform default paths, then nav discovery. */
async function discoverUrl(
  session: CollectorSession,
  mission: Mission,
  site: Site
): Promise<string | null> {
  const base = site.url.replace(/\/+$/, "");
  for (const path of PLATFORM_DEFAULT_PATHS[mission.missionType]) {
    const candidate = `${base}/${path}`;
    if (await session.probeUrl(candidate)) return candidate;
  }

  const keywords = DISCOVERY_KEYWORDS[mission.missionType];
  if (keywords.length > 0) {
    const links = await session.collectLinks(site.url);
    for (const keyword of keywords) {
      const match = links.find((l) => l.text.includes(keyword));
      if (match) return match.href;
    }
  }
  return null;
}

export async function runMission(input: {
  collectionRunId: string;
  mission: Mission;
  site: Site;
}): Promise<MissionRunResult> {
  const { collectionRunId, mission, site } = input;
  const base = {
    collectionRunId,
    siteId: site.id,
    missionType: mission.missionType,
  };
  const explore = MISSION_EXPLORATION[mission.missionType];

  return withCollectorSession(async (session) => {
    let urls = configuredUrls(mission, site);
    let discovered = false;
    if (urls.length === 0) {
      const found = await discoverUrl(session, mission, site);
      if (!found) {
        return {
          missionId: mission.id,
          status: "failure",
          pagesCaptured: 0,
          evidence: [],
          error:
            "No URL configured and discovery found no matching page. " +
            "Set a Last Known URL on the mission.",
        };
      }
      urls = [found];
      discovered = true;
    }

    const evidence: Evidence[] = [];
    let successfulUrl: string | undefined;
    let pagesCaptured = 0;
    let firstError: string | undefined;

    for (const url of urls) {
      try {
        const capture = await session.capturePage(url, explore);
        evidence.push(
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
          })
        );
        for (const shot of capture.extraShots) {
          evidence.push(
            await uploadEvidence({
              ...base,
              evidenceType: shot.kind,
              fileName: `${shot.label}.png`,
              body: shot.image,
            })
          );
        }
        pagesCaptured++;
        successfulUrl ??= url;
      } catch (err) {
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
        firstError ??= cleanErrorMessage(err);
      }
    }

    if (pagesCaptured > 0) {
      // Site memory (Collector Engine doc): remember what worked. Full
      // success-rate learning arrives in Phase 8.
      await getDb()
        .update(missions)
        .set({
          lastSuccessAt: new Date(),
          updatedAt: new Date(),
          ...(discovered && successfulUrl
            ? { lastKnownUrl: successfulUrl }
            : {}),
        })
        .where(eq(missions.id, mission.id));
    }

    return {
      missionId: mission.id,
      status: pagesCaptured > 0 ? "success" : "failure",
      pagesCaptured,
      evidence,
      successfulUrl,
      error: pagesCaptured > 0 ? undefined : firstError,
    };
  });
}

