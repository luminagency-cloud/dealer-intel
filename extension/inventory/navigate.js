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
    dealer_on: "/searchnew.aspx",
    apollo: "/inventory/new",
    dealer_masters: "/new-inventory/",
    sokal: "/new-vehicles/",
  };

  // Ranked best-first. Mirrors the ranking the sibling inventory service
  // settled on after its own live matrix; lower is better.
  const HREF_RANKS = [
    /\/new-inventory\/index\.htm(?:[?#]|$)/i,
    /\/new-inventory\/?(?:[?#]|$)/i,
    /\/new-vehicles\/?(?:[?#]|$)/i,
    // DealerOn's SRP. Ranked with the canonical paths rather than below the
    // loose patterns: it is an exact, unambiguous entry point, and no other
    // platform serves anything at this URL.
    /\/searchnew\.aspx(?:[?#]|$)/i,
    /\/inventory\/new\/?(?:[?#]|$)/i,
    /new-vehicle-inventory/i,
    /new-inventory/i,
    /new-vehicles/i,
  ];

  // Applied to the href only, never to the visible label. `/new-inventory/`
  // is unambiguous; the label around it is marketing copy that routinely
  // mentions used or specials in the same nav block.
  const HREF_EXCLUDE =
    /used|pre-owned|preowned|certified|cpo|special|offer|finance|service|parts|trade|rental|commercial/i;

  const HREF_INCLUDE =
    /new-inventory|new-vehicles|new-vehicle-inventory|inventory|searchnew\.aspx/i;

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

  /** Does this URL's path look like an inventory search page? */
  function looksLikeInventoryUrl(value) {
    const parsed = safeUrl(value);
    if (!parsed) return false;
    const path = `${parsed.pathname}${parsed.search}`;
    return HREF_INCLUDE.test(path) && !HREF_EXCLUDE.test(path);
  }

  /**
   * The URL a collection session should OPEN at.
   *
   * The homepage is a bad first destination and was only ever the default
   * because the session had nowhere else to start. It carries no facets, so
   * tier 1 rejects it every time and we then pay for a SECOND full page load
   * to reach an SRP whose URL we already knew before the browser opened. On a
   * Dealer.com store that wasted load cost several seconds of the collection
   * budget for nothing.
   *
   * The homepage's only real job is tier 4 link discovery, which is a
   * fallback — and the primary nav it reads from is present on every page of
   * the site anyway, SRP included.
   *
   * So: the operator's stored path, then the platform's canonical path, and
   * the homepage only when we genuinely know nothing better.
   */
  function preferredLandingUrl(item, platform) {
    const home = item?.url || null;
    const path =
      item?.inventoryPath || (platform ? PLATFORM_INVENTORY_PATHS[platform] : null);
    if (path && home) return absoluteUrl(home, path) || home;
    return home;
  }

  /**
   * Open (or reuse) the dealer's collection session, landing directly on the
   * best inventory URL we can name up front rather than on the homepage.
   */
  async function openInventorySession({ item, platform, helpers }) {
    return helpers.ensureSiteSession(item, preferredLandingUrl(item, platform));
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
   * So this loop waits for the navigation to COMMIT, and nothing more.
   *
   * It deliberately does NOT wait for `tab.status === "complete"`. That status
   * tracks the window `load` event, which on a dealer SRP fires only after
   * every ad, pixel and chat widget has settled — measured at 12.3s on a
   * Dealer.com store whose markup was complete at 2.5s. Waiting for it cost
   * ~10s of dead time on each of the three navigations per make and was the
   * single largest consumer of the collection budget. `waitForTabComplete`
   * below already waits on `document.readyState`, which is the signal that
   * actually predicts whether the facets are readable.
   *
   * Commit is detected by the tab's URL, not by its status. Matching on
   * pathname alone would not be enough — each make pass navigates the same
   * `/new-inventory/index.htm` with different query params — but `tab.url`
   * carries the query string, so a full-URL comparison separates them.
   */
  async function goto(tabId, url, helpers, runtime) {
    runtime.throwIfCancelled();
    const target = safeUrl(url);
    const bare = (value) => (value ? value.href.split("#")[0] : null);
    const before = await currentUrl(tabId).catch(() => null);
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
      if (tab.status === "loading") sawLoading = true;

      const committed = safeUrl(tab.url);
      // The tab is showing something other than the page we started from, so
      // the navigation has committed — whether or not the site redirected us
      // somewhere other than the URL we asked for.
      const moved = Boolean(committed && before && committed.href !== before);
      // Re-navigating to the URL already displayed (a reload) never "moves",
      // so pair the exact match with having watched the load begin.
      const exact = Boolean(committed && target && bare(committed) === bare(target));
      if (moved || (exact && sawLoading)) break;

      // `before` is unknown when the pre-navigation tab refused script
      // injection (about:blank, an error page, a cross-origin interstitial).
      // Without it `moved` can never be true, so fall back to the status
      // signal rather than spinning here for the whole commit window.
      if (!before && sawLoading && tab.status === "complete") break;

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

  function describeObserved(observed) {
    if (!observed || typeof observed !== "object") return "no page state";
    return Object.entries(observed)
      .filter(([key]) => key !== "url")
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(" ");
  }

  // How long a freshly navigated page gets to render its facets before the
  // tier is written off. `goto` now returns at readyState "interactive"
  // rather than at the window load event, so the first sample can legitimately
  // land before a client-rendered facet rail exists.
  const READINESS_TIMEOUT_MS = 8_000;

  /**
   * Poll `inspect` until the page reports ready, and return the last state we
   * observed either way.
   *
   * A single immediate sample makes readiness a race against whatever the page
   * happened to have rendered in that instant. Polling turns "not ready yet"
   * into "not ready after N seconds", which is the question the tier actually
   * wants answered.
   */
  async function pollReadiness(tabId, inspect, runtime) {
    let last = null;
    const deadline = Date.now() + READINESS_TIMEOUT_MS;
    do {
      runtime.throwIfCancelled();
      last = await inspect(tabId);
      if (last?.ready) return last;
      await runtime.sleep(400);
    } while (Date.now() < deadline);
    return last;
  }

  /**
   * Walk the navigation tiers until `inspect(tabId)` reports a usable page.
   *
   * `inspect` returns a state object carrying `ready`, so the adapter
   * decides what "usable SRP" means for its platform. Every rejected tier is
   * recorded in `warnings` so a dealer that had to fall back is visible in the
   * stored result rather than silently slower.
   */
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

    // A cancelled run is not a tier that failed. Swallowing the abort here let
    // the resolver keep walking tiers after the collection budget had already
    // expired and the session window had been torn down, so the reported cause
    // became "no anchors matched an inventory URL pattern" (scanned against a
    // dead tab) instead of "we ran out of time on the first navigation".
    //
    // Cancellation is decided by asking the abort signal, never by matching the
    // error text. Legitimate per-tier failures carry timeout wording of their
    // own ("Timed out waiting for the dealer page to become interactive") and
    // must NOT abandon the remaining tiers.
    const rethrowIfCancelled = (error) => {
      const abort = (() => {
        try {
          runtime.throwIfCancelled();
          return null;
        } catch (cancellation) {
          return cancellation;
        }
      })();
      const fatal = abort ?? (error?.name === "AbortError" ? error : null);
      if (!fatal) return;
      // Keep the diagnostics we accumulated: knowing the clock ran out during
      // tier 3 is the whole story, and it is lost if the trace dies here.
      if (trace.length > 0) {
        warnings.push(...trace);
        fatal.navigationTrace = trace;
      }
      throw fatal;
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
        rethrowIfCancelled(error);
        record(
          label,
          url,
          `navigation failed: ${error instanceof Error ? error.message : String(error)}`
        );
        return null;
      }
      let result;
      try {
        result = await pollReadiness(tabId, inspect, runtime);
      } catch (error) {
        rethrowIfCancelled(error);
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

    // Tier 1 — the page the session already opened. `openInventorySession`
    // lands directly on the best inventory URL we could name, so in the normal
    // case this tier IS the whole navigation and nothing below ever runs.
    runtime.throwIfCancelled();
    const here = await currentUrl(tabId).catch(() => null);
    // Give a real SRP the same readiness poll a navigated-to candidate gets;
    // a homepage landing (unknown platform, no stored path) is checked once
    // and abandoned, since polling it for seconds only delays the fallback.
    const landedOnCandidate = looksLikeInventoryUrl(here);
    let landed = null;
    try {
      landed = landedOnCandidate
        ? await pollReadiness(tabId, inspect, runtime)
        : await inspect(tabId);
    } catch (error) {
      rethrowIfCancelled(error);
      record("Landing page", null, `page inspection failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (landed?.ready) return landed;
    if (landed) record("Landing page", landed.url, "not a usable inventory page", landed);

    // Resolve the stored and default paths against the site ROOT, not against
    // whatever page we are sitting on. Now that the session opens on the SRP,
    // using the current page as the base would append a relative stored path
    // to it ("new-inventory/" -> "/new-inventory/new-inventory/"). The origin
    // is taken from the live URL so a www/https redirect is still honoured.
    const base = (() => {
      const origin = safeUrl(here)?.origin || safeUrl(item.url)?.origin;
      return origin ? `${origin}/` : item.url;
    })();

    // The landing URL has now been tried and rejected. Record it so the tiers
    // below do not reload the identical page they just watched fail — with the
    // session opening on the platform default path, tier 3 would otherwise be
    // a guaranteed repeat of tier 1.
    for (const tried of [here, preferredLandingUrl(item, platform)]) {
      if (tried && !attempted.includes(tried)) attempted.push(tried);
    }

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

    // Tier 4 — discover a link from the dealer's own markup.
    //
    // This is the one and only reason collection ever loads the homepage, and
    // it only happens once every named URL above has already failed. The nav
    // we scan is on every page of the site, so this load is not strictly
    // required — but by this point the tab is sitting on whatever a failed
    // tier left on screen (often a 404 or a redirect target with a stripped
    // nav), and the homepage is the one page guaranteed to carry the full
    // primary menu.
    try {
      await goto(tabId, item.url, helpers, runtime);
    } catch (error) {
      rethrowIfCancelled(error);
      // Discovery below still works against whatever page is loaded.
    }
    const discovered = await discoverInventoryHref(tabId).catch((error) => {
      rethrowIfCancelled(error);
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
    looksLikeInventoryUrl,
    openInventorySession,
    preferredLandingUrl,
    resolveInventoryPage,
    withParams,
  };
})();
