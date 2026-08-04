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
      return "unknown";
    });
  }

  async function resolveAdapter(item, helpers) {
    const configured = adapterFor(item?.platform);
    if (configured) return { adapter: configured, detected: null };

    // Nothing matched the stored value — open the site and look.
    const { tabId } = await helpers.ensureSiteSession(item);
    const detected = await detectPlatform(tabId).catch(() => "unknown");
    const sniffed = adapterFor(detected);
    if (sniffed) return { adapter: sniffed, detected };

    throw new Error(
      `Visible inventory collection has no adapter for ${
        item?.platform || "unknown platform"
      }${
        detected && detected !== "unknown" ? ` (page looks like ${detected})` : ""
      }. This pass supports Dealer.com and Dealer Inspire.`
    );
  }

  async function collectInventory(item, helpers) {
    const { adapter, detected } = await resolveAdapter(item, helpers);

    // URL-driven collection is roughly two page loads per make rather than a
    // click sequence per facet, so the budget no longer has to cover a chain
    // of settle waits. It still scales with make count.
    const makePasses = Math.max(1, item.makeAllowList?.length || 1);
    const timeoutMs = 30_000 + makePasses * 30_000;

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
        `Stored platform "${item.platform ?? "(blank)"}" did not match an adapter; used ${detected} detected from the live page.`
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
