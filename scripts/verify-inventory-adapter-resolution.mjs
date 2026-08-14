/**
 * Adapter routing check for the extension's inventory collector.
 *
 * The collector picks a platform adapter from the stored `sites.platform` and
 * from a sniff of the live page. Getting that precedence wrong is invisible
 * until a dealer collects against the wrong platform, so it is checked here
 * with stubbed navigation instead of a browser.
 *
 * Run: node scripts/verify-inventory-adapter-resolution.mjs
 */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const source = readFileSync(new URL("../extension/inventory.js", import.meta.url), "utf8");

function loadCollector(detected) {
  const ran = [];
  const landedOn = [];

  globalThis.inventoryPlatformAdapters = [
    ["dealer-inspire", ["dealer_inspire", "dealer-inspire", "lightningvrp"]],
    ["dealer-on", ["dealer_on", "dealer-on", "dealeron"]],
  ].map(([id, platforms]) => ({
    id,
    platforms,
    collect: async () => {
      ran.push(id);
      return { warnings: [] };
    },
  }));

  globalThis.inventoryNavigate = {
    openInventorySession: async ({ platform }) => {
      landedOn.push(platform);
      return { tabId: 1 };
    },
    // Stands in for the in-page sniff: whatever the page would report.
    execute: async () => detected,
  };

  globalThis.inventoryShared = {
    collectionBudgetMs: () => 1_000,
    withTimeout: (run) => run(new AbortController().signal),
    createRuntime: () => ({}),
  };

  // The file is an IIFE that publishes onto globalThis.
  eval(source);
  return { ran, landedOn, collect: globalThis.inventoryCollector.collectInventory };
}

async function run(storedPlatform, detected) {
  const loaded = loadCollector(detected);
  const result = await loaded.collect(
    { siteId: "s1", siteName: "Test Dealer", url: "https://example.com", platform: storedPlatform },
    {}
  );
  return { ...loaded, warnings: result.warnings };
}

// A wrong stored platform loses to a confident page reading. This is the
// Speedcraft Nissan case: stored dealer_inspire, actually a DealerOn store.
{
  const { ran, warnings } = await run("dealer_inspire", "dealer_on");
  assert.deepEqual(ran, ["dealer-on"]);
  assert.match(warnings.join(" "), /reads as dealer_on/);
}

// No confident reading (404, challenge page): the operator's value stands and
// nothing is warned about.
{
  const { ran, warnings } = await run("dealer_inspire", "unknown");
  assert.deepEqual(ran, ["dealer-inspire"]);
  assert.deepEqual(warnings, []);
}

// Agreement is silent.
{
  const { ran, warnings } = await run("dealer_inspire", "dealer_inspire");
  assert.deepEqual(ran, ["dealer-inspire"]);
  assert.deepEqual(warnings, []);
}

// Blank stored platform is still resolved from the page.
{
  const { ran } = await run("", "dealer_on");
  assert.deepEqual(ran, ["dealer-on"]);
}

// The landing URL is chosen from the adapter's canonical key, not from the
// alias the operator typed — PLATFORM_INVENTORY_PATHS has no "lightningvrp".
{
  const { landedOn } = await run("lightningvrp", "unknown");
  assert.equal(landedOn[0], "dealer_inspire");
}

// An unroutable page with an unroutable stored value still fails loudly.
await assert.rejects(() => run("wixsite", "unknown"), /has no adapter for wixsite/);

console.log("inventory adapter resolution: ok");
