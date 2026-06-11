import type { Page } from "playwright";

/**
 * Overlay suppression (roadmap: Cookie Handler, Modal Explorer, Chat
 * Suppression). Heuristic and best-effort: dealer sites use a long tail of
 * consent/chat vendors, so every step is wrapped in a catch and the page is
 * never considered failed because an overlay would not close.
 */

/** Consent-accept buttons tried by text, most specific vendors first. */
const COOKIE_ACCEPT_SELECTORS = [
  "#onetrust-accept-btn-handler",
  "button#truste-consent-button",
  ".cky-btn-accept",
  "#cookiescript_accept",
  'button:has-text("Accept All")',
  'button:has-text("Accept all")',
  'button:has-text("Allow All")',
  'button:has-text("I Accept")',
  'button:has-text("I Agree")',
  'button:has-text("Got It")',
  'button:has-text("Accept Cookies")',
  'button:has-text("Accept")',
  'a:has-text("Accept All")',
];

/** Common close affordances on promotional/interstitial modals. */
const MODAL_CLOSE_SELECTORS = [
  '[role="dialog"] button[aria-label="Close" i]',
  '[role="dialog"] [class*="close" i]',
  'div[class*="modal" i] button[aria-label="Close" i]',
  'div[class*="popup" i] button[aria-label="Close" i]',
  'button[aria-label="Close" i]',
  'button[title="Close" i]',
];

/** Chat widgets are usually iframes or fixed launchers; hide, don't click. */
const CHAT_HIDE_SELECTORS = [
  'iframe[id*="chat" i]',
  'iframe[src*="chat" i]',
  'iframe[title*="chat" i]',
  '[id*="livechat" i]',
  '[class*="chat-widget" i]',
  '[id*="drift-widget" i]',
  "#intercom-container",
  '[class*="intercom-launcher" i]',
  '[id*="podium" i]',
  '[id*="gubagoo" i]',
  '[id*="carnow" i]',
  '[id*="activengage" i]',
];

async function clickFirstVisible(
  page: Page,
  selectors: string[]
): Promise<boolean> {
  for (const selector of selectors) {
    try {
      const el = page.locator(selector).first();
      if (await el.isVisible({ timeout: 250 })) {
        await el.click({ timeout: 1_000 });
        return true;
      }
    } catch {
      // Selector missing, hidden, or detached mid-click — try the next one.
    }
  }
  return false;
}

export async function dismissCookieBanners(page: Page): Promise<boolean> {
  return clickFirstVisible(page, COOKIE_ACCEPT_SELECTORS);
}

export async function dismissModals(page: Page): Promise<boolean> {
  let dismissedAny = false;
  // Sites sometimes stack modals; two passes covers the common case.
  for (let i = 0; i < 2; i++) {
    const dismissed = await clickFirstVisible(page, MODAL_CLOSE_SELECTORS);
    if (!dismissed) break;
    dismissedAny = true;
    await page.waitForTimeout(300);
  }
  // Escape closes most remaining focus-trapped dialogs.
  await page.keyboard.press("Escape").catch(() => {});
  return dismissedAny;
}

export async function suppressChatWidgets(page: Page): Promise<void> {
  await page
    .evaluate((selectors: string[]) => {
      for (const selector of selectors) {
        document.querySelectorAll(selector).forEach((el) => {
          (el as HTMLElement).style.setProperty(
            "display",
            "none",
            "important"
          );
        });
      }
    }, CHAT_HIDE_SELECTORS)
    .catch(() => {});
}

export async function suppressOverlays(page: Page): Promise<void> {
  await dismissCookieBanners(page);
  await dismissModals(page);
  await suppressChatWidgets(page);
}
