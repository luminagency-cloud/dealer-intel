// Order matters: shared lifecycle, then navigation and tallying, then every
// platform adapter (each self-registers into `inventoryPlatformAdapters`),
// then the dispatcher that reads that registry.
importScripts(
  "inventory/shared.js",
  "inventory/navigate.js",
  "inventory/tally.js",
  "inventory/adapters/dealer-com.js",
  "inventory/adapters/dealer-inspire.js",
  "inventory/adapters/dealer-on.js",
  "inventory/adapters/apollo.js",
  "inventory/adapters/dealer-alchemist.js",
  "inventory/adapters/dealer-masters.js",
  "inventory/adapters/sokal.js",
  "inventory.js"
);

const PROTOCOL_VERSION = 5;
const NAVIGATION_TIMEOUT_MS = 45_000;
const CAPTURE_ACK_TIMEOUT_MS = 120_000;
const CAROUSEL_SAFETY_LIMIT = 30;
const CAROUSEL_DETECTION_TIMEOUT_MS = 8_000;
const MAX_TABS = 8;
const DISCLAIMER_SAFETY_LIMIT = 30;
const ACTIVE_INVENTORY_SESSION_KEY = "dealerIntelActiveInventorySession";
let activeSession = null;
let activeSessionTimeout = null;
let activeInventoryController = null;
const pendingCaptureAcks = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTabComplete(tabId) {
  const deadline = Date.now() + NAVIGATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (/^https?:/i.test(tab.url || "")) {
        const [{ result: readyState }] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => document.readyState,
        });
        if (readyState === "interactive" || readyState === "complete") return;
      }
    } catch {
      // A redirect can temporarily replace the top frame; retry its visible page.
    }
    await sleep(250);
  }
  throw new Error("Timed out waiting for the dealer page to become interactive");
}

async function waitAfterInteraction(tabId, delayMs) {
  await sleep(100);
  const tab = await chrome.tabs.get(tabId);
  if (tab.status !== "complete") await waitForTabComplete(tabId);
  await sleep(delayMs);
}

async function closeActiveSession() {
  if (activeSessionTimeout !== null) {
    clearTimeout(activeSessionTimeout);
    activeSessionTimeout = null;
  }
  const stored = await chrome.storage.local.get(ACTIVE_INVENTORY_SESSION_KEY);
  const session = activeSession || stored[ACTIVE_INVENTORY_SESSION_KEY] || null;
  activeSession = null;
  if (session?.windowId !== undefined) {
    try {
      await chrome.windows.remove(session.windowId);
    } catch (error) {
      if (!/no window with id/i.test(error instanceof Error ? error.message : String(error))) {
        activeSession = session;
        throw error;
      }
    }
  }
  await chrome.storage.local.remove(ACTIVE_INVENTORY_SESSION_KEY);
}

const activeInventorySessionRecovery = closeActiveSession();

/**
 * Open (or reuse) the single collection window for a dealer.
 *
 * `landingUrl` is the page to open at. Inventory collection passes the SRP it
 * already knows, so it does not have to load the homepage and then immediately
 * navigate away from it. Callers that genuinely want the homepage (evidence
 * capture) omit it and get `item.url`.
 *
 * `lifetimeMs` arms the reclaim watchdog and belongs to callers that run under
 * a wall-clock budget — i.e. inventory. Evidence collection must NOT pass one:
 * its budget is however long the page's carousels and disclaimers take, and
 * arming the inventory watchdog there closed the window out from under a
 * running mission ("No tab with id …" on Mastria's homepage, which walks 30
 * disclaimer candidates well past two minutes). Evidence windows are closed by
 * the next dealer's session, the page's CLOSE_SESSION on run end, or
 * `activeInventorySessionRecovery` on the next worker start.
 */
/**
 * Are these two URLs the same dealer's site?
 *
 * `www.` is ignored. Dealers are stored both ways — an operator's saved
 * inventory path routinely carries the `www.` host the browser redirected them
 * to while `item.url` does not — and a strict origin comparison read that as
 * "another site". The stored SRP was then silently discarded in favour of the
 * homepage, and the collection ran against a page with no inventory on it.
 *
 * Scheme and port still have to match: this is a guard against navigating to
 * somebody else's site, not a guess at what the operator meant.
 */
function sameDealerOrigin(left, right) {
  const key = (value) => {
    try {
      const url = new URL(value);
      return `${url.protocol}//${url.hostname.replace(/^www\./i, "")}:${url.port}`;
    } catch {
      return null;
    }
  };
  const a = key(left);
  return Boolean(a) && a === key(right);
}

async function ensureSiteSession(item, landingUrl, lifetimeMs) {
  await activeInventorySessionRecovery;
  if (!item?.url || !item?.siteId) {
    throw new Error("Collection job did not include a dealer and URL");
  }

  // Same-origin guard: a bad stored path must not send the collection window
  // to another site, so anything off-origin falls back to the dealer homepage.
  const opensAt = (() => {
    if (!landingUrl) return item.url;
    return sameDealerOrigin(landingUrl, item.url) ? landingUrl : item.url;
  })();

  if (activeSession?.siteId === item.siteId) {
    try {
      const tab = await chrome.tabs.get(activeSession.tabId);
      // The reused window belongs to THIS caller now, so it gets this caller's
      // budget. Returning without re-arming left an inventory batch running
      // under whatever the previous caller set — usually nothing at all, since
      // evidence collection passes no lifetime — so the reclaim watchdog the
      // argument exists to arm was silently never set.
      armSessionWatchdog(lifetimeMs);
      // Deliberately does NOT re-focus the collection window. A dealer batch
      // calls this once per dealer, and grabbing focus each time made the
      // browser unusable — the operator could not stay in another tab or
      // window while a run was going.
      // Compare origins, not full URLs. Inventory collection deliberately
      // navigates this tab around the dealer's own site (SRP, per-make filter
      // URLs), and a site that redirects http->https or adds a trailing slash
      // would otherwise be yanked back to the homepage on every call.
      const sameSite = sameDealerOrigin(tab.url, item.url);
      if (!sameSite) {
        // No `active: true`: this tab is the only tab in its own collection
        // window, so activating it only serves to steal the operator's focus.
        await chrome.tabs.update(activeSession.tabId, { url: opensAt });
        await waitForTabComplete(activeSession.tabId);
      }
      return activeSession;
    } catch {
      await closeActiveSession();
    }
  } else if (activeSession) {
    await closeActiveSession();
  }

  // Focused once, at creation, so the page renders and is not occluded from
  // the start. Never re-focused afterwards.
  //
  // Explicit desktop dimensions rather than "maximized": viewport width picks
  // which facet layout a dealer platform renders. Dealer Inspire in
  // particular swaps its desktop `#lvrp-filters-column` for a mobile filter
  // dialog at narrow widths, and the readers target the desktop layout. A
  // fixed size keeps that deterministic across machines and screen sizes.
  const created = await chrome.windows.create({
    url: opensAt,
    focused: true,
    type: "normal",
    width: 1440,
    height: 960,
  });
  const windowId = created.id;
  const tabId = created.tabs?.[0]?.id;
  if (windowId === undefined || tabId === undefined) {
    throw new Error("Chrome did not create the collection window");
  }

  activeSession = { siteId: item.siteId, windowId, tabId };
  await chrome.storage.local.set({
    [ACTIVE_INVENTORY_SESSION_KEY]: activeSession,
  });
  armSessionWatchdog(lifetimeMs);
  await waitForTabComplete(tabId);
  return activeSession;
}

/** Replaces any pending reclaim timer with one derived from the current
 *  caller's collection budget, so the window can never be reclaimed out from
 *  under a collection that is still legitimately running. A falsy `lifetimeMs`
 *  means "no watchdog" (evidence capture) and clears whatever was armed. */
