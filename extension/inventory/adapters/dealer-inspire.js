/* global inventoryNavigate */

/**
 * Dealer Inspire (LightningVRP) inventory via public SRP URLs.
 *
 * Two changes from the earlier click-driven pass:
 *
 * 1. Filtering is done by navigating to the site's own refinement URLs
 *    (`_dFR[make][0]=Jeep`, `_dFR[availability][0]=In-Stock`). LightningVRP
 *    publishes these — they are what the site puts in the address bar when a
 *    shopper ticks a filter, so they are shareable and stable.
 *
 * 2. Facet rows are read from `[data-facet="..."]` anywhere in the document.
 *    The previous reader required a visible `[role="dialog"]` matching
 *    /select model/i, which only exists on the narrow/mobile filter layout. On
 *    the desktop layout the same facets live in `#lvrp-filters-column` with no
 *    dialog at all, so every desktop-width store failed outright.
 */
(() => {
  const AVAILABILITY_IN_STOCK = "In-Stock";
  const AVAILABILITY_IN_TRANSIT = "In-Transit";

  const execute = (tabId, func, args) => inventoryNavigate.execute(tabId, func, args);

  /** LightningVRP's Algolia-style refinement param for a single facet value. */
  function refinementParam(facet, value, index = 0) {
    return { [`_dFR[${facet}][${index}]`]: value };
  }

  // -------------------------------------------------------------------------
  // Page shape
  // -------------------------------------------------------------------------

  async function inventoryPageState(tabId) {
    return execute(tabId, () => {
      const vehicles = document.querySelectorAll("[data-vehicle]").length;
      const facets = document.querySelectorAll("[data-facet], [data-facettype]").length;
      const isDealerInspire =
        Boolean(globalThis.LightningVRP) ||
        Boolean(globalThis.algoliaConfig) ||
        Boolean(document.querySelector("#lvrp-filters-column, [data-facettype]")) ||
        (vehicles > 0 && facets > 0);
      // Style-only, no geometry. A backgrounded tab has no computed layout, so
      // a geometry-based check reports every spinner as gone and the collector
      // stops working the moment the operator switches tabs.
      const busy = Array.from(
        document.querySelectorAll('[aria-busy="true"], .loading, .is-loading, .spinner')
      ).some((element) => {
        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden";
      });
      return {
        url: location.href,
        isDealerInspire,
        vehicles,
        facets,
        modelFacets: document.querySelectorAll(
          '[data-facet="model"], [data-facettype="model"]'
        ).length,
        // Facets, not vehicle cards: a homepage carousel has vehicles but
        // nothing to filter by.
        hasControls: facets > 0,
        busy,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Facet reading
  // -------------------------------------------------------------------------

  /**
   * Read `[data-facet="<kind>"]` rows from anywhere in the document. If the
   * panel is collapsed, click its `[data-facettype]` toggle and let the caller
   * poll again — the desktop column and the mobile dialog both render the same
   * `data-facet` rows once open.
   */
  async function readFacetOnce(tabId, kind) {
    return execute(
      tabId,
      (facetKind) => {
        const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const normalize = (value) => clean(value).toLowerCase();
        const parseCount = (value) => {
          const match = clean(value).match(/(\d[\d,]*)\s*(?:available|vehicles?|results?)?/i);
          const count = match ? Number(match[1].replace(/,/g, "")) : Number.NaN;
          return Number.isFinite(count) ? count : null;
        };

        const elements = Array.from(
          document.querySelectorAll(`[data-facet="${facetKind}"]`)
        );
        if (elements.length === 0) {
          const toggle =
            document.querySelector(`#lvrp-filters-column [data-facettype="${facetKind}"]`) ||
            document.querySelector(`[data-facettype="${facetKind}"]`);
          if (toggle instanceof HTMLElement) {
            toggle.scrollIntoView({ block: "center", inline: "nearest" });
            toggle.click();
            return { found: true, rows: [] };
          }
          return { found: false, rows: [] };
        }

        const refinements = Array.from(new URL(location.href).searchParams.entries());
        const rows = [];
        for (const element of elements) {
          const value = clean(element.getAttribute("data-value"));
          const name = clean(
            element.querySelector(".facet__details--name")?.textContent ||
              value ||
              element.innerText.replace(/\s+[\d,]+\s+available.*$/i, "")
          );
          if (!name) continue;
          const count = parseCount(
            element.querySelector(".facet__details--count")?.textContent || element.innerText
          );
          const check = element.querySelector('input[type="checkbox"], [role="checkbox"]');
          const classText = `${element.className || ""} ${element.parentElement?.className || ""}`;
          const selectedByUrl = refinements.some(
            ([key, selectedValue]) =>
              normalize(key).includes(facetKind) &&
              normalize(selectedValue) === normalize(value || name)
          );
          const selected = Boolean(
            selectedByUrl ||
              (check instanceof HTMLInputElement && check.checked) ||
              check?.getAttribute("aria-checked") === "true" ||
              element.getAttribute("aria-selected") === "true" ||
              element.getAttribute("aria-pressed") === "true" ||
              /(?:^|\s)(?:active|selected|checked|is-active|is-selected)(?:\s|$)/i.test(classText)
          );
          rows.push({ name, value: value || name, count, selected });
        }

        const byKey = new Map();
        for (const row of rows) {
          const key = normalize(row.value || row.name);
          const previous = byKey.get(key);
          if (!previous || (row.count ?? -1) > (previous.count ?? -1)) byKey.set(key, row);
        }
        return { found: true, rows: [...byKey.values()] };
      },
      [kind]
    );
  }

  async function readFacetRows(tabId, kind, runtime, timeoutMs = 10_000) {
    const result = await runtime
      .waitFor(
        async () => {
          const attempt = await readFacetOnce(tabId, kind);
          if (!attempt.found) return null;
          return attempt.rows.length > 0 ? attempt : null;
        },
        {
          timeoutMs,
          intervalMs: 250,
          message: `Dealer Inspire ${kind} facet did not render rows`,
        }
      )
      .catch(() => null);
    return result?.rows ?? [];
  }

  function plausibleModelName(name) {
    const normalized = String(name || "").replace(/\s+/g, " ").trim();
    if (!normalized || normalized.length > 80) return false;
    if (
      /\b(?:sales|service|parts|directions|contact|results?|matches|vehicles?|inventory|stock:)\b/i.test(
        normalized
      )
    ) {
      return false;
    }
    return /[A-Za-z0-9]/.test(normalized);
  }

  function canonicalModel(make, model) {
    const cleaned = String(model || "").replace(/\s+/g, " ").trim();
    if (/^ram$/i.test(make) && !/^ram\b/i.test(cleaned)) return `Ram ${cleaned}`;
    return cleaned;
  }

  async function readModelCounts(tabId, make, runtime) {
    const rows = (await readFacetRows(tabId, "model", runtime))
      .filter((row) => Number.isFinite(row.count) && plausibleModelName(row.name))
      .map((row) => ({ name: canonicalModel(make, row.value || row.name), count: row.count }));

    const byName = new Map();
    for (const row of rows) byName.set(row.name, Math.max(byName.get(row.name) || 0, row.count));
    const models = [...byName.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, count]) => ({ name, count }));
    return { models, total: models.reduce((sum, row) => sum + row.count, 0) };
  }

  // -------------------------------------------------------------------------
  // Filter verification
  // -------------------------------------------------------------------------

  /**
   * Confirm the refinement took. Without this, a store that ignores the URL
   * refinement would report unfiltered counts for every make.
   */
  async function verifyRefinementApplied(tabId, facet, value) {
    return execute(
      tabId,
      (facetKind, wanted) => {
        const normalize = (input) =>
          String(input || "").toLowerCase().replace(/\s+/g, " ").trim();
        const target = normalize(wanted);

        const fromUrl = Array.from(new URL(location.href).searchParams.entries()).some(
          ([key, selected]) =>
            normalize(key).includes(facetKind) && normalize(selected) === target
        );
        if (fromUrl) {
          // The param survived the load; confirm the app also consumed it when
          // it exposes its own state.
          const state = globalThis.LightningVRP?.getCurrentState?.();
          const refinements = state?.refinements?.[facetKind];
          if (!Array.isArray(refinements)) return true;
          return refinements.some((entry) => normalize(entry) === target);
        }

        return Array.from(document.querySelectorAll(`[data-facet="${facetKind}"]`)).some(
          (element) => {
            if (normalize(element.getAttribute("data-value")) !== target) return false;
            const check = element.querySelector('input[type="checkbox"], [role="checkbox"]');
            return Boolean(
              (check instanceof HTMLInputElement && check.checked) ||
                check?.getAttribute("aria-checked") === "true" ||
                element.getAttribute("aria-selected") === "true" ||
                /(?:^|\s)(?:active|selected|checked|is-active|is-selected)(?:\s|$)/i.test(
                  element.className || ""
                )
            );
          }
        );
      },
      [facet, value]
    );
  }

  // -------------------------------------------------------------------------
  // Collection
  // -------------------------------------------------------------------------

  function mergeStatusModels(make, inStock, inTransit, transitKnown) {
    const stock = new Map(inStock.map((row) => [row.name, row.count]));
    const transit = new Map(inTransit.map((row) => [row.name, row.count]));
    return [...new Set([...stock.keys(), ...transit.keys()])]
      .sort((left, right) => left.localeCompare(right))
      .map((model) => ({
        make,
        model,
        inStock: stock.get(model) || 0,
        inTransit: transitKnown ? transit.get(model) || 0 : null,
        status: "ok",
      }));
  }

  async function collect({ item, helpers, runtime }) {
    const warnings = [];
    const { tabId } = await inventoryNavigate.openInventorySession({
      item,
      platform: "dealer_inspire",
      helpers,
    });

    const landing = await inventoryNavigate.resolveInventoryPage({
      tabId,
      item,
      platform: "dealer_inspire",
      helpers,
      runtime,
      warnings,
      // As with Dealer.com: readiness asks only whether this page exposes
      // filters, not whether it re-proves the platform.
      inspect: async (id) => {
        const candidate = await inventoryPageState(id);
        return { ...candidate, ready: candidate.hasControls };
      },
    });

    const srpUrl = landing.url;
    const makes = [...new Set((item.makeAllowList || []).filter(Boolean))];
    if (makes.length === 0) {
      throw new Error("Dealer Inspire collection requires a configured make allow-list");
    }

    const availableMakes = await readFacetRows(tabId, "make", runtime);
    const availability = await readFacetRows(tabId, "availability", runtime, 6_000);
    const availabilityLabel = availability
      .map((row) => `${row.name} ${row.value}`)
      .join(" ")
      .replace(/[‐-―]/g, "-")
      .toLowerCase();
    const transitKnown =
      /\b(?:in[- ]?stock|on\s+(?:the\s+)?lot)\b/.test(availabilityLabel) &&
      /\b(?:in[- ]?transit|incoming|inbound)\b/.test(availabilityLabel);
    if (availability.length > 0 && !transitKnown) {
      warnings.push(
        "Dealer Inspire exposed an availability facet without a public in-stock/in-transit split; transit left unresolved."
      );
    }

    const models = [];
    const makeSubtotals = [];

    for (const make of makes) {
      runtime.throwIfCancelled();

      const offered =
        availableMakes.length === 0 ||
        availableMakes.some(
          (row) =>
            row.name.localeCompare(make, undefined, { sensitivity: "accent" }) === 0 ||
            row.value.localeCompare(make, undefined, { sensitivity: "accent" }) === 0
        );
      if (!offered) {
        warnings.push(
          `${make}: not offered in the current Dealer Inspire make facet; recorded as zero.`
        );
        makeSubtotals.push({ make, inStock: 0, inTransit: null });
        continue;
      }

      await inventoryNavigate.goto(
        tabId,
        inventoryNavigate.withParams(srpUrl, {
          ...refinementParam("make", make),
          ...(transitKnown ? refinementParam("availability", AVAILABILITY_IN_STOCK) : {}),
        }),
        helpers,
        runtime
      );

      if (!(await verifyRefinementApplied(tabId, "make", make))) {
        warnings.push(
          `${make}: Dealer Inspire did not apply the make refinement from the URL; skipped rather than reporting unfiltered counts.`
        );
        makeSubtotals.push({ make, inStock: 0, inTransit: null });
        continue;
      }

      const inStock = await readModelCounts(tabId, make, runtime);

      let inTransit = { models: [], total: 0 };
      if (transitKnown) {
        await inventoryNavigate.goto(
          tabId,
          inventoryNavigate.withParams(srpUrl, {
            ...refinementParam("make", make),
            ...refinementParam("availability", AVAILABILITY_IN_TRANSIT),
          }),
          helpers,
          runtime
        );
        inTransit = await readModelCounts(tabId, make, runtime);
      }

      models.push(...mergeStatusModels(make, inStock.models, inTransit.models, transitKnown));
      makeSubtotals.push({
        make,
        inStock: inStock.total,
        inTransit: transitKnown ? inTransit.total : null,
      });
    }

    if (models.length === 0) {
      throw new Error("Dealer Inspire collection produced no model rows");
    }

    const totalInStock = makeSubtotals.reduce((sum, row) => sum + row.inStock, 0);
    const allTransitKnown = makeSubtotals.every((row) => row.inTransit !== null);
    const totalInTransit = allTransitKnown
      ? makeSubtotals.reduce((sum, row) => sum + row.inTransit, 0)
      : null;
    if (totalInStock <= 0) {
      throw new Error("Dealer Inspire reconciled on-lot total was zero");
    }

    return {
      sourceUrl: srpUrl,
      detectedPlatform: "dealer_inspire",
      totals: {
        inStock: totalInStock,
        inTransit: totalInTransit,
        displayValue:
          totalInTransit === null ? String(totalInStock) : `${totalInStock}/${totalInTransit}*`,
      },
      makeSubtotals,
      models,
      warnings,
    };
  }

  globalThis.inventoryPlatformAdapters ||= [];
  globalThis.inventoryPlatformAdapters.push({
    id: "dealer-inspire",
    platforms: [
      "dealer_inspire",
      "dealer-inspire",
      "dealerinspire",
      "lightningvrp",
      "lightning",
    ],
    collect,
  });
})();
