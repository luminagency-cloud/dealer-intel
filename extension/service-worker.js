const PROTOCOL_VERSION = 2;
const NAVIGATION_TIMEOUT_MS = 45_000;
let activeSession = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTabComplete(tabId) {
  const existing = await chrome.tabs.get(tabId);
  if (existing.status === "complete") return;

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("Timed out waiting for the dealer page to load"));
    }, NAVIGATION_TIMEOUT_MS);

    function onUpdated(updatedTabId, changeInfo) {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function closeActiveSession() {
  const session = activeSession;
  activeSession = null;
  if (session?.windowId !== undefined) {
    await chrome.windows.remove(session.windowId).catch(() => {});
  }
}

async function ensureSiteSession(item) {
  if (!item?.url || !item?.siteId) {
    throw new Error("Collection job did not include a dealer and URL");
  }

  if (activeSession?.siteId === item.siteId) {
    try {
      const tab = await chrome.tabs.get(activeSession.tabId);
      await chrome.windows.update(activeSession.windowId, { focused: true });
      if (tab.url !== item.url) {
        await chrome.tabs.update(activeSession.tabId, { url: item.url, active: true });
        await waitForTabComplete(activeSession.tabId);
      }
      return activeSession;
    } catch {
      await closeActiveSession();
    }
  } else if (activeSession) {
    await closeActiveSession();
  }

  const created = await chrome.windows.create({
    url: item.url,
    focused: true,
    type: "normal",
  });
  const windowId = created.id;
  const tabId = created.tabs?.[0]?.id;
  if (windowId === undefined || tabId === undefined) {
    throw new Error("Chrome did not create the collection window");
  }

  activeSession = { siteId: item.siteId, windowId, tabId };
  await waitForTabComplete(tabId);
  return activeSession;
}

/** Best-effort consent suppression inside every accessible frame. The injected
 * function is deliberately self-contained because Chrome serializes it rather
 * than preserving service-worker closures. */
async function suppressConsentObstructions(tabId) {
  await chrome.scripting
    .executeScript({
      target: { tabId, allFrames: true },
      func: async () => {
        const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const actionPatterns = [
          /^deny (?:optional |targeting )?cookies?$/i,
          /^reject(?: all| optional| targeting)?(?: cookies?)?$/i,
          /^decline(?: all)?(?: cookies?)?$/i,
          /^(?:use )?necessary cookies only$/i,
          /^allow all cookies$/i,
          /^allow targeting cookies$/i,
          /^accept all(?: cookies)?$/i,
          /^accept cookies$/i,
          /^i (?:agree|accept)$/i,
          /^got it$/i,
        ];
        const consentWords = /cookie|privacy|consent|targeting|tracking/i;
        const roots = [document];

        // Consent managers increasingly render inside open shadow roots.
        for (let index = 0; index < roots.length; index += 1) {
          const root = roots[index];
          for (const element of root.querySelectorAll("*")) {
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

async function collectItem(item) {
  const { windowId, tabId } = await ensureSiteSession(item);

  await sleep(1_500);
  await suppressConsentObstructions(tabId);

  await chrome.scripting.executeScript({
    target: { tabId },
    func: async () => {
      const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      for (let step = 0; step < 25; step += 1) {
        if (window.innerHeight + window.scrollY >= document.body.scrollHeight) break;
        window.scrollBy(0, 700);
        await pause(150);
      }
      window.scrollTo(0, 0);
      await pause(300);
    },
  });
  // Consent managers can appear on a delay or re-open after scrolling.
  await suppressConsentObstructions(tabId);

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      finalUrl: window.location.href,
      pageTitle: document.title,
      html: document.documentElement.outerHTML,
    }),
  });
  const screenshotDataUrl = await chrome.tabs.captureVisibleTab(windowId, {
    format: "png",
  });

  return { ...result, screenshotDataUrl };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.command === "PING") {
    sendResponse({
      ok: true,
      protocolVersion: PROTOCOL_VERSION,
      version: chrome.runtime.getManifest().version,
    });
    return false;
  }

  if (message?.command === "COLLECT_ITEM") {
    collectItem(message.payload)
      .then((capture) => sendResponse({ ok: true, capture }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      );
    return true;
  }

  if (message?.command === "CLOSE_SESSION") {
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
