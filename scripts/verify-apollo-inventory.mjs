/**
 * Apollo (Team Velocity) inventory adapter check.
 *
 * Apollo's SRP publishes `accountId`, `campaignId` and `selectedFilters` as
 * page-level script variables. The adapter used to treat `selectedFilters` as
 * mandatory, so when Apollo stopped emitting a parseable one, every Apollo
 * dealer failed navigation with a perfectly usable `accountId` on the page.
 * The endpoint only needs the account, so that is what is asserted here.
 *
 * Run: node scripts/verify-apollo-inventory.mjs
 */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const read = (name) =>
  readFileSync(new URL(`../extension/inventory/${name}`, import.meta.url), "utf8");

const page = (vars) => `<html><head>
<script src="https://cdn.tvmwebsitecdn.com/app.js"></script>
${vars}
</head><body></body></html>`;

const ON_LOT = {
  filters: {
    makes: [
      { text: "All", count: 12 },
      { text: "Toyota", count: 12 },
    ],
    models: [
      { make: null, text: "All", count: 12 },
      { make: "Toyota", text: "RAV4", count: 7 },
      { make: "Toyota", text: "Camry", count: 5 },
      { make: "Honda", text: "Civic", count: 3 },
    ],
  },
};

// Prius is in transit and nothing else — the case that disappears from the
// breakdown entirely when the transit call is lost.
const IN_TRANSIT = {
  filters: {
    makes: [{ text: "Toyota", count: 6 }],
    models: [
      { make: "Toyota", text: "RAV4", count: 4 },
      { make: "Toyota", text: "Prius", count: 2 },
    ],
  },
};

/** Load the adapter against a stubbed page and a stubbed filter endpoint. */
async function collect(html, { failTransitOnce = false } = {}) {
  const requested = [];
  let transitFailuresLeft = failTransitOnce ? 1 : 0;
  const document = {
    documentElement: { outerHTML: html },
    querySelector: () => null,
  };
  const location = { href: "https://example.com/inventory/new" };

  globalThis.document = document;
  globalThis.location = location;
  globalThis.fetch = async (url) => {
    requested.push(url);
    if (/InTransit=true/.test(url) && transitFailuresLeft > 0) {
      transitFailuresLeft -= 1;
      // What a thrown fetch looks like: the adapter reports it as HTTP 0.
      throw new TypeError("Failed to fetch");
    }
    const transit = /InTransit=true/.test(url);
    return { ok: true, status: 200, json: async () => (transit ? IN_TRANSIT : ON_LOT) };
  };

  globalThis.inventoryNavigate = {
    // The adapter's in-page functions are plain functions here rather than
    // serialized into a tab.
    execute: async (tabId, func, args = []) => func(...args),
    openInventorySession: async () => ({ tabId: 1 }),
    resolveInventoryPage: async ({ tabId, inspect }) => {
      const state = await inspect(tabId);
      if (!state?.ready) throw new Error(`page not usable: ${JSON.stringify(state)}`);
      return state;
    },
  };

  globalThis.inventoryPlatformAdapters = [];
  eval(read("tally.js"));
  eval(read("adapters/apollo.js"));
  const adapter = globalThis.inventoryPlatformAdapters.find((one) => one.id === "apollo");

  const result = await adapter.collect({
    item: { siteName: "Test Apollo", url: "https://example.com", makeAllowList: ["Toyota"] },
    helpers: {},
    runtime: { throwIfCancelled: () => {}, sleep: async () => {} },
  });
  return { result, requested };
}

// A page with no `selectedFilters` at all still collects: `accountId` is
// enough, and every other query field has a default.
{
  const { result, requested } = await collect(
    page(`<script>var accountId = '44811';\nvar campaignId = '2655';</script>`)
  );
  assert.equal(result.totals.inStock, 12);
  assert.equal(result.totals.inTransit, 6);
  assert.match(requested[0], /AccountID=44811/);
  assert.match(requested[0], /CampaignId=2655/);

  // On-lot and in-transit are tracked per model, not merged into one number,
  // and a model that is entirely in transit still gets a row.
  const byModel = Object.fromEntries(result.models.map((row) => [row.model, row]));
  assert.deepEqual(Object.keys(byModel).sort(), ["Camry", "Prius", "RAV4"]);
  assert.deepEqual(
    { inStock: byModel.RAV4.inStock, inTransit: byModel.RAV4.inTransit },
    { inStock: 7, inTransit: 4 }
  );
  assert.deepEqual(
    { inStock: byModel.Prius.inStock, inTransit: byModel.Prius.inTransit },
    { inStock: 0, inTransit: 2 }
  );
  assert.deepEqual(
    { inStock: byModel.Camry.inStock, inTransit: byModel.Camry.inTransit },
    { inStock: 5, inTransit: 0 }
  );
}

// A thrown in-transit fetch is retried once. Without the retry the whole
// transit column — and the transit-only Prius row — is lost to one blip.
{
  const { result, requested } = await collect(
    page(`<script>var accountId = '44811';\nvar campaignId = '2655';</script>`),
    { failTransitOnce: true }
  );
  assert.equal(requested.filter((url) => /InTransit=true/.test(url)).length, 2);
  assert.equal(result.totals.inTransit, 6);
  assert.ok(result.models.some((row) => row.model === "Prius"));
  assert.ok(!result.warnings.some((line) => /in-transit query failed/.test(line)));
}

// When the page does publish `selectedFilters`, its values are used. Apollo
// HTML-escapes the quotes inside the payload, which is what keeps the
// enclosing single-quoted string readable.
{
  const filters = JSON.stringify({
    AccountID: "99999",
    Type: "New",
    PaymentType: "finance",
    CampaignId: "1424",
    Makes: "Toyota",
  }).replace(/"/g, "&quot;");
  const { requested } = await collect(
    page(`<script>var accountId = '44811';\nvar selectedFilters = '${filters}';</script>`)
  );
  assert.match(requested[0], /AccountID=99999/);
  assert.match(requested[0], /PaymentType=finance/);
  assert.match(requested[0], /Makes=Toyota/);
}

// Assignments sharing one line stay separate. A greedy match ran `accountId`
// through to the last quote on the line and sent a junk AccountID.
{
  const { requested } = await collect(
    page(`<script>var accountId = '44811'; var campaignId = '2655';</script>`)
  );
  assert.match(requested[0], /AccountID=44811&/);
  assert.match(requested[0], /CampaignId=2655&/);
}

// A page carrying neither is still rejected rather than queried blind.
{
  await assert.rejects(() => collect(page("")), /page not usable/);
}

console.log("apollo inventory adapter: ok");
