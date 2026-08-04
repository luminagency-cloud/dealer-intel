/* global inventoryNavigate, inventoryTally */

/**
 * Apollo (Team Velocity) inventory from the site's own filter API.
 *
 * Apollo's SRP embeds its query state as page-level script variables
 * (`selectedFilters`, `accountId`, `campaignId`) and asks
 * `/api/Inventory/getinventorymultiselectionfilters/v2` for the facet counts
 * it renders. That endpoint returns every make and every model with a `make`
 * attached, so one request gives a complete make-scoped model breakdown — no
 * per-make navigation, and no risk of the whole-dealership model dump that
 * reading an unfiltered model facet would produce.
 *
 * On-lot and in-transit are separate calls because `InStock`/`InTransit` are
 * request flags, not facet values.
 *
 * The page variables are read out of the document HTML rather than off
 * `window`: injected scripts run in the isolated world, where the page's own
 * globals are not visible.
 */
(() => {
  const FILTERS_ENDPOINT = "/api/Inventory/getinventorymultiselectionfilters/v2";

  const execute = (tabId, func, args) => inventoryNavigate.execute(tabId, func, args);

  // -------------------------------------------------------------------------
  // Page shape
  // -------------------------------------------------------------------------

  async function inventoryPageState(tabId) {
    return execute(tabId, () => {
      const html = document.documentElement?.outerHTML || "";
      const readVar = (key) => {
        const match = html.match(new RegExp(`var\\s+${key}\\s*=\\s*'([^']*)';`, "i"));
        if (!match) return null;
        return match[1]
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&amp;/g, "&")
          .replace(/&nbsp;/g, " ");
      };

      const rawFilters = readVar("selectedFilters");
      let selectedFilters = null;
      if (rawFilters) {
        try {
          selectedFilters = JSON.parse(rawFilters);
        } catch {
          selectedFilters = null;
        }
      }

      const accountId = readVar("accountId");
      const campaignId = readVar("campaignId") || readVar("campaignid");
      return {
        url: location.href,
        accountId,
        campaignId,
        selectedFilters,
        isApollo: /teamvelocitymarketing|secureoffersites\.com|tvmwebsitecdn\.com/i.test(html),
        // The filter payload is what the API call is built from. A page
        // without it cannot be queried, whatever else it looks like.
        hasControls: Boolean(selectedFilters && (selectedFilters.AccountID || accountId)),
      };
    });
  }

  // -------------------------------------------------------------------------
  // Filter API
  // -------------------------------------------------------------------------

  /**
   * Ask for facet counts under one availability state.
   *
   * Every field is echoed back from the page's own `selectedFilters` so the
   * query matches what the site would have asked for itself; only the three
   * availability flags are ours.
   */
  async function fetchFilters(tabId, identity, state) {
    return execute(
      tabId,
      async (endpoint, selectedFilters, accountId, campaignId, availability) => {
        const params = new URLSearchParams({
          AccountID: String(selectedFilters.AccountID ?? accountId ?? ""),
          Type: selectedFilters.Type ?? "New",
          PaymentType: selectedFilters.PaymentType ?? "cash",
          Page: String(selectedFilters.Page ?? 0),
          SortType: selectedFilters.SortType ?? "priceltoh",
          CampaignId: String(selectedFilters.CampaignId ?? campaignId ?? ""),
          SourceFrom: selectedFilters.SourceFrom ?? "inventorycontroller",
          InStock: String(availability.inStock),
          InTransit: String(availability.inTransit),
          InProduction: String(availability.inProduction),
        });
        // Preserve any make/model scoping the SRP itself already carried; a
        // brand-specific landing page would otherwise widen to the whole store.
        if (selectedFilters.Makes) params.set("Makes", selectedFilters.Makes);
        if (selectedFilters.Models) params.set("Models", selectedFilters.Models);

        const url = new URL(endpoint, location.href);
        url.search = params.toString();

        let response;
        try {
          response = await fetch(url.toString(), {
            headers: {
              Accept: "application/json,text/plain,*/*",
              "X-Requested-With": "XMLHttpRequest",
            },
            credentials: "same-origin",
          });
        } catch (error) {
          return { ok: false, url: url.toString(), status: 0, error: String(error) };
        }
        if (!response.ok) {
          return { ok: false, url: url.toString(), status: response.status };
        }

        let payload;
        try {
          payload = await response.json();
        } catch (error) {
          return {
            ok: false,
            url: url.toString(),
            status: response.status,
            error: `response was not JSON: ${String(error)}`,
          };
        }

        const filters = payload?.filters ?? {};
        return {
          ok: true,
          url: url.toString(),
          status: response.status,
          makes: (filters.makes ?? [])
            .map((row) => ({ name: String(row?.text ?? "").trim(), count: Number(row?.count) }))
            .filter((row) => row.name && row.name !== "All" && Number.isFinite(row.count)),
          models: (filters.models ?? [])
            .map((row) => ({
              make: String(row?.make ?? "").trim(),
              name: String(row?.text ?? "").trim(),
              count: Number(row?.count),
            }))
            // `make: null` marks the synthetic "All" aggregate row; counting
            // it would double every total.
            .filter(
              (row) =>
                row.make && row.name && row.name !== "All" && Number.isFinite(row.count)
            ),
        };
      },
      [
        FILTERS_ENDPOINT,
        identity.selectedFilters,
        identity.accountId,
        identity.campaignId,
        state,
      ]
    );
  }

  // -------------------------------------------------------------------------
  // Collection
  // -------------------------------------------------------------------------

  async function collect({ item, helpers, runtime }) {
    const warnings = [];
    const { tabId } = await inventoryNavigate.openInventorySession({
      item,
      platform: "apollo",
      helpers,
    });

    const landing = await inventoryNavigate.resolveInventoryPage({
      tabId,
      item,
      platform: "apollo",
      helpers,
      runtime,
      warnings,
      inspect: async (id) => {
        const candidate = await inventoryPageState(id);
        return { ...candidate, ready: candidate.hasControls };
      },
    });

    const makes = [...new Set((item.makeAllowList || []).filter(Boolean))];
    if (makes.length === 0) {
      throw new Error("Apollo collection requires a configured make allow-list");
    }

    const identity = {
      selectedFilters: landing.selectedFilters,
      accountId: landing.accountId,
      campaignId: landing.campaignId,
    };

    runtime.throwIfCancelled();
    const inStock = await fetchFilters(tabId, identity, {
      inStock: true,
      inTransit: false,
      inProduction: false,
    });
    if (!inStock?.ok) {
      throw new Error(
        `Apollo filter API failed (HTTP ${inStock?.status ?? 0})${
          inStock?.error ? `: ${inStock.error}` : ""
        }`
      );
    }

    runtime.throwIfCancelled();
    const inTransit = await fetchFilters(tabId, identity, {
      inStock: false,
      inTransit: true,
      inProduction: false,
    });
    // In-transit is a second opinion, not the headline number. A store that
    // answers the on-lot call but not this one still has usable on-lot data,
    // so report transit as unresolved rather than failing the dealer.
    const transitKnown = Boolean(inTransit?.ok);
    if (!transitKnown) {
      warnings.push(
        `Apollo in-transit query failed (HTTP ${inTransit?.status ?? 0}); transit left unresolved.`
      );
    }

    // The filter API returns the store's complete make/model facet in one
    // call, so an absent configured make is confirmed absent.
    const tally = inventoryTally.createInventoryTally({
      makeAllowList: makes,
      transitKnown,
      enumerated: true,
    });
    for (const row of inStock.models) {
      tally.addModelCount(row.make, row.name, { inStock: row.count });
    }
    if (transitKnown) {
      for (const row of inTransit.models) {
        tally.addModelCount(row.make, row.name, { inTransit: row.count });
      }
    }
    const counted = tally.result();

    // `counted.missingMakes` deliberately does not warn: the filter API
    // returned the store's complete make facet, so a configured make absent
    // from it is an answer. See `enumerated` in tally.js.
    if (counted.ignoredMakes.length > 0) {
      warnings.push(
        `Apollo also listed ${counted.ignoredMakes
          .map((row) => `${row.make} (${row.count})`)
          .join(", ")}, which the dealer is not configured for; excluded.`
      );
    }

    // Apollo publishes make subtotals alongside the model rows, so the model
    // breakdown can be reconciled against the platform's own arithmetic
    // instead of only against itself.
    for (const subtotal of counted.makeSubtotals) {
      const reported = inStock.makes.find(
        (row) => row.name.localeCompare(subtotal.make, undefined, { sensitivity: "accent" }) === 0
      );
      if (reported && Math.abs(reported.count - subtotal.inStock) > 2) {
        warnings.push(
          `${subtotal.make}: Apollo model counts total ${subtotal.inStock} against a reported ${reported.count}.`
        );
      }
    }

    if (counted.models.length === 0) {
      throw new Error("Apollo collection produced no model rows for the configured makes");
    }
    if (counted.totals.inStock <= 0) {
      throw new Error("Apollo reconciled on-lot total was zero");
    }

    return {
      sourceUrl: inStock.url,
      detectedPlatform: "apollo",
      totals: counted.totals,
      makeSubtotals: counted.makeSubtotals,
      models: counted.models,
      warnings,
    };
  }

  globalThis.inventoryPlatformAdapters ||= [];
  globalThis.inventoryPlatformAdapters.push({
    id: "apollo",
    platforms: ["apollo", "team_velocity", "teamvelocity", "team-velocity"],
    collect,
  });
})();