function armSessionWatchdog(lifetimeMs) {
  if (activeSessionTimeout !== null) {
    clearTimeout(activeSessionTimeout);
    activeSessionTimeout = null;
  }
  if (!lifetimeMs) return;
  activeSessionTimeout = setTimeout(() => {
    closeActiveSession().catch(() => {});
  }, lifetimeMs);
}

/** Best-effort consent suppression inside every accessible frame. */
async function suppressConsentObstructions(tabId) {
  await chrome.scripting
    .executeScript({
      target: { tabId, allFrames: true },
      func: async () => {
        const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        // Offer widgets are frequently classified as third-party content. A
        // collector must render it before falling back to a rejection action.
        const actionPatterns = [
          /^allow all cookies$/i,
          /^allow targeting cookies$/i,
          /^accept all(?: cookies)?$/i,
          /^accept cookies$/i,
          /^i (?:agree|accept)$/i,
          /^got it$/i,
          /^deny (?:optional |targeting )?cookies?$/i,
          /^reject(?: all| optional| targeting)?(?: cookies?)?$/i,
          /^decline(?: all)?(?: cookies?)?$/i,
          /^(?:use )?necessary cookies only$/i,
        ];
        const consentWords = /cookie|privacy|consent|targeting|tracking/i;
        const roots = [document];
        for (let index = 0; index < roots.length; index += 1) {
          for (const element of roots[index].querySelectorAll("*")) {
            if (element.shadowRoot) roots.push(element.shadowRoot);
          }
        }
        const candidates = roots.flatMap((root) =>
          Array.from(
            root.querySelectorAll(
              'button, a, [role="button"], input[type="button"], input[type="submit"]'
            )
          )
        );
        const labelFor = (element) =>
          (
            element.innerText ||
            element.value ||
            element.getAttribute("aria-label") ||
            element.getAttribute("title") ||
            ""
          )
            .replace(/\s+/g, " ")
            .trim();
        const isVisible = (element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden"
          );
        };
        const hasConsentContext = (element, label) => {
          if (consentWords.test(label)) return true;
          let ancestor = element.parentElement;
          for (let depth = 0; ancestor && depth < 5; depth += 1) {
            if (consentWords.test(ancestor.innerText || "")) return true;
            ancestor = ancestor.parentElement;
          }
          return false;
        };

        for (const pattern of actionPatterns) {
          const action = candidates.find((element) => {
            const label = labelFor(element);
            return (
              pattern.test(label) &&
              isVisible(element) &&
              hasConsentContext(element, label)
            );
          });
          if (!action) continue;
          action.click();
          await pause(500);
          return true;
        }
        return false;
      },
    })
    .catch(() => []);
}

/** Closes generic promotional overlays and hides common chat widgets. Offer
 * disclaimer dialogs are opened only later, after this preparation pass. */
async function suppressPageObstructions(tabId) {
  await suppressConsentObstructions(tabId);
  await chrome.scripting
    .executeScript({
      target: { tabId, allFrames: true },
      func: async () => {
        const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const isVisible = (element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden"
          );
        };
        const closeSelectors = [
          '[role="dialog"] button[aria-label*="close" i]',
          '[role="dialog"] button[title*="close" i]',
          '[role="dialog"] button[class*="close" i]',
          'div[class*="modal" i] button[aria-label*="close" i]',
          'div[class*="popup" i] button[aria-label*="close" i]',
        ];
        const popupSelectors = [
          '[role="dialog"]',
          'dialog[open]',
          '[aria-modal="true"]',
          '[class*="modal" i]',
          '[id*="modal" i]',
          '[class*="popup" i]',
          '[id*="popup" i]',
          '[class*="lightbox" i]',
          '[class*="interstitial" i]',
        ];
        const inventoryControlLayer = (element) => {
          const text = (element.innerText || "").replace(/\s+/g, " ").trim();
          const hasChoices = Boolean(
            element.querySelector(
              'input[type="checkbox"], [role="checkbox"], select'
            )
          );
          return (
            hasChoices &&
            /\b(?:more filters|select (?:make|models?)|vehicle status|inventory status|in[- ]transit|in[- ]stock|on (?:the )?lot)\b/i.test(
              text
            )
          );
        };
        const blockingPopup = (element) => {
          if (
            !isVisible(element) ||
            element.closest("header, nav") ||
            inventoryControlLayer(element)
          ) {
            return false;
          }
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
          const coversEnough = (rect.width * rect.height) / viewportArea > 0.08;
          const elevated =
            style.position === "fixed" ||
            style.position === "sticky" ||
            Number.parseInt(style.zIndex || "0", 10) >= 100;
          return (
            element.matches('[role="dialog"], dialog[open], [aria-modal="true"]') ||
            (coversEnough && elevated)
          );
        };
        const hideBlockingLayer = (element) => {
          element.style.setProperty("display", "none", "important");
          element.setAttribute("aria-hidden", "true");
          document.documentElement.style.removeProperty("overflow");
          document.body?.style.removeProperty("overflow");
          document.body?.style.removeProperty("position");
        };
        const dismissBlockingPopups = () => {
          const popups = Array.from(
            document.querySelectorAll(popupSelectors.join(","))
          ).filter(blockingPopup);
          for (const popup of popups) {
            const closeButton = closeSelectors
              .flatMap((selector) =>
                Array.from(popup.querySelectorAll(selector))
              )
              .find(isVisible);
            if (closeButton instanceof HTMLElement) {
              closeButton.click();
            } else {
              hideBlockingLayer(popup);
            }
          }

          for (const frame of document.querySelectorAll("iframe")) {
            if (!isVisible(frame)) continue;
            const rect = frame.getBoundingClientRect();
            const style = getComputedStyle(frame);
            const areaRatio =
              (rect.width * rect.height) /
              Math.max(1, window.innerWidth * window.innerHeight);
            const elevated =
              style.position === "fixed" ||
              Number.parseInt(style.zIndex || "0", 10) >= 100;
            if (areaRatio > 0.08 && elevated) hideBlockingLayer(frame);
          }
          return popups.length > 0;
        };

        dismissBlockingPopups();
        if (!globalThis.__dealerIntelPopupObserver) {
          let scheduled = false;
          globalThis.__dealerIntelPopupObserver = new MutationObserver(() => {
            if (scheduled) return;
            scheduled = true;
            setTimeout(() => {
              scheduled = false;
              dismissBlockingPopups();
            }, 100);
          });
          globalThis.__dealerIntelPopupObserver.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["class", "style", "open", "aria-hidden"],
          });
        }
        await pause(250);
        const chatSelectors = [
          'iframe[id*="chat" i]',
          'iframe[src*="chat" i]',
          'iframe[title*="chat" i]',
          '[id*="livechat" i]',
          '[class*="chat-widget" i]',
          '[id*="drift-widget" i]',
          '#intercom-container',
          '[class*="intercom-launcher" i]',
          '[id*="podium" i]',
          '[id*="gubagoo" i]',
          '[id*="carnow" i]',
          '[id*="activengage" i]',
        ];
        for (const selector of chatSelectors) {
          for (const element of document.querySelectorAll(selector)) {
            element.style.setProperty("display", "none", "important");
          }
        }
      },
    })
    .catch(() => []);
}

