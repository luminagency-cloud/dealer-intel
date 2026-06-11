import { chromium, type Browser, type Page } from "playwright";
import { suppressOverlays } from "./overlays";

/**
 * Generic page collection (Phase 5). The engine understands navigation and
 * capture only — mission semantics arrive in Phase 6 (AD-003).
 */

const VIEWPORT = { width: 1366, height: 900 };
const NAVIGATION_TIMEOUT_MS = 45_000;
const SETTLE_MS = 1_500;
const SCROLL_STEP_PX = 700;
const MAX_SCROLL_STEPS = 25;

export interface PageCapture {
  screenshot: Buffer;
  html: string;
  finalUrl: string;
  pageTitle: string;
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

/** Visits a URL and captures a full-page screenshot plus the rendered HTML.
 *  Throws CollectionError (with a failure screenshot when possible). */
export async function capturePage(url: string): Promise<PageCapture> {
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: VIEWPORT,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });
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
      await page.waitForTimeout(SETTLE_MS);

      const [screenshot, html] = [
        await page.screenshot({ fullPage: true, type: "png" }),
        await page.content(),
      ];
      return {
        screenshot,
        html,
        finalUrl: page.url(),
        pageTitle: await page.title(),
      };
    } catch (err) {
      const failureScreenshot = await page
        .screenshot({ type: "png" })
        .catch(() => undefined);
      throw new CollectionError(
        err instanceof Error ? err.message : String(err),
        failureScreenshot
      );
    }
  } finally {
    await browser?.close().catch(() => {});
  }
}
