import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
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
  DISCOVERY_KEYWORDS,
  MISSION_EXPLORATION,
  PLATFORM_DEFAULT_PATHS,
  missionTargetsHomepage,
  pageHasOfferSignal,
} from "@/lib/collector/mission-knowledge";
import { captureAdImages } from "@/lib/collector/ad-images";

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
  url: string;
  explore: {
    carousels: boolean;
    tabs: boolean;
    accordions: boolean;
    disclaimers: boolean;
  };
}

export interface ChromeCollectionJob {
  protocolVersion: number;
  runId: string;
  items: ChromeCollectionItem[];
}

/** How long a Chrome run may go silent before we call its tab dead.
 *  ponytail: the heartbeat piggybacks on the extension's existing result POSTs
 *  rather than a dedicated ping, so this window has to cover the longest
 *  plausible gap between captures. Add a real ping if a slow dealer page ever
 *  trips it mid-run. */
export const CHROME_HEARTBEAT_STALE_MS = 3 * 60_000;

/** Chrome collection happens in the operator's browser, so `isRunExecuting`
 *  (the in-process Playwright registry) never knows about it. A fresh
 *  heartbeat is what "this run is actually collecting right now" means. */
export function isChromeRunLive(run: {
  collectorMode: string;
  status: string;
  chromeHeartbeatAt: Date | null;
}): boolean {
  if (run.collectorMode !== "chrome_extension" || run.status !== "running") {
    return false;
  }
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

const DISCOVERY_TIMEOUT_MS = 20_000;
const MAX_DISCOVERY_CANDIDATES = 6;
const DISCOVERY_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const NO_MISSION_URL_ERROR =
  "No URL configured and discovery found no matching page. " +
  "Set a URL on the site's mission config.";

const MAX_REDIRECT_HOPS = 10;

/** Best-effort GET of a dealer page's markup. Null on any non-OK response,
 *  timeout, or transport error — discovery treats all of those the same way.
 *
 *  Redirects are followed by hand so cookies carry across hops. Several dealer
 *  platforms bounce the first request through a cookie-setting redirect and,
 *  seeing no cookie come back, redirect again forever — `redirect: "follow"`
 *  has no jar, so it just burns its 20 hops and throws. Bristol Toyota's
 *  service and finance pages were both unreachable that way and resolve in one
 *  hop with the cookie echoed back. */
async function fetchPageHtml(url: string): Promise<string | null> {
  const jar = new Map<string, string>();
  let current = url;
  try {
    for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop += 1) {
      const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
      const response = await fetch(current, {
        headers: {
          "user-agent": DISCOVERY_USER_AGENT,
          accept: "text/html",
          ...(cookie ? { cookie } : {}),
        },
        redirect: "manual",
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      });
      for (const header of response.headers.getSetCookie()) {
        const [pair] = header.split(";");
        const split = pair.indexOf("=");
        if (split > 0) {
          jar.set(pair.slice(0, split).trim(), pair.slice(split + 1).trim());
        }
      }
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        current = new URL(location, current).toString();
        continue;
      }
      if (!response.ok) return null;
      return await response.text();
    }
    return null;
  } catch {
    return null;
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Enough entity decoding to match link text the way a browser would. Dealer
 *  nav is full of `Service &amp; Parts Specials`, and DISCOVERY_KEYWORDS is
 *  written in decoded form ("service & parts special"), so skipping this makes
 *  every ampersand keyword silently unmatchable. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, ref: string) => {
    if (ref.startsWith("#")) {
      const code = ref[1]?.toLowerCase() === "x"
        ? Number.parseInt(ref.slice(2), 16)
        : Number.parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0
        ? String.fromCodePoint(code)
        : match;
    }
    return NAMED_ENTITIES[ref.toLowerCase()] ?? match;
  });
}

/** Same-host `{text, href}` pairs parsed out of raw markup — the fetch-based
 *  twin of CollectorSession.collectLinks. Dealer platforms server-render their
 *  primary nav, so a plain GET sees the same links a browser would. */