async function preparePage(tabId, expandAccordions) {
  await sleep(1_500);
  await suppressPageObstructions(tabId);
  await chrome.scripting.executeScript({
    target: { tabId },
    args: [Boolean(expandAccordions)],
    func: async (shouldExpandAccordions) => {
      const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        const loading = Array.from(document.querySelectorAll("body *")).some(
          (element) => {
            if (!(element instanceof HTMLElement) || element.offsetParent === null) {
              return false;
            }
            const ownText = Array.from(element.childNodes)
              .filter((node) => node.nodeType === Node.TEXT_NODE)
              .map((node) => node.textContent || "")
              .join("")
              .trim();
            return /^loading(?:\.{3}|…)?(?:\s+[\w -]{0,40})?$/i.test(ownText);
          }
        );
        if (!loading) break;
        await pause(250);
      }

      for (let step = 0; step < 25; step += 1) {
        if (window.innerHeight + window.scrollY >= document.body.scrollHeight) break;
        window.scrollBy(0, 700);
        await pause(150);
      }
      window.scrollTo(0, 0);
      await pause(300);

      if (shouldExpandAccordions) {
        const selectors = [
          'button[aria-expanded="false"]',
          '[class*="accordion" i] [aria-expanded="false"]',
          'details:not([open]) summary',
        ];
        let expanded = 0;
        for (const selector of selectors) {
          for (const element of document.querySelectorAll(selector)) {
            if (expanded >= 15) break;
            if (!(element instanceof HTMLElement) || element.offsetParent === null) {
              continue;
            }
            element.click();
            expanded += 1;
            await pause(150);
          }
          if (expanded >= 15) break;
        }
        if (expanded > 0) await pause(500);
      }
    },
  });
  await suppressPageObstructions(tabId);
}

async function pageMetadata(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      finalUrl: window.location.href,
      pageTitle: document.title,
      html: document.documentElement.outerHTML,
    }),
  });
  if (!result?.finalUrl || !result?.html) {
    throw new Error("Chrome could not read the rendered dealer page");
  }
  return result;
}

// Skia caps a single texture at 16384px; asking for a taller shot returns a
// blank or truncated image rather than an error.
const MAX_CAPTURE_HEIGHT_PX = 16_384;

async function pageContentSize(target) {
  const metrics = await chrome.debugger.sendCommand(
    target,
    "Page.getLayoutMetrics"
  );
  const content = metrics?.cssContentSize || metrics?.contentSize;
  if (!content?.width || !content?.height) {
    throw new Error("Chrome could not measure the full dealer page");
  }
  return {
    width: Math.ceil(content.width),
    height: Math.min(Math.ceil(content.height), MAX_CAPTURE_HEIGHT_PX),
  };
}

/** Full-page screenshot by resizing the layout viewport to the whole document
 *  and capturing it in one pass.
 *
 *  Deliberately NOT `captureBeyondViewport: true`. On any page carrying a
 *  position:fixed or sticky element — which is every dealer site, they all
 *  have a sticky header — Chromium repaints the same viewport-sized tile down
 *  the length of the image instead of scrolling the content. That turned an
 *  Anchor Nissan homepage capture into the identical hero ad seven times over
 *  a 5486px canvas, with the rest of the page never captured at all.
 *
 *  Overriding device metrics forces a real relayout at full height, so fixed
 *  elements are painted once, where they belong. */
async function captureFullPage(tabId) {
  const target = { tabId };
  await chrome.debugger.attach(target, "1.3");
  let overridden = false;
  try {
    await chrome.debugger.sendCommand(target, "Page.enable");
    let size = await pageContentSize(target);
    // Resizing reflows `100vh` sections and pulls lazy images into view, which
    // can grow the document — so measure again and, if it did grow, resize once
    // more. The capture clip must match the viewport exactly: with
    // captureBeyondViewport off, anything past it comes back blank.
    for (let pass = 0; pass < 2; pass += 1) {
      await chrome.debugger.sendCommand(
        target,
        "Emulation.setDeviceMetricsOverride",
        {
          mobile: false,
          width: size.width,
          height: size.height,
          deviceScaleFactor: 1,
          screenOrientation: { angle: 0, type: "portraitPrimary" },
        }
      );
      overridden = true;
      await sleep(400);
      const settled = await pageContentSize(target);
      if (settled.height <= size.height && settled.width <= size.width) break;
      size = {
        width: Math.max(size.width, settled.width),
        height: Math.max(size.height, settled.height),
      };
    }
    const result = await chrome.debugger.sendCommand(
      target,
      "Page.captureScreenshot",
      {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
        clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 },
      }
    );
    if (!result?.data) throw new Error("Chrome returned an empty full-page image");
    return `data:image/png;base64,${result.data}`;
  } finally {
    if (overridden) {
      await chrome.debugger
        .sendCommand(target, "Emulation.clearDeviceMetricsOverride")
        .catch(() => {});
    }
    await chrome.debugger.detach(target).catch(() => {});
  }
}

/** Offer-card graphics, downloaded inside the dealer's own page.
 *
 *  The app never requests a dealer-controlled URL — that is what anti-bot
 *  protection blocks, and it is why collection lives in this browser. Doing it
 *  here also means the real rendered pixel size decides what counts as ad
 *  creative, instead of guessing from the filename, and the bytes usually come
 *  straight from the browser cache with the page's own cookies and referer.
 *
 *  `alreadyStored` is the set of image URLs this run has already sent up. The
 *  same hero graphic appears on the homepage, the specials page, and every
 *  carousel state of both; the server dedupes on capture key anyway, so
 *  re-uploading it is pure payload. */
async function collectAdImages(tabId, rules, alreadyStored) {
  if (!rules) return [];
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [rules, [...alreadyStored]],
    func: async (adRules, seen) => {
      const skipPath = new RegExp(adRules.skipPathPattern, "i");
      const tileHost = new RegExp(adRules.tileHostPattern, "i");
      const done = new Set(seen);
      const picked = [];
      for (const img of document.querySelectorAll("img")) {
        if (picked.length >= adRules.max) break;
        // Structural chrome carries the dealer's logos and social icons, never
        // the offer of the day.
        if (img.closest("header, footer, nav")) continue;
        const src = img.currentSrc || img.src;
        if (!src || src.startsWith("data:")) continue;
        if (!/^https?:/i.test(src)) continue;
        if (/\.(svg|ico|gif)(\?|#|$)/i.test(src)) continue;
        if (skipPath.test(src)) continue;
        try {
          if (tileHost.test(new URL(src).hostname)) continue;
        } catch {
          continue;
        }
        // Real decoded pixels, which is the whole advantage of running in the
        // page: no filename or query-param guessing about how big this is.
        if (
          img.naturalWidth < adRules.minWidth ||
          img.naturalHeight < adRules.minHeight
        ) {
          continue;
        }
        if (done.has(src)) continue;
        done.add(src);
        picked.push(src);
      }
      const read = async (url) => {
        try {
          const response = await fetch(url, { credentials: "include" });
          if (!response.ok) return null;
          const blob = await response.blob();
          const dataUrl = await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(blob);
          });
          return dataUrl ? { url, dataUrl } : null;
        } catch {
          return null;
        }
      };
      const results = await Promise.all(picked.map(read));
      return results.filter(Boolean);
    },
  });
  const images = result || [];
  for (const image of images) alreadyStored.add(image.url);
  return images;
}

/** Ad-image rules and the per-run set of URLs already uploaded. Module state
 *  rather than a `captureState` argument because collection is strictly
 *  sequential — one COLLECT_ITEM at a time — and the dedupe has to span every
 *  mission of the run, not just one page. */
let adImageContext = { collectionRequestId: null, rules: null, stored: new Set() };

function beginAdImageContext(collectionRequestId, rules) {
  if (adImageContext.collectionRequestId !== collectionRequestId) {
    adImageContext = { collectionRequestId, rules, stored: new Set() };
  } else {
    adImageContext.rules = rules;
  }
}

async function captureState(tabId, windowId, options) {
  const metadata = await pageMetadata(tabId);
  const screenshotDataUrl = options.fullPage
    ? await captureFullPage(tabId)
    : await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  const adImages = await collectAdImages(
    tabId,
    adImageContext.rules,
    adImageContext.stored
  );
  return {
    stateId: options.stateId,
    stateKind: options.stateKind,
    stateOrder: options.stateOrder,
    finalUrl: metadata.finalUrl,
    pageTitle: metadata.pageTitle,
    label: options.label,
    html: metadata.html,
    screenshotDataUrl,
    adImages,
    ...(options.textContent ? { textContent: options.textContent } : {}),
  };
}

