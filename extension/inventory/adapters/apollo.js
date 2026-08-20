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
        // Bounded by the character class, never greedy: these assignments can
        // share a line, and a greedy match would run `accountId` straight
        // through the next `var` to the last quote on it.
        const match = html.match(new RegExp(`var\\s+${key}\\s*=\\s*(['"])([^'"]*)\\1\\s*;`, "i"));
        if (!match) return null;
        return match[2]
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
        // The account id is what the API call is built from. `selectedFilters`
        // only refines it, and every field it carries has a default below, so
        // requiring it here rejected pages we could have queried: Apollo
        // stopped emitting a parseable `selectedFilters` and all three Apollo
        // dealers failed navigation with `accountId` sitting right there.
        hasControls: Boolean(selectedFilters?.AccountID || accountId),
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
  async function fetchFiltersOnce(tabId, identity, state) {
    return execute(
      tabId,
      async (endpoint, pageFilters, accountId, campaignId, availability) => {
        // Absent on pages that no longer publish the variable; every field it
        // would have supplied falls back below.
        const selectedFilters = pageFilters || {};
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

  /**
   * The same request, retried once when the browser never got an answer.
   *
   * `status: 0` is a THROWN fetch, not a refused one — it is what an in-flight
   * request looks like when the page navigates out from under it, which these
   * stores do on first load (non-www -> www). A refusal the server actually
   * sent (404, 403, 500) is a real answer and is returned as-is.
   *
   * This used to guard only the in-transit call, so the on-lot call — the one
   * whose failure fails the whole dealer — was the one without a retry.
   */
  async function fetchFilters(tabId, identity, state, runtime) {
    const first = await fetchFiltersOnce(tabId, identity, state);
    if (first?.ok || (first && first.status !== 0)) return first;
    await runtime.sleep(1_000);
    runtime.throwIfCancelled();
    return fetchFiltersOnce(tabId, identity, state);
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
    const inStock = await fetchFilters(
      tabId,
      identity,
      { inStock: true, inTransit: false, inProduction: false },
      runtime
    );
    if (!inStock?.ok) {
      throw new Error(
        `Apollo filter API failed (HTTP ${inStock?.status ?? 0})${
          inStock?.error ? `: ${inStock.error}` : ""
        }`
      );
    }

    runtime.throwIfCancelled();
    const inTransit = await fetchFilters(
      tabId,
      identity,
      { inStock: false, inTransit: true, inProduction: false },
      runtime
    );
    // In-transit is a second opinion, not the headline number. A store that
    // answers the on-lot call but not this one still has usable on-lot data,
    // so report transit as unresolved rather than failing the dealer.
    const transitKnown = Boolean(inTransit?.ok);
    if (!transitKnown) {
      warnings.push(
        `Apollo in-transit query failed (HTTP ${inTransit?.status ?? 0}${
          inTransit?.error ? `: ${inTransit.error}` : ""
        }); transit left unresolved and transit-only models are missing.`
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
