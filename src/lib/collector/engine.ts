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
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    });
    // Dealer sites rarely reach networkidle (chat/analytics keep sockets
    // open) — wait for it briefly, then proceed regardless.
    await page
      .waitForLoadState("networkidle", { timeout: 10_000 })
      .catch(() => {});

    await suppressOverlays(page);
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

  /** True when the URL responds without an error status. Used for URL
   *  discovery probing — cheaper than a full capture. */
  async probeUrl(url: string): Promise<boolean> {
    const page = await this.context.newPage();
    try {
      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 20_000,
      });
      return response !== null && response.ok();
    } catch {
      return false;
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
        [...document.querySelectorAll("a[href]")].map((a) => ({
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