function captureAckKey(collectionRequestId, stateId) {
  return `${collectionRequestId}:${stateId}`;
}

async function emitCaptureState(dealerIntelTabId, collectionRequestId, state) {
  const key = captureAckKey(collectionRequestId, state.stateId);
  if (pendingCaptureAcks.has(key)) {
    throw new Error(`Capture state ${state.stateId} is already awaiting upload`);
  }
  const acknowledged = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingCaptureAcks.delete(key);
      reject(new Error(`Timed out uploading ${state.label}`));
    }, CAPTURE_ACK_TIMEOUT_MS);
    pendingCaptureAcks.set(key, {
      resolve: () => {
        clearTimeout(timeout);
        pendingCaptureAcks.delete(key);
        resolve();
      },
      reject: (error) => {
        clearTimeout(timeout);
        pendingCaptureAcks.delete(key);
        reject(error);
      },
    });
  });

  try {
    await chrome.tabs.sendMessage(dealerIntelTabId, {
      type: "DEALER_INTEL_CAPTURE_STATE",
      collectionRequestId,
      state,
    });
  } catch (error) {
    const pending = pendingCaptureAcks.get(key);
    pending?.reject(error instanceof Error ? error : new Error(String(error)));
  }
  await acknowledged;
}

async function clickNextTab(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const selectors = [
        '[role="tablist"] [role="tab"]',
        ".nav-tabs a",
        ".nav-tabs button",
      ];
      const root = document.documentElement;
      let selectorIndex = Number(root.dataset.dealerIntelTabSelector || "-1");
      if (selectorIndex < 0) {
        selectorIndex = selectors.findIndex(
          (selector) => document.querySelectorAll(selector).length >= 2
        );
        if (selectorIndex < 0) return null;
        root.dataset.dealerIntelTabSelector = String(selectorIndex);
        root.dataset.dealerIntelTabIndex = "1";
      }
      const tabs = Array.from(document.querySelectorAll(selectors[selectorIndex]));
      const index = Number(root.dataset.dealerIntelTabIndex || "1");
      if (index >= tabs.length || index >= 8) return null;
      root.dataset.dealerIntelTabIndex = String(index + 1);
      const tab = tabs[index];
      if (!(tab instanceof HTMLElement) || tab.offsetParent === null) {
        return { skipped: true };
      }
      const text = (tab.innerText || tab.textContent || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80);
      tab.click();
      return {
        index: index + 1,
        label: text ? `Tab ${index + 1}: ${text}` : `Tab ${index + 1}`,
      };
    },
  });
  return result || null;
}

/** Reads the first promotional carousel through its own active-state markers.
 * The fixed safety cap is only a runaway guard; normal completion is detected
 * when the active slide identity repeats or the next control stops.
 *
 * The carousel is identified by its SLIDES, not by a visible arrow. Dealer.com
 * ships its specials carousel with `hide-buttons` — the Next control is
 * `display: none` yet still advances the widget on a DOM click — so requiring a
 * visible arrow skipped the real hero (13 ads on a live CDJR store) and latched
 * onto the vehicle slider's visible "Next Vehicle" button instead. That button's
 * own class contains `btn-carousel`, so `closest('[class*="carousel"]')` matched
 * the BUTTON, which holds no slides: every DDC homepage captured its base state
 * and nothing else. Judge the control by whether it drives a real slide
 * container, and the container by whether IT is on screen.
 *
 * PROMOTIONAL is a real condition, not a description: the container has to hold
 * an ad-sized image. Without that test this took the first slider on the page,
 * and on Tasca Nissan East Providence (Aug 9 2026) that was the customer-reviews
 * swiper — 15 slides, zero images — so the run walked fifteen states of review
 * quotes and every one of them re-ran ad capture over the page, which is how a
 * "Shop by Model" stock photo ended up stored as ad creative. Testimonial,
 * staff, and brand-tile sliders all fail the same test. A text-only promotional
 * carousel is skipped too, and that is the accepted cost: its slides are already
 * in the base state's HTML, so walking it buys screenshots of text we captured
 * anyway. */
async function readPrimaryCarouselState(tabId, pauseRotation = false) {
  const rules = adImageContext.rules;
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [pauseRotation, rules?.minWidth ?? 500, rules?.minHeight ?? 300],
    func: (shouldPause, minAdWidth, minAdHeight) => {
      const nextSelectors = [
        'button[aria-label*="next picture" i]',
        'button[data-slide="next"]',
        ".carousel-control-next",
        ".slick-next",
        ".swiper-button-next",
        '[class*="carousel" i] button[aria-label*="next" i]',
        '[class*="slider" i] button[aria-label*="next" i]',
        'button[aria-label="Next slide" i]',
      ];
      const isVisible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden"
        );
      };
      const slideSelectors = [
        '[aria-label*="carousel slide number" i]',
        ".carousel-item",
        ".item",
        ".slick-slide",
        ".swiper-slide",
      ];
      const holdsSlides = (element) =>
        slideSelectors.some((selector) => element.querySelector(selector));
      // Ad creative is the point of walking a carousel, so a container that
      // holds no image big enough to carry an offer is not the one we want.
      // Rendered size counts as well as decoded size: a hero occupies its box
      // before it finishes decoding, and the caller polls for 8s, so a slow
      // image resolves on a later pass rather than being judged too small.
      const holdsAdImage = (element) =>
        Array.from(element.querySelectorAll("img")).some((image) => {
          const rect = image.getBoundingClientRect();
          return (
            (image.naturalWidth >= minAdWidth &&
              image.naturalHeight >= minAdHeight) ||
            (rect.width >= minAdWidth && rect.height >= minAdHeight)
          );
        });
      const qualifies = (element) =>
        holdsSlides(element) && isVisible(element) && holdsAdImage(element);
      // A slide container qualifies only if it is a carousel root that actually
      // holds slides, is on screen, and carries ad creative. Ancestors are
      // walked from the control's PARENT, never `closest` from the control
      // itself, whose own class may contain "carousel"/"slider" (Dealer.com's
      // `btn-carousel`).
      const resolveContainer = (next) => {
        for (const attribute of ["aria-controls", "data-target"]) {
          const raw = next.getAttribute(attribute);
          if (!raw) continue;
          const controlled = document.getElementById(raw.replace(/^#/, ""));
          if (controlled && qualifies(controlled)) return controlled;
        }
        let node = next.parentElement;
        for (let depth = 0; depth < 8 && node; depth += 1) {
          if (
            node.matches(
              '[role="region"], .carousel, .slick-slider, .swiper, [class*="carousel" i], [class*="slider" i]'
            ) &&
            qualifies(node)
          ) {
            return node;
          }
          node = node.parentElement;
        }
        return null;
      };
      let next = null;
      let container = null;
      for (const selector of nextSelectors) {
        for (const candidate of document.querySelectorAll(selector)) {
          const resolved = resolveContainer(candidate);
          if (resolved) {
            next = candidate;
            container = resolved;
            break;
          }
        }
        if (container) break;
      }
      if (!(next instanceof HTMLElement) || !(container instanceof HTMLElement)) {
        return null;
      }
      container.dataset.dealerIntelPrimaryCarousel = "true";

      if (shouldPause) {
        const pause = Array.from(
          container.querySelectorAll(
            'button[aria-label*="pause" i], button[title*="pause" i]'
          )
        ).find(isVisible);
        if (pause instanceof HTMLElement) pause.click();
      }

      const slides = [];
      for (const selector of slideSelectors) {
        for (const slide of container.querySelectorAll(selector)) {
          if (!slides.includes(slide)) slides.push(slide);
        }
      }
      const active = slides.find(
        (slide) =>
          slide.matches(
            ".active, .slick-active, .swiper-slide-active, [aria-current='true']"
          ) && isVisible(slide)
      ) || slides.find(isVisible);
      if (!(active instanceof HTMLElement)) return null;

      const aria = active.getAttribute("aria-label") || "";
      const numbered = aria.match(/slide\s+number\s+(\d+)\s+of\s+(\d+)/i);
      const slickIndex = active.getAttribute("data-slick-index");
      const image = active.querySelector("img");
      const imageAlt = (image?.getAttribute("alt") || "")
        .replace(/\s+/g, " ")
        .trim();
      const imageSrc = image?.currentSrc || image?.getAttribute("src") || "";
      const text = (active.innerText || "").replace(/\s+/g, " ").trim();
      const ordinal = numbered
        ? Number(numbered[1])
        : slickIndex !== null && Number.isFinite(Number(slickIndex))
          ? Number(slickIndex) + 1
          : null;
      const total = numbered ? Number(numbered[2]) : null;
      const fallbackIdentity = [aria, slickIndex, imageSrc, imageAlt, text]
        .filter(Boolean)
        .join("|");
      if (!fallbackIdentity) return null;
      const baseLabel =
        ordinal && total
          ? `Carousel slide ${ordinal} of ${total}`
          : ordinal
            ? `Carousel slide ${ordinal}`
            : "Carousel slide";
      const hasDisclaimer = Array.from(
        active.querySelectorAll("button, a, [role='button']")
      ).some((element) =>
        /disclaimer/i.test(
          [
            element.textContent,
            element.getAttribute("aria-label"),
            element.getAttribute("title"),
          ]
            .filter(Boolean)
            .join(" ")
        )
      );
      return {
        fingerprint: fallbackIdentity.slice(0, 1000),
        ordinal,
        total,
        label: imageAlt ? `${baseLabel} — ${imageAlt}` : baseLabel,
        adLabel: imageAlt || baseLabel,
        hasDisclaimer,
        nextDisabled:
          next.hasAttribute("disabled") ||
          next.getAttribute("aria-disabled") === "true" ||
          next.classList.contains("disabled"),
      };
    },
  });
  return result || null;
}

