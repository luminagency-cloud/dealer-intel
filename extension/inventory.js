/* global inventoryNavigate, inventoryShared */

(() => {
  function normalizePlatform(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "");
  }

  function adapterFor(platform) {
    const normalized = normalizePlatform(platform);
    if (!normalized) return null;
    return (
      (globalThis.inventoryPlatformAdapters || []).find((adapter) =>
        adapter.platforms.some(
          (candidate) => normalizePlatform(candidate) === normalized
        )
      ) ?? null
    );
  }

  /**
   * Sniff the platform from the live page.
   *
   * `sites.platform` is free text typed by an operator, so a stale or
   * differently-spelled value ("Dealer.com (DDC)") used to hard-fail the whole
   * dealer before the browser had even looked at the site. We are already
   * sitting on the page, so read it. Order matters: DealerOn sites carry
   * incidental third-party references that a loose Dealer Inspire test matches
   * first, so DealerOn is ruled out before Dealer Inspire.
   */
  async function detectPlatform(tabId) {
    return inventoryNavigate.execute(tabId, () => {
      const provider = document
        .querySelector('meta[name="providerID" i]')
        ?.getAttribute("content");
      if (/^ddc$/i.test(provider || "") || globalThis.DDC) return "ddc";
      if (document.querySelector("[data-widget-name^='ws-inv'], [data-facet-group]")) {
        return "ddc";
      }
      const html = document.documentElement?.outerHTML?.slice(0, 400_000) || "";
      if (/dealeron/i.test(html) || /searchnew\.aspx/i.test(html)) return "dealer_on";
      if (
        globalThis.LightningVRP ||
        globalThis.algoliaConfig ||
        document.querySelector("#lvrp-filters-column, [data-facettype]") ||
        /dealerinspire/i.test(html)
      ) {
        return "dealer_inspire";
      }
      if (/teamvelocitymarketing|secureoffersites\.com|tvmwebsitecdn\.com/i.test(html)) {
        return "apollo";
      }
      if (/dealer alchemist|dealeralchemist|dealervenom|app\/themes\/dv-framework/i.test(html)) {
        return "dealer_alchemist";
      }
      if (
        /dealermasters|dealer-masters/i.test(html) ||
        document.querySelector("label.options-list-v2__item")
      ) {
        return "dealer_masters";
      }
      // Deliberately not keyed on the DataDome interstitial. Sokal sits behind
      // it, but so do sites on other platforms, and a challenge page carries
      // none of its host platform's markers — matching it here would route
      // every challenged dealer to the Sokal adapter.
      if (/sokal/i.test(html)) return "sokal";
      return "unknown";
    });
  }

  /**
   * Pick the adapter, and always ask the live page rather than trusting
   * `sites.platform` on its own.
   *
   * The stored value used to win outright whenever it named a registered
   * adapter, so a wrong-but-spellable entry was never questioned: Speedcraft
   * Nissan is stored as `dealer_inspire` and is really a DealerOn store, and
   * the Dealer Inspire reader found no `[data-facet]` rows on a page that has
   * none, reporting the SRP as unreachable.
   *
   * The sniff is one `executeScript` against a session that has to be opened
   * anyway, so it is close to free — and it is the only check that catches a
   * misroute which does NOT fail loudly. An adapter aimed at the wrong
   * platform can find something and report plausible-but-wrong counts, which a
   * retry-after-failure scheme would never look at.
   *
   * The stored value still decides where we LAND (its inventory path, or the
   * operator's), because facet markup is one of the strongest platform signals
   * and it lives on the SRP. It also still wins whenever the page gives no
   * confident answer — a 404 or a challenge page sniffs as "unknown", and
   * nothing has been learned that beats what the operator typed.
   */
  async function resolveAdapter(item, helpers) {
    const configured = adapterFor(item?.platform);

    const { tabId } = await inventoryNavigate.openInventorySession({
      item,
      // `platforms[0]` is each adapter's canonical key, which is what
      // PLATFORM_INVENTORY_PATHS is keyed by. `item.platform` itself may be an
      // alias ("dealer.com", "lightningvrp") that has no path entry.
      platform: configured?.platforms[0] ?? null,
      helpers,
    });
    const detected = await detectPlatform(tabId).catch(() => "unknown");
    const sniffed = adapterFor(detected);
    if (sniffed && sniffed !== configured) return { adapter: sniffed, detected };
    if (configured) return { adapter: configured, detected: null };

    throw new Error(
      `Visible inventory collection has no adapter for ${
        item?.platform || "unknown platform"
      }${
        detected && detected !== "unknown" ? ` (page looks like ${detected})` : ""
      }. Registered platforms: ${[
        ...new Set(
          (globalThis.inventoryPlatformAdapters || []).map((adapter) => adapter.id)
        ),
      ].join(", ")}.`
    );
  }

  async function collectInventory(item, helpers) {
    const { adapter, detected } = await resolveAdapter(item, helpers);

    const timeoutMs = inventoryShared.collectionBudgetMs(item.makeAllowList?.length);

    const result = await inventoryShared.withTimeout(
      (signal) =>
        adapter.collect({
          item,
          helpers,
          runtime: inventoryShared.createRuntime({ helpers, signal }),
        }),
      {
        timeoutMs,
        signal: helpers.signal,
        message: `${item.siteName}: ${adapter.id} inventory collection timed out`,
      }
    );

    if (detected && result && Array.isArray(result.warnings)) {
      result.warnings.push(
        `Stored platform "${item.platform ?? "(blank)"}" was not used; the live page reads as ${detected}, so the ${adapter.id} adapter ran. Fix the dealer record.`
      );
    }
    return result;
  }

  globalThis.inventoryCollector = {
    collectInventory,
    detectPlatform,
    supportedPlatforms: (globalThis.inventoryPlatformAdapters || []).flatMap(
      (adapter) => adapter.platforms
    ),
  };
})();
