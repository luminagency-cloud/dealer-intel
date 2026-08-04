/* global inventoryNavigate, inventoryTally */

/**
 * DealerOn inventory from the site's own SRP vehicles API.
 *
 * DealerOn renders its results grid incrementally, so a facet/DOM reader sees
 * one vehicle card on a page advertising 356. The page is backed by a JSON
 * endpoint the site calls itself:
 *
 *   /api/vhcliaa/vehicle-pages/cosmos/srp/vehicles/<dealerId>/<pageId>
 *
 * `dealerId` and `pageId` come from the `dealeron_tagging_data` script block
 * embedded in every SRP. `baseFilter=dHlwZT0nbic=` is base64 for `type='n'`,
 * DealerOn's own "new inventory" filter, and `pn` is its published page-size
 * control (12/24/48/96 — the same values the site's own pager links use).
 *
 * That gives exact vehicle-level counts, so unlike the facet platforms this
 * adapter never navigates once per make: every card carries its own make,
 * model, and in-stock/in-transit flags. One request per 96 vehicles.
 *
 * The fetch is issued from the dealer's own page, so it is same-origin and
 * carries the session the visible browser already established.
 */
(() => {
  const VEHICLES_PAGE_SIZE = 96;
  // DealerOn's own "new" base filter, base64 of `type='n'`.
  const NEW_INVENTORY_BASE_FILTER = "dHlwZT0nbic=";
  // A store with more than this many new vehicles is not a store, it is a
  // pagination bug. Stops a broken TotalPages from looping the whole batch.
  const MAX_VEHICLE_PAGES = 40;

  const execute = (tabId, func, args) => inventoryNavigate.execute(tabId, func, args);

  // -------------------------------------------------------------------------
  // Page shape
  // -------------------------------------------------------------------------

  async function inventoryPageState(tabId) {
    return execute(tabId, () => {
      const html = document.documentElement?.outerHTML || "";
      const tagging = document
        .querySelector('script#dealeron_tagging_data[type="application/json"]')
        ?.textContent;
      let dealerId = null;
      let pageId = null;
      let pageType = null;
      if (tagging) {
        try {
          const parsed = JSON.parse(tagging);
          dealerId = parsed?.dealerId ?? null;
          pageId = parsed?.pageId ?? null;
          pageType = parsed?.pageType ?? null;
        } catch {
          // A truncated payload is treated as absent; readiness falls through
          // to the card check below and the caller keeps walking tiers.
        }
      }
      const cards = document.querySelectorAll(".vehicle-card[data-model]").length;
      return {
        url: location.href,
        dealerId,
        pageId,
        pageType,
        cards,
        isDealerOn: /dealeron/i.test(html) || /searchnew\.aspx/i.test(location.pathname),
        // An SRP is identified by its tagging payload naming an item list, or
        // by the presence of real vehicle cards. Homepages carry tagging data
        // too, which is why `pageType` matters.
        hasControls: (Boolean(dealerId) && pageType === "itemlist") || cards > 0,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Vehicles API
  // -------------------------------------------------------------------------

  /**
   * Read one page of the vehicles API from inside the dealer's own page.
   *
   * Returns plain data (never a Response) because everything crossing the
   * `executeScript` boundary has to survive structured cloning.
   */
  async function fetchVehiclePage(tabId, identity, pageNumber) {
    return execute(
      tabId,
      async (dealerId, pageId, baseFilter, pageSize, page) => {
        const url = new URL(
          `/api/vhcliaa/vehicle-pages/cosmos/srp/vehicles/${dealerId}/${pageId}`,
          location.href
        );
        url.searchParams.set("host", location.hostname);
        url.searchParams.set("baseFilter", baseFilter);
        url.searchParams.set("displayCardsShown", "NaN");
        url.searchParams.set("pn", String(pageSize));
        if (page > 1) url.searchParams.set("pt", String(page));

        let response;
        try {
          response = await fetch(url.toString(), {
            headers: { Accept: "application/json,text/plain,*/*" },
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

        // The card shape has moved between DealerOn releases (VehicleCard,
        // nested view models, ad cards mixed into the same array), so pull the
        // four fields we need by key from anywhere in the card rather than by
        // a fixed path.
        const findValue = (input, key, depth = 0) => {
          if (depth > 8 || !input || typeof input !== "object") return undefined;
          if (Array.isArray(input)) {
            for (const item of input) {
              const found = findValue(item, key, depth + 1);
              if (found !== undefined) return found;
            }
            return undefined;
          }
          if (key in input) return input[key];
          for (const value of Object.values(input)) {
            const found = findValue(value, key, depth + 1);
            if (found !== undefined) return found;
          }
          return undefined;
        };

        const vehicles = [];
        for (const card of payload?.DisplayCards ?? []) {
          if (card?.IsAdCard) continue;
          const model = String(findValue(card, "VehicleModel") ?? "").trim();
          if (!model) continue;
          vehicles.push({
            make: String(findValue(card, "VehicleMake") ?? "").trim(),
            model,
            inStock: Boolean(findValue(card, "VehicleInStock")),
            inTransit: Boolean(findValue(card, "VehicleInTransit")),
          });
        }

        const paging = payload?.Paging?.PaginationDataModel ?? null;
        return {
          ok: true,
          url: url.toString(),
          status: response.status,
          totalPages: Number(paging?.TotalPages) || 1,
          totalCount: Number.isFinite(Number(paging?.TotalCount))
            ? Number(paging.TotalCount)
            : null,
          vehicles,
        };
      },
      [
        identity.dealerId,
        identity.pageId,
        NEW_INVENTORY_BASE_FILTER,
        VEHICLES_PAGE_SIZE,
        pageNumber,
      ]
    );
  }

  /**
   * DOM fallback for a store whose tagging payload or API is unavailable.
   *
   * Slower and page-size bound, but DealerOn's cards carry the same four
   * attributes the API exposes, so the counts mean the same thing.
   */
  async function readVehicleCards(tabId) {
    return execute(tabId, () =>
      Array.from(document.querySelectorAll(".vehicle-card[data-model]")).map((card) => ({
        make: (card.getAttribute("data-make") || "").trim(),
        model: (card.getAttribute("data-model") || "").trim(),
        inStock: card.getAttribute("data-instock") === "true",
        inTransit: card.getAttribute("data-intransit") === "true",
      }))
    );
  }

  async function collectFromCards(tabId, srpUrl, advertisedTotal, helpers, runtime, warnings) {
    const pageSize = 24;
    const totalPages =
      advertisedTotal && advertisedTotal > 0
        ? Math.min(Math.ceil(advertisedTotal / pageSize), MAX_VEHICLE_PAGES)
        : 1;
    const vehicles = [];
    for (let page = 1; page <= totalPages; page += 1) {
      runtime.throwIfCancelled();
      if (page > 1) {
        await inventoryNavigate.goto(
          tabId,
          inventoryNavigate.withParams(srpUrl, { pt: page }),
          helpers,
          runtime
        );
      }
      const rows = await readVehicleCards(tabId);
      if (rows.length === 0) {
        warnings.push(`DealerOn result page ${page} rendered no vehicle cards.`);
        break;
      }
      vehicles.push(...rows);
    }
    return vehicles;
  }

  /** The dealer's own "Showing all N vehicles" line, used as a cross-check. */
  async function readAdvertisedTotal(tabId) {
    return execute(tabId, () => {
      const text = document.body?.innerText || "";
      const match =
        text.match(/showing\s+all\s+([\d,]+)\s+vehicles/i) ||
        text.match(/showing\s+\d+\s*[-–]\s*\d+\s+of\s+([\d,]+)/i);
      if (!match) return null;
      const parsed = Number(match[1].replace(/,/g, ""));
      return Number.isFinite(parsed) ? parsed : null;
    });
  }

  // -------------------------------------------------------------------------
  // Collection
  // -------------------------------------------------------------------------

  async function collect({ item, helpers, runtime }) {
    const warnings = [];
    const { tabId } = await inventoryNavigate.openInventorySession({
      item,
      platform: "dealer_on",
      helpers,
    });

    const landing = await inventoryNavigate.resolveInventoryPage({
      tabId,
      item,
      platform: "dealer_on",
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
      throw new Error("DealerOn collection requires a configured make allow-list");
    }

    const advertisedTotal = await readAdvertisedTotal(tabId).catch(() => null);
    let vehicles = [];
    let sourceUrl = srpUrl;

    if (landing.dealerId && landing.pageId) {
      const identity = { dealerId: landing.dealerId, pageId: landing.pageId };
      const first = await fetchVehiclePage(tabId, identity, 1);
      if (first?.ok) {
        sourceUrl = first.url;
        vehicles = [...first.vehicles];
        const totalPages = Math.min(first.totalPages, MAX_VEHICLE_PAGES);
        if (first.totalPages > MAX_VEHICLE_PAGES) {
          warnings.push(
            `DealerOn reported ${first.totalPages} result pages; read the first ${MAX_VEHICLE_PAGES}.`
          );
        }
        for (let page = 2; page <= totalPages; page += 1) {
          runtime.throwIfCancelled();
          const next = await fetchVehiclePage(tabId, identity, page);
          if (!next?.ok) {
            warnings.push(
              `DealerOn vehicles API failed on page ${page} (HTTP ${next?.status ?? 0}); counts cover pages 1-${page - 1}.`
            );
            break;
          }
          vehicles.push(...next.vehicles);
        }
        if (first.totalCount !== null && Math.abs(first.totalCount - vehicles.length) > 2) {
          warnings.push(
            `DealerOn returned ${vehicles.length} vehicle cards against a reported ${first.totalCount}.`
          );
        }
      } else {
        warnings.push(
          `DealerOn vehicles API was unavailable (HTTP ${first?.status ?? 0}); fell back to reading result pages.`
        );
      }
    } else {
      warnings.push(
        "DealerOn tagging payload was not on the inventory page; fell back to reading result pages."
      );
    }

    if (vehicles.length === 0) {
      vehicles = await collectFromCards(
        tabId,
        srpUrl,
        advertisedTotal,
        helpers,
        runtime,
        warnings
      );
      sourceUrl = srpUrl;
    }

    if (vehicles.length === 0) {
      throw new Error("DealerOn collection found no vehicles on the inventory page");
    }

    // Vehicle-level truth: every card names its own make, so a multi-brand
    // store needs no per-make navigation and no facet reading at all — and a
    // configured make with no cars is a confirmed zero, not a missed read.
    const tally = inventoryTally.createInventoryTally({
      makeAllowList: makes,
      enumerated: true,
    });
    for (const vehicle of vehicles) {
      tally.addVehicle(vehicle.make, vehicle.model, {
        inTransit: vehicle.inTransit && !vehicle.inStock,
      });
    }
    const counted = tally.result();

    // `counted.missingMakes` deliberately does not warn here: the API listed
    // every new vehicle on the lot, so a configured make with none of them is
    // an answer rather than a failed read. See `enumerated` in tally.js.
    if (counted.ignoredMakes.length > 0) {
      warnings.push(
        `DealerOn also listed ${counted.ignoredMakes
          .map((row) => `${row.make} (${row.count})`)
          .join(", ")}, which the dealer is not configured for; excluded.`
      );
    }
    if (
      advertisedTotal !== null &&
      counted.ignoredMakes.length === 0 &&
      Math.abs(advertisedTotal - vehicles.length) > 2
    ) {
      warnings.push(
        `DealerOn advertised ${advertisedTotal} vehicles but returned ${vehicles.length}.`
      );
    }

    if (counted.models.length === 0) {
      throw new Error("DealerOn collection produced no model rows for the configured makes");
    }
    if (counted.totals.inStock <= 0) {
      throw new Error("DealerOn reconciled on-lot total was zero");
    }

    return {
      sourceUrl,
      detectedPlatform: "dealer_on",
      totals: counted.totals,
      makeSubtotals: counted.makeSubtotals,
      models: counted.models,
      warnings,
    };
  }

  globalThis.inventoryPlatformAdapters ||= [];
  globalThis.inventoryPlatformAdapters.push({
    id: "dealer-on",
    platforms: ["dealer_on", "dealer-on", "dealeron"],
    collect,
  });
})();