async function waitForPrimaryCarouselState(tabId, pauseRotation = false) {
  const deadline = Date.now() + CAROUSEL_DETECTION_TIMEOUT_MS;
  do {
    const state = await readPrimaryCarouselState(tabId, pauseRotation);
    if (state) return state;
    await sleep(250);
  } while (Date.now() < deadline);
  return null;
}

async function pausePrimaryCarousel(tabId) {
  await chrome.scripting
    .executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        const container = document.querySelector(
          '[data-dealer-intel-primary-carousel="true"]'
        );
        if (!(container instanceof HTMLElement)) return;
        container.setAttribute("data-interval", "false");
        container.setAttribute("data-bs-interval", "false");
        container.removeAttribute("data-ride");
        container.removeAttribute("data-bs-ride");
        container.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));

        const page = /** @type {any} */ (window);
        const jquery = page.jQuery || page.$;
        if (jquery?.fn?.carousel) jquery(container).carousel("pause");
        const bootstrapCarousel = page.bootstrap?.Carousel?.getInstance?.(container);
        bootstrapCarousel?.pause?.();
      },
    })
    .catch(() => []);
}

async function advancePrimaryCarousel(
  tabId,
  beforeFingerprint,
  targetOrdinal = null
) {
  for (let clickAttempt = 0; clickAttempt < 2; clickAttempt += 1) {
    const [{ result: clicked }] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [targetOrdinal],
      func: (ordinal) => {
        const container = document.querySelector(
          '[data-dealer-intel-primary-carousel="true"]'
        );
        if (!(container instanceof HTMLElement)) return false;
        const isVisible = (element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden"
          );
        };
        if (Number.isInteger(ordinal) && ordinal > 0) {
          const zeroBased = ordinal - 1;
          const indicator = container.querySelector(
            `[data-slide-to="${zeroBased}"], [data-bs-slide-to="${zeroBased}"]`
          );
          if (indicator instanceof HTMLElement && isVisible(indicator)) {
            indicator.click();
            return true;
          }
        }
        // Deliberately NOT filtered by isVisible: Dealer.com hides this arrow
        // with CSS (`hide-buttons`) and still advances the carousel on a DOM
        // click, so requiring a visible control ended traversal at slide one.
        const next = Array.from(
          container.querySelectorAll(
            'button[aria-label*="next picture" i], button[data-slide="next"], .carousel-control-next, .slick-next, .swiper-button-next, button[aria-label*="next slide" i]'
          )
        ).find((element) => element instanceof HTMLElement);
        if (!(next instanceof HTMLElement)) return false;
        // DealerOn temporarily disables this control during its transition.
        // A DOM click is still accepted after that transition settles, so do
        // not turn the animation state into an early end-of-carousel signal.
        next.click();
        return true;
      },
    });
    if (!clicked) return null;
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      await sleep(100);
      const state = await readPrimaryCarouselState(tabId);
      if (
        state &&
        state.fingerprint !== beforeFingerprint &&
        (!targetOrdinal || state.ordinal === targetOrdinal)
      ) {
        await pausePrimaryCarousel(tabId);
        await sleep(350);
        return (await readPrimaryCarouselState(tabId)) || state;
      }
    }
  }
  return null;
}

async function openActiveCarouselDisclaimer(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const container = document.querySelector(
        '[data-dealer-intel-primary-carousel="true"]'
      );
      if (!(container instanceof HTMLElement)) return null;
      const isVisible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden"
        );
      };
      const slides = Array.from(
        container.querySelectorAll(
          '[aria-label*="carousel slide number" i], .carousel-item, .item, .slick-slide, .swiper-slide'
        )
      );
      const active = slides.find(
        (slide) =>
          slide.matches(
            ".active, .slick-active, .swiper-slide-active, [aria-current='true']"
          ) && isVisible(slide)
      ) || slides.find(isVisible);
      if (!(active instanceof HTMLElement)) return null;
      const trigger = Array.from(
        active.querySelectorAll("button, a, [role='button']")
      ).find(
        (element) =>
          isVisible(element) &&
          /disclaimer/i.test(
            [
              element.textContent,
              element.getAttribute("aria-label"),
              element.getAttribute("title"),
            ]
              .filter(Boolean)
              .join(" ")
          )
      );
      if (!(trigger instanceof HTMLElement)) return null;
      trigger.dataset.dealerIntelDisclaimerSeen = "true";
      const embeddedDisclosure = trigger.getAttribute("data-content") || "";
      const embeddedHasOffer =
        /\$\s?[\d,]+(?:\.\d{2})?/i.test(embeddedDisclosure) ||
        /\b\d+(?:\.\d+)?\s*%\s*(?:apr|financing|off)?\b/i.test(
          embeddedDisclosure
        ) ||
        /\b(?:due at signing|monthly payment|per month|\/\s*mo\b)/i.test(
          embeddedDisclosure
        );
      // DealerOn places the full disclosure in data-content. Use it to avoid
      // even opening award/brag boilerplate that happens to say Disclaimer.
      if (embeddedDisclosure && !embeddedHasOffer) return null;
      const imageAlt = (active.querySelector("img")?.getAttribute("alt") || "")
        .replace(/\s+/g, " ")
        .trim();
      const pathBefore = window.location.pathname;
      trigger.click();
      return { pathBefore, preAnchor: imageAlt.slice(0, 120) };
    },
  });
  return result || null;
}

