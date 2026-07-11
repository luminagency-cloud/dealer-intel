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
  /** Full text scraped from the source at capture time. For disclaimer shots
   *  this is the modal's offer + disclaimer text — the real fine print, which
   *  the compliance pass needs and which the static HTML snapshot often misses
   *  (the modal is closed before the snapshot is taken). */
  text?: string;
}

const MAX_DISCLAIMERS = 8;

// Selectors for offer disclaimer triggers. Each entry is tried in order; the
// first that finds visible buttons wins. Footer/nav links are excluded via the
// :not() guard — those legal-disclaimer page links match class*="disclaimer"
// but are never offer modals.
// Never match anything inside a page footer or nav — those "Legal Disclaimer"
// links are site boilerplate, not offer modal triggers.
const NOT_IN_FOOTER =
  ':not(footer *, [class*="footer" i] *, [id*="footer" i] *, nav *, [role="navigation"] *)';

const DISCLAIMER_BUTTON_SELECTORS = [
  // DDC / Dealer.com offer cards: disclosure trigger inside the promo card.
  `.ddc-offer-disclosure${NOT_IN_FOOTER}, [class*="offer" i] button[class*="disclaimer" i]${NOT_IN_FOOTER}, [class*="offer" i] a[class*="disclaimer" i]${NOT_IN_FOOTER}`,
  // Generic class-based.
  `[class*="disclaimer" i]:is(button, a)${NOT_IN_FOOTER}`,
  `button:has-text("Disclaimer")${NOT_IN_FOOTER}`,
  `button:has-text("Details & Disclaimer")${NOT_IN_FOOTER}`,
  `a:has-text("Disclaimer")${NOT_IN_FOOTER}`,
];

/** Ad-anchor from the disclaimer's ancestor card — works when the offer is
 *  rendered as DOM text (vehicle/heading + price) near the trigger. Returns ""
 *  for image-based promos, where the text is baked into the image (common on
 *  dealer platforms); the modal reader below handles those. */
async function ancestorAdAnchor(
  page: Page,
  selector: string,
  index: number
): Promise<string> {
  try {
    return await page.locator(selector).nth(index).evaluate((el) => {
      const priceRe = /\$\s?[\d,]+(?:\.\d{2})?(?:\s?\/?\s?(?:mo|month|week|wk))?/i;
      let node: HTMLElement = el as HTMLElement;
      for (let depth = 0; depth < 8 && node.parentElement; depth++) {
        const parent: HTMLElement = node.parentElement;
        const text = parent.innerText || "";
        if (priceRe.test(text) || parent.querySelector("h1,h2,h3,h4")) {
          node = parent;
          break;
        }
        node = parent;
      }
      const heading = node.querySelector("h1,h2,h3,h4,[class*='title' i]");
      const headingText = (heading?.textContent || "").trim().replace(/\s+/g, " ");
      const price = (node.innerText || "").match(priceRe)?.[0]?.trim() ?? "";
      return [headingText, price].filter(Boolean).join(" — ").slice(0, 120);
    });
  } catch {
    return "";
  }
}

/** Raw (whitespace-normalized) text of the disclaimer trigger's ancestor offer
 *  card — same climb as `ancestorAdAnchor`, but returns the whole card so
 *  callers can decide what kind of offer it is. "" when nothing is readable. */
async function adCardText(
  page: Page,
  selector: string,
  index: number
): Promise<string> {
  try {
    return await page.locator(selector).nth(index).evaluate((el) => {
      const priceRe = /\$\s?[\d,]+(?:\.\d{2})?/i;
      let node: HTMLElement = el as HTMLElement;
      for (let depth = 0; depth < 8 && node.parentElement; depth++) {
        const parent: HTMLElement = node.parentElement;
        if (priceRe.test(parent.innerText || "") || parent.querySelector("h1,h2,h3,h4")) {
          node = parent;
          break;
        }
        node = parent;
      }
      return (node.innerText || "").replace(/\s+/g, " ").trim();
    });
  } catch {
    return "";
  }
}

// A hero/promo card whose only offer content is the bare word "Rebate" is a
// generic manufacturer program (College Grad, Military, etc.) — the real value,
// if any, lives behind the modal and applies to "any new Toyota", not an
// advertised price. Nothing to grade and nothing worth storing. We drop it only
// when the card advertises NO value: an explicit "$2,000 rebate" cash offer
// carries a price on the card and is kept. Bare vehicle-name digits (years,
// "View 6 Qualifying Vehicles") are not values, so they don't rescue the card.
const REBATE_WORD = /\brebates?\b/i;
const CARD_HAS_VALUE = /\$|\d+\s*%|\d+\s*(?:\/\s*)?(?:mo|month|apr)\b|\bapr\b/i;
function isValuelessRebate(cardText: string): boolean {
  return REBATE_WORD.test(cardText) && !CARD_HAS_VALUE.test(cardText);
}

