import { and, eq, inArray, isNotNull } from "drizzle-orm";
import {
  collectionRuns,
  evidence,
  getDb,
  missionResults,
  siteMissions,
  sites,
  type Mission,
  type MissionType,
  type Site,
  type SiteMission,
} from "@/lib/db";
import { getCollectionRun, listWorkItemsForRun } from "@/lib/db/repository";
import { uploadEvidence } from "@/lib/evidence";
import { finalizeRunIfDone } from "@/lib/run-executor";
import {
  BANNED_PATTERN_SOURCES,
  DISCOVERY_EXCLUSIONS,
  DISCOVERY_KEYWORDS,
  MAX_DISCOVERY_CANDIDATES,
  MISSION_EXPLORATION,
  PLATFORM_DEFAULT_PATHS,
  exclusionPattern,
  isHomepageUrl,
  isSameLocation,
  keywordPattern,
  missionTargetsHomepage,
} from "@/lib/collector/mission-knowledge";
import { AD_IMAGE_RULES, storeAdImages } from "@/lib/collector/ad-images";

export const CHROME_COLLECTOR_PROTOCOL_VERSION = 3;

export type ChromeCaptureStateKind =
  | "base"
  | "carousel"
  | "tab"
  | "disclaimer"
  | "failure";

export interface ChromeCollectionItem {
  siteId: string;
  siteName: string;
  missionId: string;
  missionType: MissionType;
  missionName: string;
  /** Where to start: the best saved URL, or the dealer's front page when
   *  nothing is configured yet. */
  url: string;
  /** Every URL configured or memorized for this mission, best first. The
   *  extension tries them in order — the operator can park a spare path here
   *  and it gets its turn without waiting for the menu walk. */
  savedUrls: string[];
  /** The dealer's front page. The extension falls back to reading its menu when
   *  no saved URL turns out to be the mission's page. */
  homeUrl: string;
  explore: {
    carousels: boolean;
    tabs: boolean;
    accordions: boolean;
    disclaimers: boolean;
  };
  /** Rules for finding this mission's page in the dealer's own menu, applied by
   *  the extension inside the operator's browser. Null for missions that
   *  legitimately collect the homepage.
   *
   *  Sent as regex sources rather than reimplemented extension-side so there is
   *  one copy of the matching rules. It has to run in Chrome at all because
   *  this process never requests a dealer page: 16 of 62 dealers — the whole
   *  Tasca and Nucar groups, Speedcraft, Mastria — answer a request from here
   *  with a Cloudflare 403 while loading normally in a real browser. Only the
   *  extension can read the menu. */
  discovery: {
    keywordPatterns: string[];
    exclusionPatterns: string[];
    bannedPatterns: string[];
    defaultPaths: string[];
    maxCandidates: number;
  } | null;
  /** Which images on the page count as offer creative. The extension downloads
   *  them inside the dealer's page and uploads the bytes with the capture
   *  state, so the app never requests a dealer-controlled URL. */
  adImageRules: typeof AD_IMAGE_RULES;
}

export interface ChromeCollectionJob {
  protocolVersion: number;
  runId: string;
  items: ChromeCollectionItem[];
  /** Missions failed server-side before the job went out, because no URL could
   *  be resolved for them. They never reach the extension, so the driving tab
   *  cannot count them — it reported "53 succeeded, 1 failed" on a run the run
   *  page showed 10 failures for. Sent so the finished message can agree with
   *  the mission table. */
  unresolved: number;
}

/** How long a Chrome run may go silent before we call its tab dead.
 *  ponytail: the heartbeat piggybacks on the extension's existing result POSTs
 *  rather than a dedicated ping, so this window has to cover the longest
 *  plausible gap between captures. Add a real ping if a slow dealer page ever
 *  trips it mid-run. */
export const CHROME_HEARTBEAT_STALE_MS = 3 * 60_000;

/** Collection happens in the operator's browser, so this process never observes
 *  it directly. A fresh heartbeat is what "this run is actually collecting right
 *  now" means. */
export function isChromeRunLive(run: {
  status: string;
  chromeHeartbeatAt: Date | null;
}): boolean {
  if (run.status !== "running") return false;
  if (!run.chromeHeartbeatAt) return false;
  return Date.now() - run.chromeHeartbeatAt.getTime() < CHROME_HEARTBEAT_STALE_MS;
}

/** Called on every result POST from the driving tab — that traffic is the
 *  proof of life, so no separate ping channel is needed. */