async function openNextDisclaimer(tabId) {
  /** Self-contained because Chrome serializes it into each accessible frame. */
  function findOrOpenDisclaimer(shouldOpen) {
    const isVisible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden"
      );
    };
    const candidates = [];
    const selectors = [
      ".ddc-offer-disclosure",
      ".disclaimertoggle",
      '[class*="offer" i] button[class*="disclaimer" i]',
      '[class*="offer" i] a[class*="disclaimer" i]',
      '[class*="disclaimer" i][role="button"]',
      '[class*="disclaimer" i]:is(button, a)',
    ];
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (!candidates.includes(element)) candidates.push(element);
      }
    }
    for (const element of document.querySelectorAll(
      "button, a, [role='button'], div, span"
    )) {
      const text = (element.textContent || "").replace(/\s+/g, " ").trim();
      if (
        /^(?:view\s+)?(?:details\s*&\s*)?disclaimer$/i.test(text) ||
        /^offer details$/i.test(text)
      ) {
        const nestedExact = Array.from(element.children).some((child) =>
          (child.textContent || "").replace(/\s+/g, " ").trim() === text
        );
        if (!nestedExact && !candidates.includes(element)) candidates.push(element);
      }
    }

    const priceRe = /\$\s?[\d,]+(?:\.\d{2})?(?:\s?\/?\s?(?:mo|month|week|wk))?/i;
    for (const element of candidates) {
      if (!(element instanceof HTMLElement)) continue;
      if (element.dataset.dealerIntelDisclaimerSeen === "true") continue;
      if (
        element.closest(
          'footer, nav, [role="navigation"], [class*="footer" i], [id*="footer" i], [data-dealer-intel-primary-carousel="true"]'
        ) ||
        !isVisible(element)
      ) {
        continue;
      }

      let card = element;
      for (let depth = 0; depth < 8 && card.parentElement; depth += 1) {
        const parent = card.parentElement;
        if (
          priceRe.test(parent.innerText || "") ||
          parent.querySelector("h1,h2,h3,h4")
        ) {
          card = parent;
          break;
        }
        card = parent;
      }
      const cardText = (card.innerText || "").replace(/\s+/g, " ").trim();
      const valuelessRebate =
        /\brebates?\b/i.test(cardText) &&
        !/\$|\d+\s*%|\d+\s*(?:\/\s*)?(?:mo|month|apr)\b|\bapr\b/i.test(
          cardText
        );
      if (valuelessRebate) continue;
      const embeddedDisclosure = element.getAttribute("data-content") || "";
      const embeddedHasOffer =
        /\$\s?[\d,]+(?:\.\d{2})?/i.test(embeddedDisclosure) ||
        /\b\d+(?:\.\d+)?\s*%\s*(?:apr|financing|off)?\b/i.test(
          embeddedDisclosure
        ) ||
        /\b(?:due at signing|monthly payment|per month|\/\s*mo\b)/i.test(
          embeddedDisclosure
        );
      if (embeddedDisclosure && !embeddedHasOffer) continue;

      if (!shouldOpen) return { found: true };
      element.dataset.dealerIntelDisclaimerSeen = "true";
      element.dataset.dealerIntelActiveDisclaimer = "true";
      const heading = card.querySelector("h1,h2,h3,h4,[class*='title' i]");
      const headingText = (heading?.textContent || "")
        .replace(/\s+/g, " ")
        .trim();
      const price = cardText.match(priceRe)?.[0]?.trim() || "";
      const preAnchor = [headingText, price]
        .filter(Boolean)
        .join(" — ")
        .slice(0, 120);
      element.scrollIntoView({ block: "center" });
      element.click();
      return { found: true, preAnchor };
    }
    return null;
  }

  const frameMatches = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    args: [false],
    func: findOrOpenDisclaimer,
  });
  const pathBefore = new URL((await chrome.tabs.get(tabId)).url).pathname;
  for (const match of frameMatches) {
    if (!match.result?.found) continue;
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [match.frameId] },
      args: [true],
      func: findOrOpenDisclaimer,
    });
    if (result?.found) {
      return {
        pathBefore,
        preAnchor: result.preAnchor || "",
        frameId: match.frameId,
      };
    }
  }
  return null;
}

/** Chrome kills an injection when its target document goes away mid-call. A
 *  disclaimer trigger is often a real link, so the click that was supposed to
 *  open a modal navigates instead and every later read throws this. It means
 *  "the page moved", not "the capture is broken". */
function isFrameGoneError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /frame (?:with id .*)?was removed|no frame with id|no tab with id|frame was removed|document was unloaded/i.test(
    message
  );
}

function hasOfferTerms(text) {
  return (
    /\$\s?[\d,]+(?:\.\d{2})?/i.test(text) ||
    /\b\d+(?:\.\d+)?\s*%\s*(?:apr|financing|off)?\b/i.test(text) ||
    /\b(?:due at signing|monthly payment|per month|\/\s*mo\b)/i.test(text)
  );
}

async function readDisclaimer(tabId, frameId = 0) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    func: () => {
      const selector =
        '[class*="modal" i],[role="dialog"],[class*="dialog" i],[class*="popup" i]';
      const visible = Array.from(document.querySelectorAll(selector)).filter(
        (element) =>
          element instanceof HTMLElement &&
          element.offsetParent !== null &&
          (element.innerText || "").trim().length > 20
      );
      visible.sort((a, b) => b.innerText.length - a.innerText.length);
      let disclosure = visible[0] || null;
      if (!disclosure) {
        const trigger = document.querySelector(
          '[data-dealer-intel-active-disclaimer="true"]'
        );
        let card = trigger?.parentElement || null;
        for (let depth = 0; card && depth < 8; depth += 1) {
          const candidate = Array.from(
            card.querySelectorAll(
              '.disclaimerwrap.open .disclaimer, .disclaimerwrap.open, [class*="disclaimer" i].open, [class*="details" i].open, [aria-expanded="true"] + *'
            )
          ).find(
            (element) =>
              element instanceof HTMLElement &&
              element !== trigger &&
              element.offsetParent !== null &&
              (element.innerText || "").trim().length > 20
          );
          if (candidate instanceof HTMLElement) {
            disclosure = candidate;
            break;
          }
          card = card.parentElement;
        }
      }
      if (!disclosure) return { anchor: "", text: "" };
      const full = disclosure.innerText.replace(/\s+/g, " ").trim();
      let anchor = full;
      const cut = anchor.search(/disclaimer/i);
      if (cut > 0) anchor = anchor.slice(0, cut).trim();
      anchor = anchor
        .replace(/\b(never\s+expires?|expires?\s+\d[\d/\-.]*|exp\.?\s+\d[\d/\-.]*)\b.*/i, "")
        .replace(/\b(request\s+more\s+info|more\s+info|learn\s+more|get\s+coupon|print\s+coupon|schedule\s+service|book\s+now|shop\s+now|view\s+\d+\s+qualifying\s+vehicle|view\s+vehicle\s+details|view\s+details|open\s+in\s+same\s+tab)\b.*/i, "")
        .trim();
      return { anchor: anchor.slice(0, 110), text: full.slice(0, 8000) };
    },
  });
  return result || { anchor: "", text: "" };
}

async function closeDisclaimer(tabId, frameId = 0) {
  await chrome.scripting
    .executeScript({
      target: { tabId, frameIds: [frameId] },
      func: () => {
        const trigger = document.querySelector(
          '[data-dealer-intel-active-disclaimer="true"]'
        );
        let card = trigger?.parentElement || null;
        for (let depth = 0; card && depth < 8; depth += 1) {
          const inlineClose = card.querySelector(
            '.disclaimerclose, [class*="disclaimer" i][class*="close" i], [class*="details" i] button[aria-label*="close" i]'
          );
          if (
            inlineClose instanceof HTMLElement &&
            inlineClose.offsetParent !== null
          ) {
            inlineClose.click();
            trigger?.removeAttribute("data-dealer-intel-active-disclaimer");
            return;
          }
          card = card.parentElement;
        }
        const dialogs = Array.from(
          document.querySelectorAll(
            '[class*="modal" i],[role="dialog"],[class*="dialog" i],[class*="popup" i]'
          )
        ).filter(
          (element) => element instanceof HTMLElement && element.offsetParent !== null
        );
        for (const dialog of dialogs) {
          const close = dialog.querySelector(
            'button[aria-label*="close" i], button[title*="close" i], button[class*="close" i], [class*="close" i][role="button"]'
          );
          if (close instanceof HTMLElement) {
            close.click();
            trigger?.removeAttribute("data-dealer-intel-active-disclaimer");
            return;
          }
        }
        for (const target of [document.activeElement, document, window]) {
          target?.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "Escape",
              code: "Escape",
              bubbles: true,
            })
          );
        }
        trigger?.removeAttribute("data-dealer-intel-active-disclaimer");
      },
    })
    .catch(() => []);
  await sleep(300);
}