export function pageLinks(
  html: string,
  pageUrl: string
): { text: string; href: string }[] {
  const host = new URL(pageUrl).host;
  const links: { text: string; href: string }[] = [];
  const anchors = html.matchAll(
    /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  );
  for (const [, href, inner] of anchors) {
    const text = decodeEntities(inner.replace(/<[^>]+>/g, " "))
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    if (!text) continue;
    try {
      const resolved = new URL(decodeEntities(href), pageUrl);
      if (resolved.host === host) {
        links.push({ text, href: resolved.toString() });
      }
    } catch {
      // Malformed href (javascript:, tel:, template placeholder) — skip.
    }
  }
  return links;
}

/** Finds the page a mission should actually collect, over plain HTTP.
 *
 *  Chrome collection runs in the operator's browser and has no discovery of
 *  its own, so before this the job builder simply handed every mission the
 *  dealer homepage — which is why service_specials was screenshotting hero
 *  carousels. Discovery mirrors the Current collector's recovery sequence but
 *  uses fetch instead of Playwright: dealer nav is server-rendered, so a GET
 *  is enough and costs no browser.
 *
 *  Nav links come first because, measured against the live dealer list, the
 *  hardcoded platform paths 404 on nearly every site. */
export async function discoverMissionUrl(
  site: Site,
  missionType: MissionType,
  homepageHtml: string | null
): Promise<string | null> {
  const base = site.url.replace(/\/+$/, "");
  const navMatches: string[] = [];
  if (homepageHtml) {
    const links = pageLinks(homepageHtml, site.url);
    for (const keyword of DISCOVERY_KEYWORDS[missionType]) {
      const match = links.find((link) => link.text.includes(keyword));
      if (match && !navMatches.includes(match.href)) navMatches.push(match.href);
    }
  }
  const candidates = [
    ...new Set([
      ...navMatches,
      ...PLATFORM_DEFAULT_PATHS[missionType].map((path) => `${base}/${path}`),
    ]),
  ]
    // A candidate that resolves back to the homepage is the very bug this
    // discovery exists to stop. Colonial Subaru's "Current Offers" nav entry is
    // an `href="#"` dropdown toggle, which resolves to `/#` — capture that and
    // finance_offers is screenshotting the homepage again.
    .filter((candidate) => !isSameLocation(candidate, site.url))
    .slice(0, MAX_DISCOVERY_CANDIDATES);

  // Reachability alone isn't trusted: a dealer's generic guess path routinely
  // resolves to a nav hub that still returns 200. Take the first candidate
  // carrying actual pricing, and fall back to the first that merely loaded so
  // discovery never regresses to finding nothing.
  let reachable: string | null = null;
  for (const candidate of candidates) {
    const html = await fetchPageHtml(candidate);
    if (!html) continue;
    reachable ??= candidate;
    if (pageHasOfferSignal(html)) return candidate;
  }
  return reachable;
}

type WorkItem = { site: Site; mission: Mission; siteMission: SiteMission | null };

function workKey(siteId: string, missionId: string): string {
  return `${siteId}:${missionId}`;
}

/** Resolves the collection URL for every work item, keyed `siteId:missionId`.
 *  A null value means the mission has nowhere to go and must not be handed to
 *  Chrome — capturing the homepage instead is what produced eight copies of a
 *  Frontier ad in place of a service-specials page. */
async function resolveCollectionUrls(
  items: WorkItem[]
): Promise<Map<string, string | null>> {
  const bySite = new Map<string, WorkItem[]>();
  for (const item of items) {
    const group = bySite.get(item.site.id);
    if (group) group.push(item);
    else bySite.set(item.site.id, [item]);
  }

  const resolved = new Map<string, string | null>();
  // ponytail: dealers resolve in parallel, missions within a dealer in series
  // so they share one homepage fetch. Unbounded across dealers because they're
  // all different hosts and discovery only runs until a mission's URL is
  // memorized — add a concurrency cap if the dealer list outgrows a few hundred.
  await Promise.all(
    [...bySite.values()].map(async (siteItems) => {
      const { site } = siteItems[0];
      let homepageHtml: string | null | undefined;
      for (const { mission, siteMission } of siteItems) {
        const key = workKey(site.id, mission.id);
        const memorized =
          siteMission?.lastKnownUrl?.trim() ||
          siteMission?.alternateUrls.find((value) => value.trim())?.trim();
        if (memorized) {
          resolved.set(key, memorized);
          continue;
        }
        if (missionTargetsHomepage(mission.missionType)) {
          resolved.set(key, site.url);
          continue;
        }
        if (homepageHtml === undefined) {
          homepageHtml = await fetchPageHtml(site.url);
        }
        resolved.set(
          key,
          await discoverMissionUrl(site, mission.missionType, homepageHtml)
        );
      }
    })
  );
  return resolved;
}

