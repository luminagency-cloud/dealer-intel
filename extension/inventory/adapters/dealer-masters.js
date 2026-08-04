/* global inventoryNavigate, inventoryTally */

/**
 * Dealer Masters inventory from the site's own build data.
 *
 * These stores are Gatsby sites that ship their entire inventory to the
 * browser once and filter it client-side. Nothing is fetched when a shopper
 * ticks a facet, and the facet checkboxes carry no value, name, or URL
 * contract — the status filter writes `?status=Stock` into the address bar
 * but a cold load of that URL does not rehydrate it. So there is no
 * navigation-driven filter path to use here.
 *
 * What there is, is better: `/page-data/<route>/page-data.json` contains
 * `allInventoryJson.nodes`, one node per vehicle, each carrying `IsNew`,
 * `Make`, `Model`, and `VehicleStatus`. That is vehicle-level truth from the
 * dealer's own build, and on a live Kia store it reconciled exactly to both
 * the "122 vehicles found" line and the store's own make facet.
 *
 * The rendered model facet does NOT reconcile — the same store's model labels
 * summed to 140 against that 122 — so the DOM is only a last resort, and it
 * says so in the stored warnings when it is used.
 */
(() => {
  // Vehicles the dealer's build marks as not for display. The site's own
  // result count excludes them, so counting them would overstate the store.
  const HIDDEN_STATUS_PREFIX = "_";

  const execute = (tabId, func, args) => inventoryNavigate.execute(tabId, func, args);

  // -------------------------------------------------------------------------
  // Page shape
  // -------------------------------------------------------------------------

  async function inventoryPageState(tabId) {
    return execute(tabId, () => {
      const options = document.querySelectorAll("label.options-list-v2__item");
      const modelOptions = document.querySelectorAll(
        'label.options-list-v2__item[class*="model-"]'
      ).length;
      return {
        url: location.href,
        options: options.length,
        modelOptions,
        total: (() => {
          const match = (document.body?.innerText || "").match(
            /([\d,]+)\s+vehicles?\s+found/i
          );
          if (!match) return null;
          const parsed = Number(match[1].replace(/,/g, ""));
          return Number.isFinite(parsed) ? parsed : null;
        })(),
        hasControls: modelOptions > 0,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Build data
  // -------------------------------------------------------------------------

  /**
   * Fetch the Gatsby page data behind the current route and fold it into
   * make/model/status rows.
   *
   * The payload is several megabytes, so the reduction happens inside the page
   * — only the counted rows cross the `executeScript` boundary.
   */
  async function readBuildInventory(tabId, hiddenPrefix) {
    return execute(
      tabId,
      async (hidden) => {
        const route = location.pathname.replace(/\/+$/, "");
        const candidates = [
          `/page-data${route || "/index"}/page-data.json`,
          `/page-data${route}/index/page-data.json`,
        ];

        for (const candidate of candidates) {
          let payload;
          try {
            const response = await fetch(candidate, { credentials: "same-origin" });
            if (!response.ok) continue;
            payload = await response.json();
          } catch {
            continue;
          }

          const nodes = payload?.result?.data?.allInventoryJson?.nodes;
          if (!Array.isArray(nodes) || nodes.length === 0) continue;

          const rows = new Map();
          let hiddenCount = 0;
          let usedCount = 0;
          for (const node of nodes) {
            const info = node?.VehicleInfo;
            if (!info) continue;
            if (!info.IsNew) {
              usedCount += 1;
              continue;
            }
            const status = String(info.VehicleStatus ?? "").trim();
            if (status.startsWith(hidden)) {
              hiddenCount += 1;
              continue;
            }
            const make = String(info.Make ?? "").trim();
            const model = String(info.Model ?? "").trim();
            if (!make || !model) continue;
            const inTransit = /transit|incoming|inbound/i.test(status);
            const key = `${make}\u0000${model}`;
            const row = rows.get(key) ?? { make, model, inStock: 0, inTransit: 0 };
            if (inTransit) row.inTransit += 1;
            else row.inStock += 1;
            rows.set(key, row);
          }

          if (rows.size === 0) continue;
          return {
            ok: true,
            sourceUrl: new URL(candidate, location.href).toString(),
            rows: [...rows.values()],
            hiddenCount,
            usedCount,
            nodeCount: nodes.length,
            // Only claim a transit split when the build actually distinguishes
            // one; otherwise every vehicle would silently read as on-lot.
            transitKnown: [...rows.values()].some((row) => row.inTransit > 0),
          };
        }

        return { ok: false, tried: candidates };
      },
      [hiddenPrefix]
    );
  }

  /**
   * Last resort: the rendered facet labels ("Sportage 27").
   *
   * Known to disagree with the store's own total on at least one live site, so
   * anything read this way is reported with a warning attached.
   */
  async function readFacetModels(tabId) {
    return execute(tabId, () => {
      const clean = (value) =>
        String(value || "")
          .replace(/\s+/g, " ")
          .trim();
      const parse = (selector) =>
        Array.from(document.querySelectorAll(selector))
          .map((label) => {
            const text = clean(label.textContent);
            // Makes render as "Kia (122)", models as "Sportage 27".
            const match = text.match(/^(.*?)\s*\(?([\d,]+)\)?$/);
            if (!match) return null;
            const count = Number(match[2].replace(/,/g, ""));
            const name = clean(match[1]);
            if (!name || !Number.isFinite(count)) return null;
            return { name, count };
          })
          .filter(Boolean);

      return {
        makes: parse('label.options-list-v2__item[class*="make-"]'),
        models: parse('label.options-list-v2__item[class*="model-"]'),
      };
    });
  }

  // -------------------------------------------------------------------------
  // Collection
  // -------------------------------------------------------------------------

  async function collect({ item, helpers, runtime }) {
    const warnings = [];
    const { tabId } = await inventoryNavigate.openInventorySession({
      item,
      platform: "dealer_masters",
      helpers,
    });

    const landing = await inventoryNavigate.resolveInventoryPage({
      tabId,
      item,
      platform: "dealer_masters",
      helpers,
      runtime,
      warnings,
      inspect: async (id) => {
        const candidate = await inventoryPageState(id);
        return { ...candidate, ready: candidate.hasControls };
      },
    });

    const srpUrl = landing.url;
    const makes = [...new Set((item.makeAllowList || []).filter(Boolean))];
    if (makes.length === 0) {
      throw new Error("Dealer Masters collection requires a configured make allow-list");
    }

    runtime.throwIfCancelled();
    const build = await readBuildInventory(tabId, HIDDEN_STATUS_PREFIX).catch(() => null);

    let tally;
    let sourceUrl = srpUrl;

    if (build?.ok) {
      sourceUrl = build.sourceUrl;
      // One node per vehicle in the dealer's own build, so an absent
      // configured make is confirmed absent.
      tally = inventoryTally.createInventoryTally({
        makeAllowList: makes,
        transitKnown: build.transitKnown,
        enumerated: true,
      });
      for (const row of build.rows) {
        tally.addModelCount(row.make, row.model, {
          inStock: row.inStock,
          inTransit: row.inTransit,
        });
      }
      if (!build.transitKnown) {
        warnings.push(
          "Dealer Masters build data listed no in-transit vehicles; transit left unresolved."
        );
      }
    } else {
      warnings.push(
        "Dealer Masters build data was unavailable; fell back to the rendered model facet, whose counts are known to disagree with the store's own total."
      );
      const facets = await readFacetModels(tabId);
      if (makes.length > 1) {
        warnings.push(
          `The facet fallback cannot attribute models to a make; all rows were recorded under ${makes[0]}.`
        );
      }
      tally = inventoryTally.createInventoryTally({
        makeAllowList: makes,
        transitKnown: false,
      });
      for (const row of facets.models) {
        tally.addModelCount(makes[0], row.name, { inStock: row.count });
      }
    }

    const counted = tally.result();
    // The facet fallback below is NOT enumerated, so it keeps warning; the
    // build-data path does not, for the reason given in the DealerOn adapter.
    if (!build?.ok) {
      for (const make of counted.missingMakes) {
        warnings.push(`${make}: no Dealer Masters model rows resolved; recorded as zero.`);
      }
    }
    if (counted.ignoredMakes.length > 0) {
      warnings.push(
        `Dealer Masters also listed ${counted.ignoredMakes
          .map((row) => `${row.make} (${row.count})`)
          .join(", ")}, which the dealer is not configured for; excluded.`
      );
    }
    if (
      landing.total !== null &&
      counted.ignoredMakes.length === 0 &&
      Math.abs(landing.total - counted.totals.inStock) > 2
    ) {
      warnings.push(
        `Dealer Masters showed ${landing.total} vehicles against a reconciled on-lot total of ${counted.totals.inStock}.`
      );
    }

    if (counted.models.length === 0) {
      throw new Error("Dealer Masters collection produced no model rows for the configured makes");
    }
    if (counted.totals.inStock <= 0) {
      throw new Error("Dealer Masters reconciled on-lot total was zero");
    }

    return {
      sourceUrl,
      detectedPlatform: "dealer_masters",
      totals: counted.totals,
      makeSubtotals: counted.makeSubtotals,
      models: counted.models,
      warnings,
    };
  }

  globalThis.inventoryPlatformAdapters ||= [];
  globalThis.inventoryPlatformAdapters.push({
    id: "dealer-masters",
    platforms: ["dealer_masters", "dealer-masters", "dealermasters"],
    collect,
  });
})();