/** True when two URLs address the same page, ignoring a trailing slash and a
 *  leading `www.` — the extension's copy of the server's isSameLocation. */
function isSameLocation(left, right) {
  try {
    const a = new URL(left);
    const b = new URL(right);
    return (
      a.host.replace(/^www\./i, "") === b.host.replace(/^www\./i, "") &&
      a.pathname.replace(/\/$/, "") === b.pathname.replace(/\/$/, "")
    );
  } catch {
    return false;
  }
}

/** True when a URL points at a front page — a root path, whoever owns the
 *  host. Mirrors the server's isHomepageUrl. */
function isHomepageUrl(url) {
  try {
    return new URL(url).pathname.replace(/\/+$/, "") === "";
  } catch {
    return false;
  }
}

const MISSING_PAGE_PATTERN =
  /\b(404|page not found|page cannot be found|page can'?t be found|not found|no longer available)\b/i;

async function navigateTo(tabId, url) {
  await chrome.tabs.update(tabId, { url });
  await waitForTabComplete(tabId);
  await sleep(500);
}

/** Whether the tab is standing on a page this mission may collect. Read in the
 *  browser rather than over `fetch`, which is the whole point: 16 of 62 dealers
 *  — Speedcraft, the Tasca and Nucar groups, Mastria — answer server-side
 *  requests with a Cloudflare 403 and load normally here. */
async function missionPageVerdict(tabId, item) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      url: window.location.href,
      title: document.title || "",
      h1: document.querySelector("h1")?.textContent || "",
    }),
  });
  if (!result?.url) return { ok: false, url: "" };
  const banned = (item.discovery?.bannedPatterns || []).some((source) => {
    const pattern = new RegExp(source, "i");
    return pattern.test(result.url) || pattern.test(`${result.title} ${result.h1}`);
  });
  const ok =
    !isHomepageUrl(result.url) &&
    !isSameLocation(result.url, item.homeUrl || item.url) &&
    !MISSING_PAGE_PATTERN.test(`${result.title} ${result.h1}`) &&
    !banned;
  return { ok, url: result.url };
}

/** Pages the dealer's own menu points at for this mission, best first.
 *
 *  Read off the rendered DOM, so submenu entries count even while collapsed —
 *  Speedcraft Nissan's service page is only reachable as "Service & Parts
 *  Specials" under the "Service Specials" menu. The matching rules arrive with
 *  the job as regex sources so there is one copy of them, on the server. */
async function menuCandidates(tabId, item) {
  const discovery = item.discovery;
  const [{ result: links }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () =>
      Array.from(document.querySelectorAll("a[href]"))
        .map((anchor) => ({
          text: (anchor.textContent || "").replace(/\s+/g, " ").trim().toLowerCase(),
          href: anchor.href,
          // A dropdown group header is not a destination — its href is the
          // department, not the specials page nested underneath it.
          toggle:
            anchor.getAttribute("data-toggle") === "dropdown" ||
            /\bnav-with-children\b/.test(anchor.getAttribute("class") || ""),
        }))
        .filter((link) => link.text && /^https?:/i.test(link.href) && !link.toggle),
  });

  const host = (() => {
    try {
      return new URL(item.homeUrl).host;
    } catch {
      return "";
    }
  })();
  const sameHost = (links || []).filter((link) => {
    try {
      return new URL(link.href).host === host;
    } catch {
      return false;
    }
  });

  const excluded = (link) =>
    discovery.bannedPatterns.some((source) => {
      const pattern = new RegExp(source, "i");
      return pattern.test(link.href) || pattern.test(link.text);
    }) ||
    discovery.exclusionPatterns.some((source) =>
      new RegExp(source, "i").test(link.text)
    );

  // First usable match per keyword, in keyword order — most specific first.
  const candidates = [];
  for (const source of discovery.keywordPatterns) {
    const pattern = new RegExp(source, "i");
    const match = sameHost.find(
      (link) =>
        pattern.test(link.text) &&
        !excluded(link) &&
        !isSameLocation(link.href, item.homeUrl) &&
        !candidates.includes(link.href)
    );
    if (match) candidates.push(match.href);
    if (candidates.length >= discovery.maxCandidates) break;
  }

  // Platform paths last: a link the dealer's own menu labels as specials is
  // stronger evidence than any path convention.
  const base = item.homeUrl.replace(/\/+$/, "");
  for (const path of discovery.defaultPaths) {
    const url = `${base}/${path}`;
    if (!candidates.includes(url)) candidates.push(url);
  }
  return candidates;
}

/** Puts the tab on the page this mission should collect, or throws.
 *
 *  The saved URL gets first refusal, then the dealer's menu. Dealer platforms
 *  rename these pages between months (Speedcraft's service coupons live at
 *  `/providence-nissan-service-parts-coupons/`), and a stale saved path either
 *  404s or bounces to the homepage — at which point the menu, read live, is the
 *  way through. */
async function openMissionPage(tabId, item) {
  const current = await chrome.tabs.get(tabId);
  if (!isSameLocation(current.url || "", item.url)) {
    await navigateTo(tabId, item.url);
  }
  if (!item.discovery) return;
  if ((await missionPageVerdict(tabId, item)).ok) return;

  // Any other saved path gets its turn before the menu walk — the operator can
  // park a spare there, and a stale one costs a single load.
  for (const saved of item.savedUrls || []) {
    if (isSameLocation(saved, item.url)) continue;
    await navigateTo(tabId, saved);
    if ((await missionPageVerdict(tabId, item)).ok) return;
  }

  await navigateTo(tabId, item.homeUrl);
  for (const candidate of await menuCandidates(tabId, item)) {
    await navigateTo(tabId, candidate);
    if ((await missionPageVerdict(tabId, item)).ok) return;
  }
  throw new Error(
    `No saved URL or menu link led to this dealer's ${item.missionName} page`
  );
}

