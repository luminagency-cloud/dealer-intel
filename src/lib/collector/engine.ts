import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { suppressOverlays } from "./overlays";
import {
  captureDisclaimers,
  expandAccordions,
  exploreCarousels,
  exploreTabs,
  type ExtraShot,
} from "./explorers";

/**
 * Generic page collection. The engine understands navigation, exploration
 * mechanics, and capture only — mission semantics live in the mission
 * runner (AD-003).
 */

const VIEWPORT = { width: 1366, height: 900 };
const NAVIGATION_TIMEOUT_MS = 45_000;
const SETTLE_MS = 1_500;
const SCROLL_STEP_PX = 700;
const MAX_SCROLL_STEPS = 25;
const LOADING_SETTLE_TIMEOUT_MS = 10_000;

export interface ExploreOptions {
  carousels?: boolean;
  tabs?: boolean;
  accordions?: boolean;
  disclaimers?: boolean;
}

export interface PageCapture {
  screenshot: Buffer;
  html: string;
  finalUrl: string;
  pageTitle: string;
  /** Viewport captures from carousel/tab exploration, in capture order. */
  extraShots: ExtraShot[];
}

// First line only, without ANSI styling — Playwright errors append a
// multi-line, terminal-formatted call log. Pattern built via fromCharCode
// so no raw control character lives in this source file.
const ANSI_PATTERN = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");

export function cleanErrorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err))
    .split("\n")[0]
    .replace(ANSI_PATTERN, "")
    .trim();
}

export class CollectionError extends Error {
  /** Screenshot of the page at the moment of failure, when one could be taken. */
  failureScreenshot?: Buffer;

  constructor(message: string, failureScreenshot?: Buffer) {
    super(message);
    this.name = "CollectionError";
    this.failureScreenshot = failureScreenshot;
  }
}

/** Dealer platforms (notably Dealer.com service/coupon pages) ship a short
 *  "Loading…" placeholder document and inject the real offer content over XHR a
 *  beat later. Because that placeholder is short, `scrollThroughPage` no-ops on
 *  it, and if `networkidle` happens to resolve early the capture can land on the
 *  spinner instead of the coupons. Wait for any visible "Loading"-only element
 *  to clear before we scroll and capture.
 *
 *  Best-effort and bounded: the predicate matches only elements whose *own* text
 *  is a short spinner label starting with "Loading" (e.g. "Loading specials...",
 *  "Loading…"), so page prose isn't a false positive, and a perpetual
 *  below-the-fold spinner just hits the timeout rather than blocking the
 *  capture. */
async function waitForLoadingToClear(page: Page): Promise<void> {
  await page
    .waitForFunction(
      () => {
        for (const el of document.querySelectorAll("body *")) {
          if (!(el instanceof HTMLElement)) continue;
          if (el.offsetParent === null) continue; // not visible
          const ownText = Array.from(el.childNodes)
            .filter((n) => n.nodeType === Node.TEXT_NODE)
            .map((n) => n.textContent ?? "")
            .join("")
            .trim();
          // Short "Loading…" / "Loading specials..." label — a spinner, not
          // prose (the length cap keeps sentences that merely start with
          // "loading" from matching).
          if (/^loading\b/i.test(ownText) && ownText.length <= 25) return false;
        }
        return true;
      },
      { timeout: LOADING_SETTLE_TIMEOUT_MS, polling: 250 }
    )
    .catch(() => {});
}

/** Roadmap "Page Scroller": controlled full-page pass so lazy-loaded
 *  content renders before capture, then back to the top. */
async function scrollThroughPage(page: Page): Promise<void> {
  await page.evaluate(
    async ({ step, maxSteps }) => {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < maxSteps; i++) {
        const bottom = window.innerHeight + window.scrollY;
        if (bottom >= document.body.scrollHeight) break;
        window.scrollBy(0, step);
        await sleep(150);
      }
      window.scrollTo(0, 0);
      await sleep(300);
    },
    { step: SCROLL_STEP_PX, maxSteps: MAX_SCROLL_STEPS }
  );
}

