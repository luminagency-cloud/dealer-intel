import {
  getDb,
  siteMissions,
  type Evidence,
  type Mission,
  type MissionType,
  type Site,
  type SiteMission,
} from "@/lib/db";
import { uploadEvidence } from "@/lib/evidence";
import { captureAdImages } from "./ad-images";
import {
  CollectionError,
  cleanErrorMessage,
  withCollectorSession,
  type CollectorSession,
  type ExploreOptions,
  type PageCapture,
} from "./engine";
import {
  DISCOVERY_KEYWORDS,
  MAX_DISCOVERY_CANDIDATES,
  MISSION_EXPLORATION,
  PLATFORM_DEFAULT_PATHS,
  isSameLocation,
  missionTargetsHomepage,
  navLinkIsExcluded,
  navTextMatchesKeyword,
  pageIsBannedProgram,
  urlIsBannedProgram,
} from "./mission-knowledge";

/**
 * Mission-driven collection (Phase 6, AD-004): deterministic URL resolution
 * first — the site's configured URLs, then platform-default paths, then
 * navigation discovery. AI fallback is reserved for Phase 13. Learning is
 * written back to site_missions (the per-dealer config/memory).
 *
 * Phase 8 consolidation: a site is visited once per run. All of a site's
 * missions run inside a single browser session (collectSite), sharing one
 * page-capture cache so a URL targeted by several missions is fetched once.
 * If anything captured zero pages on the first pass — a blocked or crashed
 * browser, a flaky network — those missions get one more swing in a fresh
 * session.
 */

const MAX_PAGES_PER_MISSION = 6;

/** A readable name for a page capture: the page title plus the URL path it
 *  came from (e.g. "Service Specials — /promotions/service/"). Falls back to
 *  the host+path when there's no title. */
function pageCaptureLabel(pageTitle: string, finalUrl: string): string {
  let location = finalUrl;
  try {
    const u = new URL(finalUrl);
    location = `${u.host}${u.pathname}`.replace(/\/$/, "") || u.host;
  } catch {
    // Non-URL string — use as-is.
  }
  const title = pageTitle.trim().replace(/\s+/g, " ");
  return (title ? `${title} — ${location}` : location).slice(0, 160);
}

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

/** One mission applied to a site, with the site's URL config/memory. */
export interface SiteMissionWork {
  mission: Mission;
  siteMission: SiteMission | null;
}

/** Captures reused within a single site visit, keyed by URL + exploration
 *  signature so two missions hitting the same page (e.g. homepage_offers and
 *  promotional_banners on the homepage) only fetch it once. */
type CaptureCache = Map<string, PageCapture>;

function exploreSignature(explore: ExploreOptions): string {
  return [explore.carousels, explore.tabs, explore.accordions, explore.disclaimers]
    .map((flag) => (flag ? "1" : "0"))
    .join("");
}

function configuredUrls(
  mission: Mission,
  siteMission: SiteMission | null,
  site: Site
): string[] {
  // A memorized URL is only trusted if it points somewhere a non-homepage
  // mission could plausibly belong — the same read-side guard the Chrome
  // collector applies in resolveCollectionUrls. Without it a row whose
  // lastKnownUrl drifted to the dealer homepage pins finance/service to the
  // front page forever, since urls.length > 0 means discovery never runs.
  const usable = (value: string | null | undefined): string | null => {
    const trimmed = value?.trim();
    if (!trimmed) return null;
    if (missionTargetsHomepage(mission.missionType)) return trimmed;
    return isSameLocation(trimmed, site.url) ? null : trimmed;
  };
  const urls = [
    siteMission?.lastKnownUrl,
    ...(siteMission?.alternateUrls ?? []),
  ]
    .map(usable)
    .filter((u): u is string => Boolean(u));
  if (urls.length === 0 && missionTargetsHomepage(mission.missionType)) {
    urls.push(site.url);
  }
  return [...new Set(urls)].slice(0, MAX_PAGES_PER_MISSION);
}

/** Finds a page for a mission the dealer record has no URL for: the dealer's
 *  own nav first, then the platform default paths.
 *
 *  Only runs when nothing is configured. When the record does list URLs, those
 *  are the answer and this is never called — see runMissionInSession. */