async function collectItem(item, dealerIntelTabId, collectionRequestId) {
  beginAdImageContext(collectionRequestId, item.adImageRules || null);
  const { windowId, tabId } = await ensureSiteSession(item);
  // Every mission for a dealer shares one session tab, and ensureSiteSession
  // only re-navigates when the ORIGIN differs — same dealer, same origin, so it
  // never did. Missions after the first inherited whatever page the previous one
  // left up: homepage_offers runs first, so finance_offers and service_specials
  // captured the homepage and were recorded as "redirected to the homepage"
  // when the browser had simply never been sent to their page.
  await openMissionPage(tabId, item);
  let order = 0;
  let stateCount = 0;
  let baseUrl = item.url;

  try {
    await preparePage(tabId, item.explore?.accordions);
    // Stop autoplay before any evidence is captured. Otherwise a timed rotation
    // can change the active ad between DOM inspection, screenshot, and click.
    let carousel = item.explore?.carousels
      ? await waitForPrimaryCarouselState(tabId, true)
      : null;
    if (carousel) {
      await pausePrimaryCarousel(tabId);
      carousel = (await readPrimaryCarouselState(tabId)) || carousel;
    }
    const initial = await pageMetadata(tabId);
    baseUrl = initial.finalUrl;
    const base = await captureState(tabId, windowId, {
      stateId: "base",
      stateKind: "base",
      stateOrder: order++,
      label: `${initial.pageTitle || item.siteName} — ${initial.finalUrl}`,
      fullPage: true,
    });
    await emitCaptureState(dealerIntelTabId, collectionRequestId, base);
    stateCount += 1;

    if (item.explore?.tabs) {
      for (let attempt = 0; attempt < MAX_TABS - 1; attempt += 1) {
        const tab = await clickNextTab(tabId);
        if (!tab) break;
        if (tab.skipped) continue;
        await waitAfterInteraction(tabId, 600);
        const state = await captureState(tabId, windowId, {
          stateId: `tab-${tab.index}`,
          stateKind: "tab",
          stateOrder: order++,
          label: tab.label,
          fullPage: false,
        });
        await emitCaptureState(dealerIntelTabId, collectionRequestId, state);
        stateCount += 1;
      }
    }

    if (item.explore?.carousels && carousel) {
      const seenSlides = new Set();
      let traversal = 0;
      while (
        carousel &&
        !seenSlides.has(carousel.fingerprint) &&
        traversal < CAROUSEL_SAFETY_LIMIT
      ) {
        seenSlides.add(carousel.fingerprint);
        traversal += 1;
        const slideOrdinal = carousel.ordinal || traversal;
        const carouselStateId = `carousel-${slideOrdinal}`;
        const state = await captureState(tabId, windowId, {
          stateId: carouselStateId,
          stateKind: "carousel",
          stateOrder: order++,
          label: carousel.label,
          fullPage: false,
        });
        await emitCaptureState(dealerIntelTabId, collectionRequestId, state);
        stateCount += 1;

        // Disclosures belong to the active ad, so open them while that exact
        // slide is still selected. Award/legal boilerplate is rejected after
        // opening unless the modal contains real price/APR/payment terms.
        if (item.explore?.disclaimers && carousel.hasDisclaimer) {
          const trigger = await openActiveCarouselDisclaimer(tabId);
          if (trigger) {
            await waitAfterInteraction(tabId, 1_000);
            const afterOpen = await pageMetadata(tabId);
            if (new URL(afterOpen.finalUrl).pathname === trigger.pathBefore) {
              const modal = await readDisclaimer(tabId);
              if (hasOfferTerms(modal.text)) {
                const disclosure = await captureState(tabId, windowId, {
                  stateId: `${carouselStateId}-disclaimer`,
                  stateKind: "disclaimer",
                  stateOrder: order++,
                  label: `${carousel.adLabel || trigger.preAnchor || carousel.label} — Disclaimer`,
                  textContent: modal.text,
                  fullPage: false,
                });
                await emitCaptureState(
                  dealerIntelTabId,
                  collectionRequestId,
                  disclosure
                );
                stateCount += 1;
              }
              await closeDisclaimer(tabId);
              await pausePrimaryCarousel(tabId);
            } else {
              await chrome.tabs.goBack(tabId).catch(() => {});
              await waitForTabComplete(tabId).catch(() => {});
              carousel = await readPrimaryCarouselState(tabId, true);
              if (carousel) await pausePrimaryCarousel(tabId);
            }
          }
        }

        if (
          carousel?.nextDisabled &&
          (!carousel.total || !carousel.ordinal || carousel.ordinal >= carousel.total)
        ) {
          break;
        }
        const next = await advancePrimaryCarousel(
          tabId,
          carousel.fingerprint,
          carousel.total && carousel.ordinal
            ? (carousel.ordinal % carousel.total) + 1
            : null
        );
        if (!next || seenSlides.has(next.fingerprint)) break;
        carousel = next;
      }
    }

    if (item.explore?.disclaimers) {
      let disclaimerNumber = 0;
      for (
        let attempt = 0;
        attempt < DISCLAIMER_SAFETY_LIMIT &&
        disclaimerNumber < DISCLAIMER_SAFETY_LIMIT;
        attempt += 1
      ) {
        const trigger = await openNextDisclaimer(tabId);
        if (!trigger) break;
        await waitAfterInteraction(tabId, 1_000);
        let modal;
        try {
          const afterOpen = await pageMetadata(tabId);
          if (new URL(afterOpen.finalUrl).pathname !== trigger.pathBefore) {
            await chrome.tabs.goBack(tabId).catch(() => {});
            await waitForTabComplete(tabId).catch(() => {});
            continue;
          }
          modal = await readDisclaimer(tabId, trigger.frameId);
        } catch (error) {
          if (!isFrameGoneError(error)) throw error;
          await chrome.tabs.goBack(tabId).catch(() => {});
          await waitForTabComplete(tabId).catch(() => {});
          continue;
        }
        if (!hasOfferTerms(modal.text)) {
          await closeDisclaimer(tabId, trigger.frameId);
          continue;
        }
        disclaimerNumber += 1;
        const label =
          trigger.preAnchor || modal.anchor || `Disclaimer ${disclaimerNumber}`;
        const state = await captureState(tabId, windowId, {
          stateId: `disclaimer-${disclaimerNumber}`,
          stateKind: "disclaimer",
          stateOrder: order++,
          label,
          textContent: modal.text || undefined,
          fullPage: false,
        });
        await emitCaptureState(dealerIntelTabId, collectionRequestId, state);
        stateCount += 1;
        await closeDisclaimer(tabId, trigger.frameId);
      }
    }

    return {
      finalUrl: baseUrl,
      pageTitle: initial.pageTitle,
      stateCount,
    };
  } catch (error) {
    try {
      const failure = await captureState(tabId, windowId, {
        stateId: `failure-${order}`,
        stateKind: "failure",
        stateOrder: order,
        label: `Capture failure: ${
          error instanceof Error ? error.message : String(error)
        }`.slice(0, 180),
        fullPage: false,
      });
      await emitCaptureState(dealerIntelTabId, collectionRequestId, failure);
    } catch {
      // Preserve the first error; failure evidence is best-effort.
    }
    throw error;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.command === "PING") {
    sendResponse({
      ok: true,
      protocolVersion: PROTOCOL_VERSION,
      version: chrome.runtime.getManifest().version,
    });
    return false;
  }

  if (message?.command === "ACK_CAPTURE_STATE") {
    const { collectionRequestId, stateId, ok, error } = message.payload || {};
    const pending = pendingCaptureAcks.get(
      captureAckKey(collectionRequestId, stateId)
    );
    if (!pending) {
      sendResponse({ ok: false, error: "Capture state is no longer pending" });
      return false;
    }
    if (ok) pending.resolve();
    else pending.reject(new Error(error || `Upload failed for ${stateId}`));
    sendResponse({ ok: true });
    return false;
  }

  if (message?.command === "COLLECT_ITEM") {
    const dealerIntelTabId = sender.tab?.id;
    const collectionRequestId = message.collectionRequestId;
    if (dealerIntelTabId === undefined || !collectionRequestId) {
      sendResponse({ ok: false, error: "Chrome collection request has no source tab" });
      return false;
    }
    collectItem(message.payload, dealerIntelTabId, collectionRequestId)
      .then((summary) => sendResponse({ ok: true, summary }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      );
    return true;
  }

  if (message?.command === "COLLECT_INVENTORY") {
    (async () => {
      let response;
      activeInventoryController?.abort(
        new DOMException("Inventory collection replaced", "AbortError")
      );
      const controller = new AbortController();
      activeInventoryController = controller;
      try {
        const result = await inventoryShared.withGuaranteedCleanup(
          () =>
            inventoryCollector.collectInventory(message.payload, {
              ensureSiteSession,
              suppressPageObstructions,
              waitAfterInteraction,
              waitForTabComplete,
              signal: controller.signal,
            }),
          closeActiveSession
        );
        response = { ok: true, result };
      } catch (error) {
        response = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        if (activeInventoryController === controller) {
          activeInventoryController = null;
        }
      }
      sendResponse(response);
    })();
    return true;
  }

  if (message?.command === "CLOSE_SESSION") {
    activeInventoryController?.abort(
      new DOMException("Inventory collection cancelled", "AbortError")
    );
    closeActiveSession()
      .then(() => sendResponse({ ok: true }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      );
    return true;
  }

  sendResponse({ ok: false, error: "Unknown Dealer Intel command" });
  return false;
});