/** Reads the disclaimer modal that opened on click. Dealer promo widgets
 *  render the offer (vehicle + price) and the disclaimer fine print together in
 *  a dialog — e.g. "Lease a 2026 Jeep Grand Cherokee … $299/mo … DISCLAIMER
 *  Disclaimer: Stk# … MSRP $48,035 …". Returns both:
 *   - `anchor`: the offer portion (before the DISCLAIMER marker), the human
 *      name + join key back to the offer for the compliance pass; and
 *   - `text`: the full modal text (offer + disclaimer), the real fine print
 *      compliance needs without OCR.
 *  Best-effort: returns empty strings if no readable modal opened. */
async function readDisclaimerModal(
  page: Page
): Promise<{ anchor: string; text: string }> {
  try {
    return await page.evaluate(() => {
      const sel =
        '[class*="modal" i],[role="dialog"],[class*="dialog" i],[class*="popup" i]';
      const visible = [...document.querySelectorAll(sel)].filter(
        (n) =>
          (n as HTMLElement).offsetParent !== null &&
          ((n as HTMLElement).innerText || "").trim().length > 20
      ) as HTMLElement[];
      if (visible.length === 0) return { anchor: "", text: "" };
      visible.sort((a, b) => b.innerText.length - a.innerText.length);
      const full = visible[0].innerText.replace(/\s+/g, " ").trim();
      // Anchor = the offer portion: before the DISCLAIMER marker, CTA stripped.
      let anchor = full;
      const cut = anchor.search(/disclaimer/i);
      if (cut > 0) anchor = anchor.slice(0, cut).trim();
      // Strip trailing CTA/nav/expiry noise that precedes or follows the offer name.
      anchor = anchor
        .replace(/\b(never\s+expires?|expires?\s+\d[\d/\-\.]*|exp\.?\s+\d[\d/\-\.]*)\b.*/i, "")
        .replace(/\b(request\s+more\s+info|more\s+info|learn\s+more|get\s+coupon|print\s+coupon|schedule\s+service|book\s+now|shop\s+now|view\s+\d+\s+qualifying\s+vehicle|view\s+vehicle\s+details|view\s+details|open\s+in\s+same\s+tab)\b.*/i, "")
        .trim();
      return { anchor: anchor.slice(0, 110), text: full.slice(0, 8000) };
    });
  } catch {
    return { anchor: "", text: "" };
  }
}

/** Opens offer disclaimer disclosures (AD-005: disclaimers are first-class
 *  evidence) and captures each as a disclaimer screenshot, labeled with the
 *  ad it belongs to. */
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
          // Skip generic "Rebate" programs (College Grad / Military) before we
          // spend a click + screenshot on them — they clutter evidence and carry
          // no advertised value. See isValuelessRebate.
          if (isValuelessRebate(await adCardText(page, selector, i))) continue;
          // Inline offers carry text in the ancestor card; image promos don't —
          // for those the offer text appears in the modal after the click.
          const preAnchor = await ancestorAdAnchor(page, selector, i);
          const urlBefore = page.url();
          const pathBefore = new URL(urlBefore).pathname;
          await button.click({ timeout: 1_000 });
          await page.waitForTimeout(1_000);
          // If clicking navigated to a different page (path changed), go back
          // and abort this selector. Ignore query-string / hash changes — DDC
          // pushes ?promotionId=... onto the URL when opening a modal without
          // leaving the page, which would otherwise trigger a false positive.
          const pathAfter = new URL(page.url()).pathname;
          if (pathAfter !== pathBefore) {
            await page.goBack({ timeout: 10_000 }).catch(() => {});
            break;
          }
          const modal = await readDisclaimerModal(page);
          const anchor = modal.anchor || preAnchor;
          shots.push({
            label: anchor || `Disclaimer ${shots.length + 1}`,
            image: await page.screenshot({ type: "png" }),
            kind: "disclaimer_screenshot",
            text: modal.text || undefined,
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
          label: `Carousel slide ${slide}`,
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
            label: `Tab ${i + 1}`,
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