export async function touchChromeHeartbeat(runId: string): Promise<void> {
  await getDb()
    .update(collectionRuns)
    .set({ chromeHeartbeatAt: new Date() })
    .where(eq(collectionRuns.id, runId));
}

export const LANDED_ON_HOMEPAGE_ERROR =
  "Page redirected to the dealer homepage, so this mission captured the wrong " +
  "page. Set a URL on the site's mission config.";

type WorkItem = { site: Site; mission: Mission; siteMission: SiteMission | null };

/** Every URL configured or memorized for a mission, best first.
 *
 *  This is a pure read of what the operator and past runs recorded — the app
 *  never touches the dealer's site. Anti-bot protection is exactly why
 *  collection moved into the operator's Chrome: a plain request from here is
 *  answered with a Cloudflare 403 by 16 of 62 dealers (Speedcraft, the Tasca
 *  and Nucar stores, Mastria) that load normally in a real browser. So the
 *  extension gets the candidate list and the discovery rules, and does every
 *  page load itself.
 *
 *  Each candidate is still sanity-checked here: a memorized homepage is
 *  dropped rather than trusted. The write-side guard is a single point of
 *  failure, and when it silently stopped working every later run re-collected
 *  the homepage for finance/service and reported success. */
function savedMissionUrls(item: WorkItem): string[] {
  const { site, mission, siteMission } = item;
  const usable = (value: string | null | undefined): string | null => {
    const trimmed = value?.trim();
    if (!trimmed) return null;
    if (missionTargetsHomepage(mission.missionType)) return trimmed;
    if (isHomepageUrl(trimmed)) return null;
    return isSameLocation(trimmed, site.url) ? null : trimmed;
  };
  const candidates = [
    usable(siteMission?.lastKnownUrl),
    ...(siteMission?.alternateUrls ?? []).map(usable),
  ].filter((value): value is string => value !== null);
  return [...new Set(candidates)];
}

export { isSameLocation };

/** A work item as the extension needs it. A mission with nothing configured
 *  still goes to Chrome, landing on the homepage with discovery rules attached,
 *  because the dealer's own menu is the way in and only the extension can read
 *  it. That is not a homepage capture: `completeChromeItem` still rejects a
 *  mission that ends there. */
function toChromeItem(item: WorkItem): ChromeCollectionItem {
  const { site, mission } = item;
  const savedUrls = savedMissionUrls(item);
  const explore = MISSION_EXPLORATION[mission.missionType];
  const missionType = mission.missionType;
  return {
    siteId: site.id,
    siteName: site.name,
    missionId: mission.id,
    missionType,
    missionName: mission.name,
    url: savedUrls[0] || site.url,
    savedUrls,
    homeUrl: site.url,
    discovery: missionTargetsHomepage(missionType)
      ? null
      : {
          keywordPatterns: DISCOVERY_KEYWORDS[missionType]
            .map(keywordPattern)
            .filter((pattern): pattern is string => pattern !== null),
          exclusionPatterns:
            DISCOVERY_EXCLUSIONS[missionType].map(exclusionPattern),
          bannedPatterns: BANNED_PATTERN_SOURCES,
          defaultPaths: PLATFORM_DEFAULT_PATHS[missionType],
          maxCandidates: MAX_DISCOVERY_CANDIDATES,
        },
    adImageRules: AD_IMAGE_RULES,
    explore: {
      carousels: Boolean(explore.carousels),
      tabs: Boolean(explore.tabs),
      accordions: Boolean(explore.accordions),
      disclaimers: Boolean(explore.disclaimers),
    },
  };
}

export class ChromeCollectorError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
    this.name = "ChromeCollectorError";
  }
}

/** Seeds the complete run scope before desktop Chrome starts. This keeps the
 *  run lifecycle authoritative on the server while the extension processes
 *  work items sequentially, grouped by dealer. */
