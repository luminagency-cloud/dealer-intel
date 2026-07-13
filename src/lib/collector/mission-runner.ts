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
  MISSION_EXPLORATION,
  PLATFORM_DEFAULT_PATHS,
  missionTargetsHomepage,
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

/** Missions where a reachable-but-empty page is a real problem worth guarding
 *  against: a dealer's generic "/promotions" guess path routinely redirects to
 *  a nav hub (links to New Inventory / Service / About, no cards) rather than
 *  the actual specials, and that hub still returns 200 — so plain reachability
 *  isn't enough signal to trust it. Homepage/banner missions are teasers by
 *  design (thin content is expected there), so they're exempt. */
const SIGNAL_CHECKED_MISSIONS: MissionType[] = ["finance_offers", "service_specials"];

/** Cheap, collector-local heuristic for "does this page carry a priced offer
 *  at all" — deliberately NOT the analysis extractor (collection must not
 *  depend on analysis logic; Collect and Analyze are separate phases, see
 *  AGENTS.md). Used only to rank discovery candidates, never to produce an
 *  offer record. */
function pageHasOfferSignal(html: string): boolean {
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return (
    /\$\s?[\d,]{2,7}\s*(?:\/|per\s+|a\s+)?\s*(?:mo(?:nthly)?\b|month\b)/i.test(text) ||
    /\d+(?:\.\d+)?\s*%\s*(?:APR\b|off\b|financing\b)/i.test(text) ||
    /\$\s?[\d,]{1,7}\s*(?:cash back|customer cash|rebate|off\b)/i.test(text)
  );
}

/** Recovery sequence steps 3-4: platform default paths, then nav discovery.
 *
 *  For finance/service missions, reachability alone isn't good enough to pick
 *  a winner: the first default-path guess that responds 200 might be a bare
 *  nav hub while a later candidate (often the nav-discovered one) is where the
 *  real specials live. So every candidate — default paths AND nav-keyword
 *  matches — is captured and the first one showing actual pricing/discount
 *  signal wins. Falls back to the first merely-reachable candidate when none
 *  show signal, so discovery never regresses to finding nothing. Other
 *  mission types keep the original cheap probe-only behavior. */
async function discoverUrl(
  session: CollectorSession,
  mission: Mission,
  site: Site
): Promise<string | null> {
  const base = site.url.replace(/\/+$/, "");
  const candidates = PLATFORM_DEFAULT_PATHS[mission.missionType].map(
    (path) => `${base}/${path}`
  );

  if (!SIGNAL_CHECKED_MISSIONS.includes(mission.missionType)) {
    for (const candidate of candidates) {
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

  const keywords = DISCOVERY_KEYWORDS[mission.missionType];
  if (keywords.length > 0) {
    const links = await session.collectLinks(site.url);
    for (const keyword of keywords) {
      const match = links.find((l) => l.text.includes(keyword));
      if (match && !candidates.includes(match.href)) candidates.push(match.href);
    }
  }

  let fallback: string | null = null;
  for (const candidate of candidates) {
    let capture: PageCapture;
    try {
      capture = await session.capturePage(candidate, {});
    } catch {
      continue;
    }
    fallback ??= candidate;
    if (pageHasOfferSignal(capture.html)) return candidate;
  }
  return fallback;
}

/** Site memory: remember what worked for this dealer+mission. Creates the
 *  site_missions row when collection succeeded purely via discovery.
 *
 *  `discoveredUrl` non-null means discovery actually ran this visit (either
 *  because nothing was memorized, or because the memorized URL turned out
 *  stale/empty and got re-validated — see the rediscovery fallback in
 *  runMissionInSession) — so it overwrites whatever was memorized rather than
 *  only filling a null slot. When discovery didn't run, `discoveredUrl` is
 *  null and the existing memory is left untouched. */
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
  const checkSignal = SIGNAL_CHECKED_MISSIONS.includes(mission.missionType);

  let urls = configuredUrls(mission, siteMission, site);
  const wasMemorized = urls.length > 0;
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
  let anySignal = false;
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
      if (checkSignal && pageHasOfferSignal(capture.html)) anySignal = true;
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

  // A memorized URL that now errors outright (dead link) or that loads fine
  // but shows no pricing/discount signal at all (drifted to a nav hub) is no
  // longer trustworthy — re-run discovery once as a fallback and, if it finds
  // something better, promote it. Without this, a site can get stuck on a
  // stale/empty URL indefinitely: nothing here ever re-validates a memorized
  // URL once it's been recorded as "working".
  if (
    wasMemorized &&
    (pagesCaptured === 0 || (checkSignal && !anySignal))
  ) {
    const freshUrl = await discoverUrl(session, mission, site);
    if (freshUrl && !urls.includes(freshUrl)) {
      try {
        const cacheKey = `${freshUrl}|${sig}`;
        let capture = captureCache.get(cacheKey);
        if (!capture) {
          capture = await session.capturePage(freshUrl, explore);
          captureCache.set(cacheKey, capture);
        }
        const freshHasSignal = !checkSignal || pageHasOfferSignal(capture.html);
        // Only keep this extra capture when it's actually an improvement —
        // the old URL captured nothing at all, or this one carries signal the
        // old one lacked. Otherwise discard it silently; the old result already
        // stands.
        if (pagesCaptured === 0 || freshHasSignal) {
          evidence.push(...(await uploadCaptureEvidence(base, capture)));
          pagesCaptured++;
          successfulUrl ??= freshUrl;
          discoveredUrl = freshUrl;
          if (freshHasSignal) anySignal = true;
        }
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

/** Single-mission collection in its own browser session. Retained for the
 *  Phase 5/6 ad-hoc collect path; run execution uses collectSite. */
export async function runMission(input: {
  collectionRunId: string;
  mission: Mission;
  site: Site;
  siteMission: SiteMission | null;
}): Promise<MissionRunResult> {
  return withCollectorSession((session) =>
    runMissionInSession(session, input, new Map())
  );
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
