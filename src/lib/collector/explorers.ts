import type { Page } from "playwright";

/**
 * Exploration behaviors (roadmap: Carousel/Tab/Accordion Explorers).
 * Missions choose which behaviors run; the explorers themselves are
 * mission-agnostic. All best-effort: exploration never fails a collection.
 */

const MAX_CAROUSEL_SLIDES = 6;
const MAX_TABS = 8;
const MAX_ACCORDIONS = 15;

const CAROUSEL_NEXT_SELECTORS = [
  ".slick-next",
  ".swiper-button-next",
  ".carousel-control-next",
  '[class*="carousel" i] button[aria-label*="next" i]',
  '[class*="slider" i] button[aria-label*="next" i]',
  'button[aria-label="Next slide" i]',
];

const TAB_SELECTORS = [
  '[role="tablist"] [role="tab"]',
  ".nav-tabs a",
  ".nav-tabs button",
];

const ACCORDION_SELECTORS = [
  'button[aria-expanded="false"]',
  '[class*="accordion" i] [aria-expanded="false"]',
  "details:not([open]) summary",
];

export interface ExtraShot {
  label: string;
  image: Buffer;
  /** Evidence type the shot should be stored as. */
  kind: "screenshot" | "disclaimer_screenshot";
}

const MAX_DISCLAIMERS = 8;

const DISCLAIMER_BUTTON_SELECTORS = [
  '[class*="disclaimer" i]:is(button, a)',
  'button:has-text("Disclaimer")',
  'button:has-text("Details & Disclaimer")',
  'a:has-text("Disclaimer")',
];

/** Opens offer disclaimer disclosures (AD-005: disclaimers are first-class
 *  evidence) and captures each as a disclaimer screenshot. */
export async function captureDisclaimers(page: Page): Promise<ExtraShot[]> {
  const shots: ExtraShot[] = [];
  for (const selector of DISCLAIMER_BUTTON_SELECTORS) {
    try {
      const buttons = page.locator(selector);
      const count = Math.min(await buttons.count(), MAX_DISCLAIMERS);
      for (let i = 0; i < count && shots.length < MAX_DISCLAIMERS; i++) {
        try {
          const button = buttons.nth(i);
          if (!(await button.isVisible({ timeout: 100 }))) continue;
          await button.scrollIntoViewIfNeeded({ timeout: 500 });
          await button.click({ timeout: 1_000 });
          await page.waitForTimeout(700);
          shots.push({
            label: `disclaimer-${shots.length + 1}`,
            image: await page.screenshot({ type: "png" }),
            kind: "disclaimer_screenshot",
          });
          // Close whatever opened (modal or expanded panel).
          await page.keyboard.press("Escape").catch(() => {});
          await page.waitForTimeout(300);
        } catch {
          // Button detached or covered — try the rest.
        }
      }
      if (shots.length > 0) break;
    } catch {
      // Selector failed — try the next pattern.
    }
  }
  return shots;
}

/** Advances the first visible carousel and captures each slide. */
export async function exploreCarousels(page: Page): Promise<ExtraShot[]> {
  const shots: ExtraShot[] = [];
  for (const selector of CAROUSEL_NEXT_SELECTORS) {
    try {
      const next = page.locator(selector).first();
      if (!(await next.isVisible({ timeout: 250 }))) continue;

      for (let slide = 2; slide <= MAX_CAROUSEL_SLIDES; slide++) {
        await next.click({ timeout: 1_000 });
        await page.waitForTimeout(900);
        shots.push({
          label: `carousel-slide-${slide}`,
          image: await page.screenshot({ type: "png" }),
          kind: "screenshot",
        });
      }
      break; // one carousel per page is the promotional hero case we care about
    } catch {
      // Carousel ended early or the control detached — keep what we captured.
      break;
    }
  }
  return shots;
}

/** Opens each tab in the first tab group and captures the panel. */
export async function exploreTabs(page: Page): Promise<ExtraShot[]> {
  const shots: ExtraShot[] = [];
  for (const selector of TAB_SELECTORS) {
    try {
      const tabs = page.locator(selector);
      const count = Math.min(await tabs.count(), MAX_TABS);
      if (count < 2) continue;

      for (let i = 1; i < count; i++) {
        try {
          await tabs.nth(i).click({ timeout: 1_000 });
          await page.waitForTimeout(600);
          shots.push({
            label: `tab-${i + 1}`,
            image: await page.screenshot({ type: "png" }),
            kind: "screenshot",
          });
        } catch {
          // Tab not clickable — try the rest.
        }
      }
      break;
    } catch {
      // Selector failed entirely — try the next pattern.
    }
  }
  return shots;
}

/** Expands collapsed accordions so the final full-page screenshot and HTML
 *  include their contents. No per-item capture. */
export async function expandAccordions(page: Page): Promise<number> {
  let expanded = 0;
  for (const selector of ACCORDION_SELECTORS) {
    try {
      const items = page.locator(selector);
      const count = Math.min(await items.count(), MAX_ACCORDIONS - expanded);
      for (let i = 0; i < count; i++) {
        try {
          const item = items.nth(i);
          if (await item.isVisible({ timeout: 100 })) {
            await item.click({ timeout: 500 });
            expanded++;
            await page.waitForTimeout(150);
          }
        } catch {
          // Item detached or covered — skip it.
        }
      }
    } catch {
      // Selector failed — try the next pattern.
    }
    if (expanded >= MAX_ACCORDIONS) break;
  }
  if (expanded > 0) await page.waitForTimeout(500);
  return expanded;
}