async function capturePageInContext(
  context: BrowserContext,
  url: string,
  explore: ExploreOptions
): Promise<PageCapture> {
  const page = await context.newPage();
  try {
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    });
    // A 404/5xx page still "loads" as far as Playwright is concerned — it's
    // real HTML Playwright will happily screenshot. Left unchecked, that page
    // gets uploaded as if it were legitimate evidence and, worse, memorized as
    // the site's URL for this mission forever (see mission-runner.ts
    // recordSuccess). Treat a non-OK response as a capture failure so it falls
    // through to the caller's error handling / rediscovery instead.
    if (!response || !response.ok()) {
      throw new Error(
        `HTTP ${response ? response.status() : "no response"} loading ${url}`
      );
    }
    // Dealer sites rarely reach networkidle (chat/analytics keep sockets
    // open) — wait for it briefly, then proceed regardless.
    await page
      .waitForLoadState("networkidle", { timeout: 10_000 })
      .catch(() => {});

    await suppressOverlays(page);
    // Let client-injected "Loading…" placeholders resolve to real content
    // before scrolling — otherwise the page is still a short spinner and the
    // scroll pass no-ops on it.
    await waitForLoadingToClear(page);
    await scrollThroughPage(page);
    // Overlays can re-open after scrolling (exit-intent, delayed consent).
    await suppressOverlays(page);

    const extraShots: ExtraShot[] = [];
    if (explore.accordions) await expandAccordions(page);
    if (explore.tabs) extraShots.push(...(await exploreTabs(page)));
    if (explore.carousels) extraShots.push(...(await exploreCarousels(page)));
    if (explore.disclaimers)
      extraShots.push(...(await captureDisclaimers(page)));

    await page.waitForTimeout(SETTLE_MS);
    const screenshot = await page.screenshot({ fullPage: true, type: "png" });
    const html = await page.content();
    return {
      screenshot,
      html,
      finalUrl: page.url(),
      pageTitle: await page.title(),
      extraShots,
    };
  } catch (err) {
    const failureScreenshot = await page
      .screenshot({ type: "png" })
      .catch(() => undefined);
    throw new CollectionError(
      err instanceof Error ? err.message : String(err),
      failureScreenshot
    );
  } finally {
    await page.close().catch(() => {});
  }
}

/** Runs `fn` with a collector browser session. One browser serves all the
 *  pages of a mission, so multi-page missions don't pay a launch per page. */
export async function withCollectorSession<T>(
  fn: (session: CollectorSession) => Promise<T>
): Promise<T> {
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: VIEWPORT,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      // Dealer sites' certs occasionally expire or briefly go invalid;
      // we're only reading public marketing pages, not submitting
      // credentials, so proceed anyway rather than losing the mission.
      ignoreHTTPSErrors: true,
    });
    return await fn(new CollectorSession(context));
  } finally {
    await browser?.close().catch(() => {});
  }
}

export class CollectorSession {
  constructor(private context: BrowserContext) {}

  /** Visits a URL and captures a full-page screenshot, rendered HTML, and
   *  any exploration shots. Throws CollectionError on failure. */
  capturePage(url: string, explore: ExploreOptions = {}): Promise<PageCapture> {
    return capturePageInContext(this.context, url, explore);
  }

  /** Resolves to the URL actually served, or null if the probe failed.
   *
   *  Returns the final URL rather than a boolean because a 200 does not mean
   *  the page exists: most non-Dealer.com platforms answer an unknown path with
   *  200 and a silent redirect to the homepage, so the caller has to compare
   *  where it landed against where it asked to go.
   *
   *  Reads the URL after the page settles, not at `domcontentloaded`. Plenty of
   *  those bounces are a `<meta http-equiv="refresh">` or a `location.href` in
   *  a head script rather than an HTTP 3xx, and at `domcontentloaded` the URL
   *  is still the one we asked for — so the landing check would wave the
   *  homepage through. Cheaper than a full capture but not free: it fetches the
   *  settled DOM. */
  async probeUrl(url: string): Promise<{ url: string; html: string } | null> {
    const page = await this.context.newPage();
    try {
      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 20_000,
      });
      if (response === null || !response.ok()) return null;
      // Give a meta-refresh or scripted redirect its chance to fire. Both are
      // best-effort: a page that simply loads slowly still resolves here.
      await page.waitForLoadState("load", { timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(750);
      return { url: page.url(), html: await page.content() };
    } catch {
      return null;
    } finally {
      await page.close().catch(() => {});
    }
  }

  /** Loads a page and returns its same-host links as {text, href} pairs.
   *  Used for navigation discovery. */
  async collectLinks(url: string): Promise<{ text: string; href: string }[]> {
    const page = await this.context.newPage();
    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: NAVIGATION_TIMEOUT_MS,
      });
      const host = new URL(page.url()).host;
      const links = await page.evaluate(() =>
        [...document.querySelectorAll("a[href]")]
          // Skip submenu openers — see isMenuToggle in chrome-collector.ts.
          // Dealer.com's "Finance & Specials" is one of these and its href is
          // the finance department, not the specials page under it.
          .filter(
            (a) =>
              a.getAttribute("data-toggle") !== "dropdown" &&
              !a.classList.contains("nav-with-children")
          )
          .map((a) => ({
            text: (a.textContent ?? "").trim().toLowerCase(),
            href: (a as HTMLAnchorElement).href,
          }))
      );
      return links.filter((l) => {
        try {
          return new URL(l.href).host === host && l.text.length > 0;
        } catch {
          return false;
        }
      });
    } catch {
      return [];
    } finally {
      await page.close().catch(() => {});
    }
  }
}

/** Single-page convenience wrapper used by the Phase 5 manual collect. */
export async function capturePage(
  url: string,
  explore: ExploreOptions = {}
): Promise<PageCapture> {
  return withCollectorSession((session) => session.capturePage(url, explore));
}