async function discoverUrl(
  session: CollectorSession,
  mission: Mission,
  site: Site
): Promise<string | null> {
  const base = site.url.replace(/\/+$/, "");
  const defaultPaths = PLATFORM_DEFAULT_PATHS[mission.missionType].map(
    (path) => `${base}/${path}`
  );
  const keywords = DISCOVERY_KEYWORDS[mission.missionType];

  // The dealer's own nav first, then the platform paths — a link the dealer
  // labels as specials beats any path convention, and plenty of dealers sit on
  // a vanity URL no list could guess.
  const navMatches: string[] = [];
  if (keywords.length > 0) {
    const links = await session.collectLinks(site.url);
    // First usable match per keyword — see the note in chrome-collector's
    // discoverMissionUrl for why the same-location test belongs here.
    for (const keyword of keywords) {
      const match = links.find(
        (l) =>
          navTextMatchesKeyword(l.text, keyword) &&
          !navLinkIsExcluded(l.text, l.href, mission.missionType) &&
          !isSameLocation(l.href, site.url)
      );
      if (match && !navMatches.includes(match.href)) navMatches.push(match.href);
    }
  }
  // The cap applies to nav matches only — see MAX_DISCOVERY_CANDIDATES. The
  // default paths are a short fixed list and always get probed.
  const candidates = [
    ...new Set([
      ...navMatches.slice(0, MAX_DISCOVERY_CANDIDATES),
      ...defaultPaths,
    ]),
  ]
    // A candidate that resolves back to the homepage is the bug discovery
    // exists to stop — an `href="#"` toggle resolves to `/#`.
    .filter((candidate) => !isSameLocation(candidate, site.url));

  // First candidate that loads wins. Every candidate here is already justified
  // as a specials location, so there is nothing to rank — and nothing to settle
  // for when none of them load. See discoverMissionUrl in chrome-collector.ts
  // for why this is not gated on pageHasOfferSignal: an empty specials page is
  // a normal early-in-the-month state and still the correct page.
  for (const candidate of candidates) {
    const landed = await session.probeUrl(candidate);
    if (!landed) continue;
    // A candidate that quietly redirected to the homepage did not exist. See
    // probeUrl and chrome-collector's discoverMissionUrl.
    if (isSameLocation(landed.url, site.url)) continue;
    if (urlIsBannedProgram(landed.url) || pageIsBannedProgram(landed.html)) {
      continue;
    }
    return landed.url;
  }
  return null;
}

/** Site memory: remember what worked for this dealer+mission. Creates the
 *  site_missions row when collection succeeded purely via discovery.
 *
 *  `discoveredUrl` non-null means discovery ran this visit — either nothing was
 *  configured, or everything configured captured nothing at all and the
 *  dead-link fallback found a live page. Both are worth memorizing, so it
 *  overwrites `lastKnownUrl`. When every configured URL worked, `discoveredUrl`
 *  is null and the existing memory is left untouched. */
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
        ...(discoveredUrl ? { lastKnownUrl: discoveredUrl } : {}),
      },
    });
}

/** Uploads a page capture's screenshot, HTML, and any exploration shots. */
async function uploadCaptureEvidence(
  base: { collectionRunId: string; siteId: string; missionType: MissionType },
  capture: PageCapture
): Promise<Evidence[]> {
  // Page-capture label: the page's own title plus the path it came from, so
  // the full-page screenshot and HTML aren't just "Screenshot · Site".
  const pageLabel = pageCaptureLabel(capture.pageTitle, capture.finalUrl);
  const out: Evidence[] = [
    await uploadEvidence({
      ...base,
      evidenceType: "screenshot",
      fileName: "screenshot.png",
      body: capture.screenshot,
      label: pageLabel,
    }),
    await uploadEvidence({
      ...base,
      evidenceType: "html_snapshot",
      fileName: "snapshot.html",
      body: Buffer.from(capture.html, "utf-8"),
      label: pageLabel,
    }),
  ];
  for (const shot of capture.extraShots) {
    out.push(
      await uploadEvidence({
        ...base,
        evidenceType: shot.kind,
        fileName: `${shot.label}.png`,
        body: shot.image,
        label: shot.label,
        textContent: shot.text,
      })
    );
  }
  // On image-rendered platforms the offer lives inside a JPEG, so the ad
  // graphic is evidence too — captured here rather than re-downloaded from the
  // dealer's CDN at analysis time.
  await captureAdImages({
    ...base,
    html: capture.html,
    pageUrl: capture.finalUrl,
  });
  return out;
}

/** Runs one mission for a site inside an already-open session, reusing the
 *  shared capture cache. The session and cache belong to the site visit, so
 *  this never launches its own browser. */
