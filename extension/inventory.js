/* global inventoryShared */

(() => {
  function normalizePlatform(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "");
  }

  function adapterFor(item) {
    const platform = normalizePlatform(item?.platform);
    return (globalThis.inventoryPlatformAdapters || []).find((adapter) =>
      adapter.platforms.some(
        (candidate) => normalizePlatform(candidate) === platform
      )
    );
  }

  async function collectInventory(item, helpers) {
    const adapter = adapterFor(item);
    if (!adapter) {
      throw new Error(
        `Visible inventory collection has no adapter for ${item?.platform || "unknown platform"}. This pass supports Dealer.com and Dealer Inspire.`
      );
    }

    const timeoutMs = Math.max(1, item.makeAllowList?.length || 1) * 60_000;
    return inventoryShared.withTimeout(
      (signal) =>
        adapter.collect({
          item,
          helpers,
          runtime: inventoryShared.createRuntime({
            helpers,
            signal,
          }),
        }),
      {
        timeoutMs,
        signal: helpers.signal,
        message: `${item.siteName}: ${adapter.id} inventory collection timed out`,
      }
    );
  }

  globalThis.inventoryCollector = {
    collectInventory,
    supportedPlatforms: (globalThis.inventoryPlatformAdapters || []).flatMap(
      (adapter) => adapter.platforms
    ),
  };
})();