export async function startChromeRun(
  runId: string
): Promise<ChromeCollectionJob> {
  const run = await getCollectionRun(runId);
  if (!run) throw new ChromeCollectorError("Run not found", 404);
  if (run.status !== "pending" && run.status !== "running") {
    throw new ChromeCollectorError(
      `Chrome runs must be pending or running; this run is ${run.status}`,
      409
    );
  }

  const items = await listWorkItemsForRun(run);
  if (items.length === 0) {
    throw new ChromeCollectorError("This run has no active work items", 409);
  }

  const chromeItems = items.map(toChromeItem);

  const db = getDb();
  if (run.status === "pending") {
    const now = new Date();
    await db
      .insert(missionResults)
      .values(
        items.map(({ site, mission }) => ({
          collectionRunId: runId,
          missionId: mission.id,
          siteId: site.id,
          missionType: mission.missionType,
          status: "pending" as const,
          startedAt: now,
        }))
      )
      .onConflictDoUpdate({
        target: [
          missionResults.collectionRunId,
          missionResults.siteId,
          missionResults.missionId,
        ],
        set: {
          status: "pending",
          pagesCaptured: 0,
          successfulUrl: null,
          error: null,
          startedAt: now,
          completedAt: null,
        },
      });
    await db
      .update(collectionRuns)
      .set({
        status: "running",
        startedAt: run.startedAt ?? now,
        completedAt: null,
        chromeHeartbeatAt: now,
      })
      .where(eq(collectionRuns.id, runId));

    await finalizeRunIfDone(runId);

    return {
      protocolVersion: CHROME_COLLECTOR_PROTOCOL_VERSION,
      runId,
      items: chromeItems,
      unresolved: 0,
    };
  }

  // Resuming an already-running run: claim it now so the page reads as live
  // before the first capture lands.
  await touchChromeHeartbeat(runId);
  await finalizeRunIfDone(runId);

  const unfinished = await db
    .select({
      siteId: missionResults.siteId,
      missionId: missionResults.missionId,
    })
    .from(missionResults)
    .where(
      and(
        eq(missionResults.collectionRunId, runId),
        inArray(missionResults.status, ["pending", "running"])
      )
    );
  const unfinishedKeys = new Set(
    unfinished.map((item) => `${item.siteId}:${item.missionId}`)
  );

  return {
    protocolVersion: CHROME_COLLECTOR_PROTOCOL_VERSION,
    runId,
    items: chromeItems.filter((item) =>
      unfinishedKeys.has(`${item.siteId}:${item.missionId}`)
    ),
    unresolved: 0,
  };
}

/** Re-collect ONE dealer+mission in Chrome, on a run of any status. The
 *  operator fixed a saved URL on a failed row and wants that page again; the
 *  only alternative was re-running the whole run. */
export async function startChromeItem(
  runId: string,
  siteId: string,
  missionId: string
): Promise<ChromeCollectionJob> {
  const item = await requireChromeWorkItem(runId, siteId, missionId);
  const run = await getCollectionRun(runId);
  const db = getDb();
  const now = new Date();

  // Purge this site+mission's stale evidence so analysis never sees a mix of
  // the old and new captures.
  await db
    .delete(evidence)
    .where(
      and(
        eq(evidence.collectionRunId, runId),
        eq(evidence.siteId, siteId),
        eq(evidence.missionType, item.mission.missionType)
      )
    );

  await db
    .insert(missionResults)
    .values({
      collectionRunId: runId,
      missionId,
      siteId,
      missionType: item.mission.missionType,
      status: "pending" as const,
      startedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        missionResults.collectionRunId,
        missionResults.siteId,
        missionResults.missionId,
      ],
      set: {
        status: "pending",
        pagesCaptured: 0,
        successfulUrl: null,
        error: null,
        startedAt: now,
        completedAt: null,
      },
    });

  // Back to running so `finalizeRunIfDone` re-settles the run once this item
  // lands — a completed run that re-collects a failure should be free to
  // become complete rather than staying stuck at its old verdict.
  await db
    .update(collectionRuns)
    .set({
      status: "running",
      startedAt: run?.startedAt ?? now,
      completedAt: null,
      chromeHeartbeatAt: now,
    })
    .where(eq(collectionRuns.id, runId));

  return {
    protocolVersion: CHROME_COLLECTOR_PROTOCOL_VERSION,
    runId,
    items: [toChromeItem(item)],
    unresolved: 0,
  };
}

async function requireChromeWorkItem(
  runId: string,
  siteId: string,
  missionId: string
) {
  const run = await getCollectionRun(runId);
  if (!run) throw new ChromeCollectorError("Run not found", 404);
  const items = await listWorkItemsForRun(run);
  const item = items.find(
    (candidate) =>
      candidate.site.id === siteId && candidate.mission.id === missionId
  );
  if (!item) throw new ChromeCollectorError("Work item is outside this run", 403);
  return item;
}

