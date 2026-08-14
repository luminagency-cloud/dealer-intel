/* global inventoryNavigate, inventoryTally */

/**
 * Dealer Alchemist inventory via public SRP refinement URLs.
 *
 * The SRP is an InstantSearch UI whose refinements are mirrored into the query
 * string (`?make=Toyota&status=In%20Stock`), and those URLs rehydrate on a
 * cold load — so filtering is navigation, exactly as it is for Dealer.com and
 * Dealer Inspire. `In Stock`, `In Transit`, and `In Production` are the
 * platform's own status values; in-production units are deliberately excluded
 * because they are not yet inventory.
 *
 * The model facet (`#modelCategory-list`) is hierarchical: a parent row per
 * model family and a child row per model, and the SAME model can appear under
 * more than one parent ("Corolla Cross" is both its own family and a child of
 * "Corolla"). Parent counts therefore overstate the store — summing them on a
 * live Toyota SRP gave 286 against an advertised 270. The child rows, deduped
 * by name, reconciled to 270 exactly, so children are what this adapter reads.
 */
(() => {
  const STATUS_IN_STOCK = "In Stock";
  const STATUS_IN_TRANSIT = "In Transit";
  const MODEL_LIST_ID = "modelCategory-list";
  const MAKE_LIST_ID = "make-list";
  const STATUS_LIST_ID = "status-list";

  const execute = (tabId, func, args) => inventoryNavigate.execute(tabId, func, args);

  // -------------------------------------------------------------------------
  // Page shape
  // -------------------------------------------------------------------------

  /**
   * One injected pass reads everything this adapter needs from a loaded SRP:
   * the refinement lists, the advertised result total, and whether the page
   * still looks like a Dealer Alchemist search.
   */
  async function readSearchState(tabId) {
    return execute(
      tabId,
      (modelListId, makeListId, statusListId) => {
        const clean = (value) =>
          String(value || "")
            .replace(/\s+/g, " ")
            .trim();

        const readList = (id) =>
          Array.from(
            document.querySelectorAll(`#${id} .ais-RefinementList-item`)
          ).map((row) => {
            const className = row.className || "";
            const input = row.querySelector("input");
            const countText = clean(row.querySelector(".ais-RefinementList-count")?.textContent);
            const count = Number(countText.replace(/[^\d]/g, ""));
            return {
              name: clean(
                row.querySelector(".ais-RefinementList-labelText")?.textContent ||
                  input?.value
              ),
              value: clean(input?.value),
              count: Number.isFinite(count) ? count : null,
              // Presence in the DOM, not geometry: a backgrounded tab has no
              // computed layout, so anything keyed on rects reads as hidden.
              checked: Boolean(input && input.checked),
              tier: /da-TierRefinementList-parent/.test(className)
                ? "parent"
                : /da-TierRefinementList-child/.test(className)
                  ? "child"
                  : null,
            };
          });

        const bodyText = document.body?.innerText || "";
        const totalMatch =
          bodyText.match(/showing\s+[\d,]+\s*[-–]\s*[\d,]+\s+of\s+([\d,]+)\s+results?/i) ||
          bodyText.match(/([\d,]+)\s+results?\s+found/i);
        const parsedTotal = totalMatch ? Number(totalMatch[1].replace(/,/g, "")) : null;

        const makes = readList(makeListId);
        const models = readList(modelListId);
        const statuses = readList(statusListId);

        return {
          url: location.href,
          makes,
          models,
          statuses,
          total: Number.isFinite(parsedTotal) ? parsedTotal : null,
          isDealerAlchemist: /dealer alchemist|dealeralchemist|dealervenom|app\/themes\/dv-framework/i.test(
            document.documentElement?.outerHTML?.slice(0, 400_000) || ""
          ),
          // The model list is the thing collection depends on; a page without
          // it is not a usable SRP no matter what else it renders.
          hasControls: models.length > 0,
        };
      },
      [MODEL_LIST_ID, MAKE_LIST_ID, STATUS_LIST_ID]
    );
  }

  /**
   * InstantSearch repaints its facets after the results settle, so a state
   * read immediately after navigation can catch an empty or stale list.
   */
  async function readSettledSearchState(tabId, runtime, timeoutMs = 15_000) {
    const settled = await runtime
      .waitFor(
        async () => {
          const state = await readSearchState(tabId);
          return state?.models?.length > 0 ? state : null;
        },
        {
          timeoutMs,
          intervalMs: 300,
          message: "Dealer Alchemist model refinements did not render",
        }
      )
      .catch(() => null);
    return settled ?? readSearchState(tabId);
  }

  /**
   * Child rows deduped by model name.
   *
   * A model reachable through two parents is listed twice with the same count,
   * so the maximum is the model's real figure and summing the raw rows is not.
   */
  function modelRowsFrom(state) {
    const children = state.models.filter((row) => row.tier === "child");
    const source = children.length > 0 ? children : state.models;
    const byName = new Map();
    for (const row of source) {
      if (!row.name || !Number.isFinite(row.count)) continue;
      if (!inventoryTally.plausibleModelName(row.name)) continue;
      const key = inventoryTally.normalizeKey(row.name);
      const previous = byName.get(key);
      if (!previous || row.count > previous.count) {
        byName.set(key, { name: row.name, count: row.count });
      }
    }
    return [...byName.values()];
  }

  function statusRow(state, wanted) {
    return (
      state.statuses.find(
        (row) => inventoryTally.normalizeKey(row.name) === inventoryTally.normalizeKey(wanted)
      ) ?? null
    );
  }

  // -------------------------------------------------------------------------
  // Collection
  // -------------------------------------------------------------------------

  async function collect({ item, helpers, runtime }) {
    const warnings = [];
    const { tabId } = await inventoryNavigate.openInventorySession({
      item,
      platform: "dealer_alchemist",
      helpers,
    });

    const landing = await inventoryNavigate.resolveInventoryPage({
      tabId,
      item,
      platform: "dealer_alchemist",
      helpers,
      runtime,
      warnings,
      // Single-shot on purpose: `resolveInventoryPage` polls `inspect` itself,
      // and nesting this adapter's own settle loop inside that poll would
      // multiply the two waits together on every tier it rejects.
      inspect: async (id) => {
        const candidate = await readSearchState(id);
        return { ...candidate, ready: candidate.hasControls };
      },
    });

    const srpUrl = landing.url;
    const makes = [...new Set((item.makeAllowList || []).filter(Boolean))];
    if (makes.length === 0) {
      throw new Error("Dealer Alchemist collection requires a configured make allow-list");
    }

    const availableMakes = landing.makes;
    const transitKnown =
      Boolean(statusRow(landing, STATUS_IN_STOCK)) && Boolean(statusRow(landing, STATUS_IN_TRANSIT));
    if (!transitKnown) {
      warnings.push(
        "Dealer Alchemist exposed no in-stock/in-transit status refinement; transit left unresolved."
      );
    }

    const tally = inventoryTally.createInventoryTally({
      makeAllowList: makes,
      transitKnown,
    });

    /**
     * Navigate to one make/status combination and return its model rows.
     *
     * Returns null when the page did not actually apply the refinement, so the
     * caller records zero with a warning rather than banking counts that are
     * really the unfiltered store.
     */
    const readCombination = async (make, status) => {
      await inventoryNavigate.goto(
        tabId,
        inventoryNavigate.withParams(srpUrl, { make, status: status ?? null }),
        helpers,
        runtime
      );
      const state = await readSettledSearchState(tabId, runtime);

      // Same guard every facet-walking adapter uses: a checked make in the
      // markup, or model counts small enough to be this make alone. The store
      // facet read before any refinement is what they are held against.
      const models = modelRowsFrom(state);
      const scope = inventoryTally.checkMakeScope({
        make,
        modelTotal: models.reduce((sum, row) => sum + row.count, 0),
        storeMakes: availableMakes,
        selectedMakes: state.makes.filter((row) => row.checked).map((row) => row.name),
      });
      if (!scope.scoped) return { applied: false, reason: scope.reason };

      // The status refinement's own checkbox does not reliably render as
      // checked after a cold load, but status facets are disjunctive: their
      // counts ignore the status refinement itself. So the result total
      // landing exactly on the requested status's count is proof it applied,
      // and it is proof the unfiltered set was NOT what we just read.
      if (status) {
        const row = statusRow(state, status);
        if (row && Number.isFinite(row.count) && state.total !== null && row.count !== state.total) {
          return {
            applied: false,
            reason: `status "${status}" reported ${row.count} but the page showed ${state.total}`,
          };
        }
      }

      return { applied: true, models, total: state.total };
    };

    for (const make of makes) {
      runtime.throwIfCancelled();

      const offered =
        availableMakes.length === 0 ||
        availableMakes.some(
          (row) => row.name.localeCompare(make, undefined, { sensitivity: "accent" }) === 0
        );
      if (!offered) {
        warnings.push(
          `${make}: not offered in the current Dealer Alchemist make refinement; recorded as zero.`
        );
        continue;
      }

      const stock = await readCombination(make, transitKnown ? STATUS_IN_STOCK : null);
      if (!stock.applied) {
        warnings.push(
          `${make}: Dealer Alchemist ${stock.reason}; skipped rather than reporting unfiltered counts.`
        );
        continue;
      }
      for (const row of stock.models) {
        tally.addModelCount(make, row.name, { inStock: row.count });
      }
      const stockSum = stock.models.reduce((sum, row) => sum + row.count, 0);
      if (stock.total !== null && Math.abs(stock.total - stockSum) > 2) {
        warnings.push(
          `${make}: Dealer Alchemist model counts total ${stockSum} against a reported ${stock.total}.`
        );
      }

      if (!transitKnown) continue;

      const transit = await readCombination(make, STATUS_IN_TRANSIT);
      if (!transit.applied) {
        warnings.push(`${make}: Dealer Alchemist ${transit.reason}; transit recorded as zero.`);
        continue;
      }
      for (const row of transit.models) {
        tally.addModelCount(make, row.name, { inTransit: row.count });
      }
    }

    const counted = tally.result();
    for (const make of counted.missingMakes) {
      warnings.push(`${make}: no Dealer Alchemist model rows resolved; recorded as zero.`);
    }

    if (counted.models.length === 0) {
      throw new Error("Dealer Alchemist collection produced no model rows");
    }
    if (counted.totals.inStock <= 0) {
      throw new Error("Dealer Alchemist reconciled on-lot total was zero");
    }

    return {
      sourceUrl: srpUrl,
      detectedPlatform: "dealer_alchemist",
      totals: counted.totals,
      makeSubtotals: counted.makeSubtotals,
      models: counted.models,
      warnings,
    };
  }

  globalThis.inventoryPlatformAdapters ||= [];
  globalThis.inventoryPlatformAdapters.push({
    id: "dealer-alchemist",
    platforms: [
      "dealer_alchemist",
      "dealer-alchemist",
      "dealeralchemist",
      "dealervenom",
      "dealer_venom",
    ],
    collect,
  });
})();
