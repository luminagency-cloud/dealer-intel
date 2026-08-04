/* global chrome */

/**
 * URL-driven inventory navigation shared by the platform adapters.
 *
 * Design note. Earlier passes reached the SRP by hovering and clicking the
 * dealer's top menu. That made results theme-dependent: menu labels vary per
 * dealer ("New Inventory" / "View New Inventory" / "Shop New"), CSS-only
 * dropdowns never open for synthetic hover events, and click coordinates go
 * stale between measurement and dispatch.
 *
 * Public SRP URLs are a far stronger contract than menu labels or DOM
 * internals: the dealer's own site links to them, Google indexes them, and
 * customers bookmark them. So navigation is tiered, cheapest and most stable
 * first:
 *
 *   1. the page we are already on, if it is a usable SRP
 *   2. the operator-stored `inventoryPath` for this dealer
 *   3. the platform default path
 *   4. link discovery from the homepage (href-ranked, label-tolerant)
 *
 * Menu clicking is gone entirely. Tier 4 reads hrefs out of the DOM instead,
 * which needs no hover, no coordinates, and no debugger attach.
 */
(() => {
  const PLATFORM_INVENTORY_PATHS = {
    ddc: "/new-inventory/index.htm",
    dealer_inspire: "/new-vehicles/",
    dealer_alchemist: "/new-vehicles/",
  };

  // Ranked best-first. Mirrors the ranking the sibling inventory service
  // settled on after its own live matrix; lower is better.
  const HREF_RANKS = [
    /\/new-inventory\/index\.htm(?:[?#]|$)/i,
    /\/new-inventory\/?(?:[?#]|$)/i,
    /\/new-vehicles\/?(?:[?#]|$)/i,
    /new-vehicle-inventory/i,
    /new-inventory/i,
    /new-vehicles/i,
  ];

  // Applied to the href only, never to the visible label. `/new-inventory/`
  // is unambiguous; the label around it is marketing copy that routinely
  // mentions used or specials in the same nav block.
  const HREF_EXCLUDE =
    /used|pre-owned|preowned|certified|cpo|special|offer|finance|service|parts|trade|rental|commercial/i;

  const HREF_INCLUDE = /new-inventory|new-vehicles|new-vehicle-inventory|inventory/i;

  async function execute(tabId, func, args = []) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func,
      args,
    });
    return result;
  }

  function absoluteUrl(base, path) {
    try {
      return new URL(path, base).toString();
    } catch {
      return null;
    }
  }

  /**
   * Set (or delete, when the value is null) query params on a URL. Used for
   * every filter pass so a make/status selection is one stateless navigation
   * instead of a click sequence that has to be unwound afterwards.
   */
  function withParams(url, params) {
    const next = new URL(url);
    for (const [key, value] of Object.entries(params)) {
      if (value === null || value === undefined || value === "") {
        next.searchParams.delete(key);
      } else {
        next.searchParams.set(key, String(value));
      }
    }
    return next.toString();
  }

  function currentUrl(tabId) {
    return execute(tabId, () => location.href);
  }

  const NAVIGATION_COMMIT_TIMEOUT_MS = 45_000;

  function safeUrl(value) {
    try {
      return value ? new URL(value) : null;
    } catch {
      return null;
    }
  }

  /**
   * Navigate the collection tab and wait for the NEW page to settle.
   *
   * `chrome.tabs.update` resolves as soon as the navigation is queued, not
   * when it commits. Calling `waitForTabComplete` straight afterwards can
   * therefore observe the PREVIOUS page still sitting in readyState
   * "complete" and return immediately — every readiness check then runs
   * against stale markup and a perfectly good SRP looks unreachable.
   *
   * Matching on pathname alone is not enough here either: each make pass
   * navigates the same `/new-inventory/index.htm` with different query
   * params, so we wait to actually observe the load begin.
   */
  async function goto(tabId, url, helpers, runtime) {
    runtime.throwIfCancelled();
    const target = safeUrl(url);
    // No `active: true`. The collection tab is the only tab in its own
    // window, so activating it on every filter navigation bought nothing and
    // yanked focus away from the operator dozens of times per batch.
    await chrome.tabs.update(tabId, { url });

    // Let the navigation commit before sampling tab state at all.
    await runtime.sleep(250);

    const deadline = Date.now() + NAVIGATION_COMMIT_TIMEOUT_MS;
    let sawLoading = false;
    while (Date.now() < deadline) {
      runtime.throwIfCancelled();
      let tab;
      try {
        tab = await chrome.tabs.get(tabId);
      } catch {
        break;
      }
      if (tab.status === "loading") {
        sawLoading = true;
      } else if (tab.status === "complete") {
        const committed = safeUrl(tab.url);
        const exact =
          committed && target && committed.href.split("#")[0] === target.href.split("#")[0];
        // Either we watched this navigation run, or the tab is already
        // sitting on exactly the URL we asked for.
        if (sawLoading || exact) break;
      }
      await runtime.sleep(150);
    }

    await helpers.waitForTabComplete(tabId);
    await runtime.suppressPopups(tabId);
    return currentUrl(tabId);
  }

  /**
   * Rank every inventory-ish anchor on the page by its href and return the
   * best absolute URL. No hover, no click, no coordinates — we read the href
   * and navigate to it directly.
   */
  async function discoverInventoryHref(tabId) {
    const href = await execute(
      tabId,
      (rankSources, excludeSource, includeSource) => {
        const ranks = rankSources.map((source) => new RegExp(source, "i"));
        const exclude = new RegExp(excludeSource, "i");
        const include = new RegExp(includeSource, "i");
        const clean = (value) =>
          String(value || "")
            .replace(/[-]/g, "")
            .replace(/\s+/g, " ")
            .trim();

        const scored = [];
        for (const anchor of document.querySelectorAll("a[href]")) {
          const raw = anchor.getAttribute("href") || "";
          let resolved;
          try {
            resolved = new URL(anchor.href, location.href);
          } catch {
            continue;
          }
          if (resolved.origin !== location.origin) continue;

          const path = `${resolved.pathname}${resolved.search}`;
          if (!include.test(path) || exclude.test(path)) continue;

          let rank = ranks.findIndex((pattern) => pattern.test(path));
          if (rank === -1) rank = ranks.length;

          // A matching label is a tiebreaker between equally ranked hrefs,
          // never a requirement. An anchor labelled "New" pointing at
          // /new-inventory/index.htm is still the right answer.
          const text = clean(anchor.innerText || anchor.getAttribute("aria-label"));
          const labelled = /inventory|new vehicles?|shop new|view new|browse new/i.test(text)
            ? 0
            : 1;

          scored.push({ href: resolved.toString(), rank, labelled, raw });
        }

        scored.sort(
          (left, right) => left.rank - right.rank || left.labelled - right.labelled
        );
        return scored[0]?.href ?? null;
      },
      [HREF_RANKS.map((pattern) => pattern.source), HREF_EXCLUDE.source, HREF_INCLUDE.source]
    );
    return href;
  }

  /**
   * Walk the navigation tiers until `inspect(tabId)` reports a usable page.
   *
   * `inspect` returns a state object carrying `ready`, so the adapter
   * decides what "usable SRP" means for its platform. Every rejected tier is
   * recorded in `warnings` so a dealer that had to fall back is visible in the
   * stored result rather than silently slower.
   */
  function describeObserved(observed) {
    if (!observed || typeof observed !== "object") return "no page state";
    return Object.entries(observed)
      .filter(([key]) => key !== "url")
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(" ");
  }

  async function resolveInventoryPage(options) {
    const {
      tabId,
      item,
      platform,
      inspect,
      helpers,
      runtime,
      warnings = [],
      attempted = [],
    } = options;

    // Every tier records why it was rejected and what it actually saw on the
    // page. Without this a failure collapses into one opaque sentence that
    // covers four different causes (404, wrong-looking page, no link found,
    // navigation never completed) and is undiagnosable from a batch log.
    const trace = [];

    const record = (tier, url, outcome, observed) => {
      trace.push(
        `${tier}${url ? ` <${url}>` : ""}: ${outcome}${
          observed ? ` [${describeObserved(observed)}]` : ""
        }`
      );
    };

    const tryCandidate = async (url, label) => {
      if (!url) {
        record(label, url, "no URL to try");
        return null;
      }
      if (attempted.includes(url)) {
        record(label, url, "already tried");
        return null;
      }
      attempted.push(url);
      try {
        await goto(tabId, url, helpers, runtime);
      } catch (error) {
        record(
          label,
          url,
          `navigation failed: ${error instanceof Error ? error.message : String(error)}`
        );
        return null;
      }
      let result;
      try {
        result = await inspect(tabId);
      } catch (error) {
        record(
          label,
          url,
          `page inspection failed: ${error instanceof Error ? error.message : String(error)}`
        );
        return null;
      }
      if (result?.ready) return result;
      record(label, result?.url ?? url, "loaded but not a usable inventory page", result);
      return null;
    };

    // Tier 1 — already there. ensureSiteSession may have landed directly on a
    // stored SRP URL, in which case no navigation is needed at all.
    runtime.throwIfCancelled();
    let landed = null;
    try {
      landed = await inspect(tabId);
    } catch (error) {
      record("Landing page", null, `page inspection failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (landed?.ready) return landed;
    if (landed) record("Landing page", landed.url, "not a usable inventory page", landed);

    const base = (await currentUrl(tabId).catch(() => null)) || item.url;

    // Tier 2 — the path the operator stored for this dealer.
    if (item.inventoryPath) {
      const stored = await tryCandidate(
        absoluteUrl(base, item.inventoryPath),
        "Stored inventory path"
      );
      if (stored) return stored;
    } else {
      record("Stored inventory path", null, "none configured for this dealer");
    }

    // Tier 3 — the platform's canonical path.
    const defaultPath = PLATFORM_INVENTORY_PATHS[platform];
    if (defaultPath) {
      const byDefault = await tryCandidate(
        absoluteUrl(base, defaultPath),
        `${platform} default path`
      );
      if (byDefault) return byDefault;
    } else {
      record(`${platform} default path`, null, "no default path for this platform");
    }

    // Tier 4 — discover a link from the dealer's own markup. Go home first so
    // we are reading the full primary nav rather than whatever a failed tier
    // left on screen.
    try {
      await goto(tabId, item.url, helpers, runtime);
    } catch {
      // Discovery below still works against whatever page is loaded.
    }
    const discovered = await discoverInventoryHref(tabId).catch((error) => {
      record(
        "Link discovery",
        null,
        `href scan failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    });
    if (discovered) {
      const byLink = await tryCandidate(discovered, "Discovered inventory link");
      if (byLink) return byLink;
    } else {
      // Dump what the scan *did* see, so a nav that exists but scores wrong is
      // distinguishable from a page with no inventory links at all.
      const sample = await sampleInventoryHrefs(tabId).catch(() => null);
      record(
        "Link discovery",
        null,
        sample && sample.length > 0
          ? `no href passed the filter; closest candidates: ${sample.join(" | ")}`
          : "no same-origin anchors matched an inventory URL pattern"
      );
    }

    warnings.push(...trace);
    const error = new Error(
      `Could not reach a ${platform} inventory page. Tried:\n  - ${trace.join("\n  - ")}`
    );
    error.navigationTrace = trace;
    throw error;
  }

  /**
   * Diagnostic only: the same-origin anchors that came closest to matching,
   * so a failure report shows what the dealer's nav actually contains.
   */
  async function sampleInventoryHrefs(tabId) {
    return execute(
      tabId,
      (includeSource, excludeSource) => {
        const include = new RegExp(includeSource, "i");
        const exclude = new RegExp(excludeSource, "i");
        const seen = new Set();
        const out = [];
        for (const anchor of document.querySelectorAll("a[href]")) {
          let resolved;
          try {
            resolved = new URL(anchor.href, location.href);
          } catch {
            continue;
          }
          if (resolved.origin !== location.origin) continue;
          const path = `${resolved.pathname}${resolved.search}`;
          if (!/inventory|vehicle|new|shop|search/i.test(path)) continue;
          const why = !include.test(path)
            ? "no inventory pattern"
            : exclude.test(path)
              ? "excluded as used/specials"
              : "matched";
          const entry = `${path.slice(0, 70)} (${why})`;
          if (seen.has(entry)) continue;
          seen.add(entry);
          out.push(entry);
          if (out.length >= 8) break;
        }
        return out;
      },
      [HREF_INCLUDE.source, HREF_EXCLUDE.source]
    );
  }

  globalThis.inventoryNavigate = {
    HREF_EXCLUDE,
    HREF_INCLUDE,
    HREF_RANKS,
    PLATFORM_INVENTORY_PATHS,
    absoluteUrl,
    currentUrl,
    discoverInventoryHref,
    execute,
    goto,
    resolveInventoryPage,
    withParams,
  };
})();