export async function runMissionInSession(
  session: CollectorSession,
  input: {
    collectionRunId: string;
    mission: Mission;
    site: Site;
    siteMission: SiteMission | null;
  },
  captureCache: CaptureCache
): Promise<MissionRunResult> {
  const { collectionRunId, mission, site, siteMission } = input;
  const base = {
    collectionRunId,
    siteId: site.id,
    missionType: mission.missionType,
  };
  const explore = MISSION_EXPLORATION[mission.missionType];
  const sig = exploreSignature(explore);

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
      const cacheKey = `${url}|${sig}`;
      let capture = captureCache.get(cacheKey);
      if (!capture) {
        capture = await session.capturePage(url, explore);
        captureCache.set(cacheKey, capture);
      }
      evidence.push(...(await uploadCaptureEvidence(base, capture)));
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
              label: `Failed: ${url}`,
            })
          );
        } catch {
          // Evidence storage failing must not mask the original error.
        }
      }
      firstError ??= cleanErrorMessage(err);
    }
  }

  // Dead-link self-heal, and only that. Discovery used to re-run here whenever
  // a memorized URL captured nothing *or* showed no pricing, and swap in
  // whatever it found — which meant a specials page that was simply empty
  // (normal early in the month) got silently replaced by some other page that
  // happened to have a price on it. A configured page with no specials on it is
  // a correct, reportable result, not a reason to go looking.
  //
  // Capturing NOTHING is different: the page is gone. Most of these URLs were
  // never typed by an operator — recordSuccess memorizes whatever discovery
  // found, and configuredUrls then treats it as configured — so "the operator
  // fixes the record" is not an available outcome for a URL nobody knows
  // exists. Without this, a discovered page that the dealer's CMS later renames
  // fails the mission on every run from then on.
  if (pagesCaptured === 0 && discoveredUrl === null) {
    const freshUrl = await discoverUrl(session, mission, site);
    if (freshUrl && !urls.includes(freshUrl)) {
      try {
        const cacheKey = `${freshUrl}|${sig}`;
        let capture = captureCache.get(cacheKey);
        if (!capture) {
          capture = await session.capturePage(freshUrl, explore);
          captureCache.set(cacheKey, capture);
        }
        evidence.push(...(await uploadCaptureEvidence(base, capture)));
        pagesCaptured++;
        successfulUrl ??= freshUrl;
        // Promoted, so the next run goes straight here.
        discoveredUrl = freshUrl;
      } catch (err) {
        firstError ??= cleanErrorMessage(err);
      }
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
}

/** Outcome of visiting one site: per-mission results, settled in order. */
export interface SiteCollectionResult {
  results: Map<string, MissionRunResult>;
  /** True when at least one mission captured something — drives freshness. */
  anySuccess: boolean;
}

function isCapture(result: MissionRunResult | undefined): boolean {
  return (result?.pagesCaptured ?? 0) > 0;
}

/** Runs every mission for one site inside a single browser session, reusing
 *  one capture cache. `onResult` fires as each mission settles so the UI can
 *  track live progress. A session launch/crash leaves any unreached missions
 *  unrecorded; the caller's retry pass picks them up. */
async function collectSiteOnce(
  input: {
    collectionRunId: string;
    site: Site;
    works: SiteMissionWork[];
  },
  results: Map<string, MissionRunResult>,
  onResult: (missionId: string, result: MissionRunResult) => Promise<void>
): Promise<void> {
  const { collectionRunId, site, works } = input;
  await withCollectorSession(async (session) => {
    const cache: CaptureCache = new Map();
    for (const { mission, siteMission } of works) {
      const result = await runMissionInSession(
        session,
        { collectionRunId, mission, site, siteMission },
        cache
      );
      results.set(mission.id, result);
      await onResult(mission.id, result);
    }
  });
}

/** Phase 8 single-visit-per-site collection. Visits the site once for all its
 *  missions; any mission that captured nothing gets a second swing in a fresh
 *  browser session (browser crash, memory pressure, transient block). */
export async function collectSite(
  input: {
    collectionRunId: string;
    site: Site;
    works: SiteMissionWork[];
  },
  onResult: (missionId: string, result: MissionRunResult) => Promise<void>
): Promise<SiteCollectionResult> {
  const { collectionRunId, site, works } = input;
  const results = new Map<string, MissionRunResult>();

  const failAll = async (reason: string) => {
    for (const { mission } of works) {
      if (results.has(mission.id)) continue;
      const result: MissionRunResult = {
        missionId: mission.id,
        siteId: site.id,
        status: "failure",
        pagesCaptured: 0,
        pagesAttempted: 0,
        notFound: false,
        evidence: [],
        error: reason,
      };
      results.set(mission.id, result);
      await onResult(mission.id, result);
    }
  };

  // First pass: one session for the whole site.
  try {
    await collectSiteOnce({ collectionRunId, site, works }, results, onResult);
  } catch (err) {
    // The session itself failed (launch/crash) — record the rest as failures
    // so the retry pass below can take a swing at them.
    await failAll(cleanErrorMessage(err));
  }

  // Second swing: retry every mission that captured nothing, in a fresh
  // session, replacing the result only when the retry does better.
  const retryWorks = works.filter(
    ({ mission }) => !isCapture(results.get(mission.id))
  );
  if (retryWorks.length > 0) {
    const retryResults = new Map<string, MissionRunResult>();
    try {
      await collectSiteOnce(
        { collectionRunId, site, works: retryWorks },
        retryResults,
        async (missionId, result) => {
          if (isCapture(result)) {
            results.set(missionId, result);
            await onResult(missionId, result);
          }
        }
      );
    } catch {
      // Fallback session also failed — keep the first pass's failures.
    }
  }

  const anySuccess = [...results.values()].some(isCapture);
  return { results, anySuccess };
}
