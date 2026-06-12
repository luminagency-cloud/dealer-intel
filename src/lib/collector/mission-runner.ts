import { sql } from "drizzle-orm";
import {
  getDb,
  siteMissions,
  type Evidence,
  type Mission,
  type Site,
  type SiteMission,
} from "@/lib/db";
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
 * first — the site's configured URLs, then platform-default paths, then
 * navigation discovery. AI fallback is reserved for Phase 13. Learning is
 * written back to site_missions (the per-dealer config/memory).
 */

const MAX_PAGES_PER_MISSION = 6;

export interface MissionRunResult {
  missionId: string;
  siteId: string;
  status: "success" | "failure";
  pagesCaptured: number;
  /** How many URLs the mission tried to capture. */
  pagesAttempted: number;
  /** True when no URL was configured and discovery found nothing. */
  notFound: boolean;
  evidence: Evidence[];
  /** URL that produced the first successful capture. */
  successfulUrl?: string;
  error?: string;
}

function configuredUrls(
  mission: Mission,
  siteMission: SiteMission | null,
  site: Site
): string[] {
  const urls = [
    siteMission?.lastKnownUrl,
    ...(siteMission?.alternateUrls ?? []),
  ]
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

/** Site memory: remember what worked for this dealer+mission. Creates the
 *  site_missions row when collection succeeded purely via discovery. */
async function recordSuccess(
  site: Site,
  mission: Mission,
  discoveredUrl: string | null
): Promise<void> {
  await getDb()
    .insert(siteMissions)
    .values({
      siteId: site.id,
      missionId: mission.id,
      lastKnownUrl: discoveredUrl,
      lastSuccessAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [siteMissions.siteId, siteMissions.missionId],
      set: {
        lastSuccessAt: new Date(),
        updatedAt: new Date(),
        ...(discoveredUrl
          ? { lastKnownUrl: sql`coalesce(${siteMissions.lastKnownUrl}, ${discoveredUrl})` }
          : {}),
      },
    });
}

export async function runMission(input: {
  collectionRunId: string;
  mission: Mission;
  site: Site;
  siteMission: SiteMission | null;
}): Promise<MissionRunResult> {
  const { collectionRunId, mission, site, siteMission } = input;
  const base = {
    collectionRunId,
    siteId: site.id,
    missionType: mission.missionType,
  };
  const explore = MISSION_EXPLORATION[mission.missionType];

  return withCollectorSession(async (session) => {
    let urls = configuredUrls(mission, siteMission, site);
    let discoveredUrl: string | null = null;
    if (urls.length === 0) {
      discoveredUrl = await discoverUrl(session, mission, site);
      if (!discoveredUrl) {
        return {
          missionId: mission.id,
          siteId: site.id,
          status: "failure",
          pagesCaptured: 0,
          pagesAttempted: 0,
          notFound: true,
          evidence: [],
          error:
            "No URL configured and discovery found no matching page. " +
            "Set a URL on the site's mission config.",
        };
      }
      urls = [discoveredUrl];
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
      await recordSuccess(site, mission, discoveredUrl);
    }

    return {
      missionId: mission.id,
      siteId: site.id,
      status: pagesCaptured > 0 ? "success" : "failure",
      pagesCaptured,
      pagesAttempted: urls.length,
      notFound: false,
      evidence,
      successfulUrl,
      // Surface partial-capture errors too — the executor uses them to
      // flag results as needs_review.
      error: firstError,
    };
  });
}