export async function uploadChromeCaptureState(input: {
  runId: string;
  siteId: string;
  missionId: string;
  stateId: string;
  stateKind: ChromeCaptureStateKind;
  stateOrder: number;
  finalUrl: string;
  pageTitle: string;
  label: string;
  html: string;
  screenshot: Uint8Array;
  textContent?: string;
  /** Offer-card graphics the extension downloaded inside the dealer's page. */
  adImages: { url: string; body: Buffer }[];
}): Promise<void> {
  const item = await requireChromeWorkItem(
    input.runId,
    input.siteId,
    input.missionId
  );
  const stateId = input.stateId.trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(stateId)) {
    throw new ChromeCollectorError("Invalid capture state id");
  }
  if (!Number.isInteger(input.stateOrder) || input.stateOrder < 0) {
    throw new ChromeCollectorError("Invalid capture state order");
  }
  const manifestStateId = `${input.missionId}:${stateId}`;
  const artifactPrefix = [
    input.runId,
    input.siteId,
    input.missionId,
    stateId,
  ].join(":");
  const label =
    input.label.trim() ||
    `${input.pageTitle.trim() || item.site.name} — ${input.finalUrl}`;
  const metadata = {
    captureStateId: manifestStateId,
    captureState: input.stateKind,
    sourceUrl: input.finalUrl,
    captureOrder: input.stateOrder,
    label,
  };

  await uploadEvidence({
    collectionRunId: input.runId,
    siteId: input.siteId,
    missionType: item.mission.missionType,
    evidenceType:
      input.stateKind === "base" ? "html_snapshot" : "state_html_snapshot",
    fileName: `${stateId}.html`,
    body: Buffer.from(input.html, "utf8"),
    captureKey: `${artifactPrefix}:html`,
    ...metadata,
  });
  await uploadEvidence({
    collectionRunId: input.runId,
    siteId: input.siteId,
    missionType: item.mission.missionType,
    evidenceType:
      input.stateKind === "disclaimer"
        ? "disclaimer_screenshot"
        : input.stateKind === "failure"
          ? "failure_screenshot"
        : "screenshot",
    fileName: `${stateId}.png`,
    body: input.screenshot,
    textContent: input.textContent,
    captureKey: `${artifactPrefix}:screenshot`,
    ...metadata,
  });

  // On image-rendered platforms the offer lives inside a JPEG, so the ad
  // graphic is evidence and belongs to this capture, not to a later analysis
  // pass re-downloading it from the dealer's CDN. The bytes arrive with the
  // capture state: the extension read them inside the dealer's page, because
  // this process never requests a dealer-controlled URL. Skipped for failure
  // states, which have no page worth mining.
  if (input.stateKind !== "failure" && input.adImages.length > 0) {
    await storeAdImages({
      collectionRunId: input.runId,
      siteId: input.siteId,
      missionType: item.mission.missionType,
      images: input.adImages,
      captureStateId: manifestStateId,
    });
  }

  await getDb()
    .update(missionResults)
    .set({ status: "running" })
    .where(
      and(
        eq(missionResults.collectionRunId, input.runId),
        eq(missionResults.siteId, input.siteId),
        eq(missionResults.missionId, input.missionId)
      )
    );
}

async function chromeStateIds(input: {
  runId: string;
  siteId: string;
  missionId: string;
  missionType: MissionType;
}): Promise<Set<string>> {
  const rows = await getDb()
    .select({ captureStateId: evidence.captureStateId })
    .from(evidence)
    .where(
      and(
        eq(evidence.collectionRunId, input.runId),
        eq(evidence.siteId, input.siteId),
        eq(evidence.missionType, input.missionType),
        isNotNull(evidence.captureStateId)
      )
    );
  const prefix = `${input.missionId}:`;
  return new Set(
    rows
      .map((row) => row.captureStateId)
      .filter((value): value is string => Boolean(value?.startsWith(prefix)))
  );
}