/** Settles the missions Chrome will never be handed, so the run can finalize
 *  instead of sitting on rows that stay pending forever. */
async function failUnresolvedItems(
  runId: string,
  unresolved: WorkItem[]
): Promise<void> {
  if (unresolved.length === 0) return;
  await getDb()
    .update(missionResults)
    .set({
      status: "failure",
      pagesCaptured: 0,
      successfulUrl: null,
      error: NO_MISSION_URL_ERROR,
      completedAt: new Date(),
    })
    .where(
      and(
        eq(missionResults.collectionRunId, runId),
        or(
          ...unresolved.map(({ site, mission }) =>
            and(
              eq(missionResults.siteId, site.id),
              eq(missionResults.missionId, mission.id)
            )
          )
        )
      )
    );
}

/** True when two URLs point at the same page, ignoring a trailing slash. */
export function isSameLocation(left: string, right: string): boolean {
  try {
    const a = new URL(left);
    const b = new URL(right);
    return (
      a.host === b.host &&
      a.pathname.replace(/\/$/, "") === b.pathname.replace(/\/$/, "")
    );
  } catch {
    return false;
  }
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
  if (run.collectorMode !== "chrome_extension") {
    throw new ChromeCollectorError(
      "This run is assigned to the Current collector",
      409
    );
  }
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

  const resolvedUrls = await resolveCollectionUrls(items);
  const unresolved = items.filter(
    ({ site, mission }) => !resolvedUrls.get(workKey(site.id, mission.id))
  );

  const chromeItems = items.flatMap(({ site, mission }) => {
    const url = resolvedUrls.get(workKey(site.id, mission.id));
    if (!url) return [];
    const explore = MISSION_EXPLORATION[mission.missionType];
    return [
      {
        siteId: site.id,
        siteName: site.name,
        missionId: mission.id,
        missionType: mission.missionType,
        missionName: mission.name,
        url,
        explore: {
          carousels: Boolean(explore.carousels),
          tabs: Boolean(explore.tabs),
          accordions: Boolean(explore.accordions),
          disclaimers: Boolean(explore.disclaimers),
        },
      },
    ];
  });

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

    // Settled after the seed so these rows exist to update, and before the
    // job goes out so a run made entirely of undiscoverable missions can
    // still reach a terminal status.
    await failUnresolvedItems(runId, unresolved);
    await finalizeRunIfDone(runId);

    return {
      protocolVersion: CHROME_COLLECTOR_PROTOCOL_VERSION,
      runId,
      items: chromeItems,
    };
  }

  // Resuming an already-running run: claim it now so the page reads as live
  // before the first capture lands.
  await touchChromeHeartbeat(runId);
  await failUnresolvedItems(runId, unresolved);
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
  };
}

async function requireChromeWorkItem(
  runId: string,
  siteId: string,
  missionId: string
) {
  const run = await getCollectionRun(runId);
  if (!run) throw new ChromeCollectorError("Run not found", 404);
  if (run.collectorMode !== "chrome_extension") {
    throw new ChromeCollectorError("Run is not assigned to Chrome", 409);
  }
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

  // Same as the Current collector: on image-rendered platforms the offer lives
  // inside a JPEG, so the ad graphic is evidence and belongs to this capture,
  // not to a later analysis pass re-downloading it from the dealer's CDN.
  // Skipped for failure states, which have no page worth mining.
  if (input.stateKind !== "failure") {
    await captureAdImages({
      collectionRunId: input.runId,
      siteId: input.siteId,
      missionType: item.mission.missionType,
      html: input.html,
      pageUrl: input.finalUrl,
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