export async function completeChromeItem(input: {
  runId: string;
  siteId: string;
  missionId: string;
  finalUrl: string;
  stateCount: number;
}): Promise<void> {
  const item = await requireChromeWorkItem(
    input.runId,
    input.siteId,
    input.missionId
  );
  if (!Number.isInteger(input.stateCount) || input.stateCount < 1) {
    throw new ChromeCollectorError("Chrome collection returned no capture states");
  }
  const stateIds = await chromeStateIds({
    ...input,
    missionType: item.mission.missionType,
  });
  if (!stateIds.has(`${input.missionId}:base`)) {
    throw new ChromeCollectorError("Chrome collection did not upload its base state", 409);
  }
  if (stateIds.size < input.stateCount) {
    throw new ChromeCollectorError(
      `Chrome uploaded ${stateIds.size} of ${input.stateCount} capture states`,
      409
    );
  }

  const now = new Date();
  const db = getDb();

  // Where the browser ACTUALLY landed is the only trustworthy answer. Discovery
  // checks this too, but it checks over `fetch`: no JS, no meta refresh, and
  // often a different response for a non-browser user agent. Measured on the
  // Aug 7 2026 run, 14 of 21 dealers had finance_offers and service_specials
  // resolve to a real-looking path, redirect to the dealer homepage in Chrome,
  // and record as success — so the run reported 53 successes while both
  // missions collected the front page. Analysis then deduped that against the
  // homepage_offers evidence, which is why 17 dealers produced 3 service
  // offers between them. A wrong page captured is a failure, not a success.
  if (
    !missionTargetsHomepage(item.mission.missionType) &&
    (isHomepageUrl(input.finalUrl) || isSameLocation(input.finalUrl, item.site.url))
  ) {
    await db
      .update(missionResults)
      .set({
        status: "failure",
        pagesCaptured: 0,
        successfulUrl: null,
        error: `${LANDED_ON_HOMEPAGE_ERROR} (${input.finalUrl})`,
        completedAt: now,
      })
      .where(
        and(
          eq(missionResults.collectionRunId, input.runId),
          eq(missionResults.siteId, input.siteId),
          eq(missionResults.missionId, input.missionId)
        )
      );
    await finalizeRunIfDone(input.runId);
    return;
  }

  await db
    .update(missionResults)
    .set({
      status: "success",
      pagesCaptured: 1,
      successfulUrl: input.finalUrl,
      error: null,
      completedAt: now,
    })
    .where(
      and(
        eq(missionResults.collectionRunId, input.runId),
        eq(missionResults.siteId, input.siteId),
        eq(missionResults.missionId, input.missionId)
      )
    );
  await db
    .update(sites)
    .set({ lastCollectedAt: now })
    .where(eq(sites.id, input.siteId));

  // Never memorize the dealer homepage as a non-homepage mission's page. A
  // service/finance mission that lands there captured the wrong page, and
  // writing it back pins the mission to the homepage on every later run —
  // memorized URLs win over discovery, so the mistake becomes permanent.
  const memorable =
    missionTargetsHomepage(item.mission.missionType) ||
    !isSameLocation(input.finalUrl, item.site.url);
  if (memorable) {
    // Upsert rather than update: a URL found by discovery has no site_missions
    // row yet, and only writing to an existing row meant every run rediscovered
    // the same page from scratch.
    await db
      .insert(siteMissions)
      .values({
        siteId: input.siteId,
        missionId: input.missionId,
        lastKnownUrl: input.finalUrl,
        lastSuccessAt: now,
      })
      .onConflictDoUpdate({
        target: [siteMissions.siteId, siteMissions.missionId],
        set: { lastKnownUrl: input.finalUrl, lastSuccessAt: now, updatedAt: now },
      });
  } else if (item.siteMission) {
    await db
      .update(siteMissions)
      .set({ lastSuccessAt: now })
      .where(eq(siteMissions.id, item.siteMission.id));
  }

  await finalizeRunIfDone(input.runId);
}

export async function failChromeItem(input: {
  runId: string;
  siteId: string;
  missionId: string;
  error: string;
}): Promise<void> {
  const item = await requireChromeWorkItem(
    input.runId,
    input.siteId,
    input.missionId
  );
  const stateIds = await chromeStateIds({
    ...input,
    missionType: item.mission.missionType,
  });
  const partialCapture = stateIds.size > 0;
  await getDb()
    .update(missionResults)
    .set({
      status: partialCapture ? "needs_review" : "failure",
      pagesCaptured: stateIds.has(`${input.missionId}:base`) ? 1 : 0,
      error: input.error.slice(0, 1000),
      completedAt: new Date(),
    })
    .where(
      and(
        eq(missionResults.collectionRunId, input.runId),
        eq(missionResults.siteId, input.siteId),
        eq(missionResults.missionId, input.missionId)
      )
    );
  await finalizeRunIfDone(input.runId);
}
