/* global inventoryNavigate */

/**
 * Dealer.com (DDC) inventory via public SRP URLs.
 *
 * Filtering is done by navigating to `?make=<Make>&status=<value>` rather than
 * by clicking facet checkboxes. Those params are part of DDC's public URL
 * contract — the dealer's own site links to them and customers bookmark them —
 * so they survive DOM and widget churn that breaks click paths. `status=1-1`
 * (on the lot) and `status=7-7` (in transit) are stable across DDC stores;
 * the human-readable status labels are not, which is why we never match on
 * them.
 *
 * The only unavoidable DOM dependency is reading per-model counts. That reader
 * is deliberately generic: it locates the facet by shape rather than by a
 * hardcoded id list, so a `model` -> `modelFamily` style rename does not take
 * the adapter down.
 */
(() => {
  const ON_LOT_STATUS = "1-1";
  const IN_TRANSIT_STATUS = "7-7";

  // Facet identification is by shape. `want` matches the container's id or its
  // heading; `reject` kills near-misses — most importantly the model-YEAR
  // facet, whose label also contains "model" on several DDC themes.
  const FACET_MATCHERS = {
    make: { want: "(^|[^a-z])make|manufacturer|brand", reject: "model|year" },
    model: { want: "(^|[^a-z])model", reject: "year|trim|body|transmission|drive" },
    status: { want: "status|availability|in.?transit|on.?the.?lot", reject: "price|payment|msrp|year" },
  };

  const execute = (tabId, func, args) => inventoryNavigate.execute(tabId, func, args);

  // -------------------------------------------------------------------------
  // Page shape
  // -------------------------------------------------------------------------

  async function inventoryPageState(tabId) {
    return execute(tabId, () => {
      const clean = (value) =>
        String(value || "")
          .replace(/[-]/g, "")
          .replace(/\s+/g, " ")
          .trim();
      // Style-only, no geometry: a backgrounded tab has no computed layout,
      // so anything keyed on getBoundingClientRect() reads as hidden there.
      const displayed = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden";
      };

      const provider = document
        .querySelector('meta[name="providerID" i]')
        ?.getAttribute("content");
      // NOTE: injected scripts run in the isolated world, so page globals like
      // window.DDC are NOT visible here. Every signal below must be DOM-based.
      const isDdc = Boolean(
        /^ddc$/i.test(provider || "") ||
          document.querySelector("[data-widget-name^='ws-inv'], [data-facet-group]") ||
          document.querySelector(
            'link[href*="dealer.com"], script[src*="dealer.com"], img[src*="dealer.com"]'
          )
      );
      const facetGroups = document.querySelectorAll("[data-facet-group], [data-facet]").length;
      const vehicles = document.querySelectorAll(
        "[data-vehicle], [data-inventory-id], .vehicle-card, [class*='vehicle-card' i]"
      ).length;

      // Result count read only from elements whose job is reporting it.
      // Marketing headings are excluded on purpose: an <h2> reading "Over 500
      // vehicles in stock!" used to poison this and fail the whole dealer.
      const countElements = Array.from(
        document.querySelectorAll(
          '[data-testid*="result-count" i], [data-testid*="inventory-count" i], [data-inventory-count], .inventory-count, .results-count, .result-count, .vehicle-count, [role=status]'
        )
      ).filter(displayed);
      const patterns = [
        /showing\s+\d+\s*[-–]\s*\d+\s+of\s+([\d,]+)/i,
        /^\s*([\d,]+)\s+(?:new\s+)?vehicles?\b/i,
        /^\s*([\d,]+)\s+results?\b/i,
        /^\s*results?\s*\(\s*([\d,]+)\s*\)/i,
      ];
      let total = null;
      for (const element of countElements) {
        const text = clean(element.innerText || element.getAttribute("aria-label"));
        if (!text || text.length > 90) continue;
        for (const pattern of patterns) {
          const match = text.match(pattern);
          if (!match) continue;
          const parsed = Number(match[1].replace(/,/g, ""));
          if (Number.isFinite(parsed)) {
            total = parsed;
            break;
          }
        }
        if (total !== null) break;
      }

      return {
        url: location.href,
        isDdc,
        provider: provider || null,
        facetGroups,
        vehicles,
        // The thing we actually need from a page is filterable inventory. A
        // homepage carousel satisfies "has vehicles" but has no facets, so
        // facets — not vehicle cards — are what make a page usable.
        hasControls: facetGroups > 0,
        total,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Facet reading
  //
  // One injected pass: locate the facet by shape, expand it if collapsed, and
  // read its rows. Kept in a single function so the container-finding logic
  // exists exactly once.
  // -------------------------------------------------------------------------

  async function readFacetOnce(tabId, kind) {
    const matcher = FACET_MATCHERS[kind];
    return execute(
      tabId,
      (wantSource, rejectSource) => {
        const want = new RegExp(wantSource, "i");
        const reject = new RegExp(rejectSource, "i");
        const clean = (value) =>
          String(value || "")
            .replace(/[-]/g, "")
            .replace(/\s+/g, " ")
            .trim();
        // Radios are here because single-brand DDC stores render the model
        // facet as a radio group ("Model Family" on Toyota themes) rather than
        // as checkboxes. We only ever READ these controls, so single- vs
        // multi-select makes no difference to us.
        const CONTROL_SELECTOR =
          'input[type="checkbox"], input[type="radio"], [role="checkbox"], a[data-value], button[aria-label*="matched vehicles" i]';

        // Find the tightest container whose id or heading looks like this
        // facet.
        //
        // Deliberately does NOT require the container to already hold
        // controls. DDC renders every facet panel collapsed and populates
        // `.panel-collapse` only on expand, so a live SRP reports zero
        // checkboxes for `make`, `model` and the rest until each is opened.
        // Requiring controls here meant the container was skipped before the
        // expand step could ever run — the facet could never be read at all.
        //
        // DDC facet ids are camelCase, and the humps are word boundaries the
        // matchers have to see: the "Model Family" facet is `superModel`, whose
        // "model" is not preceded by a non-letter, so it failed `want` outright.
        // The real container then dropped to the loosest tier and lost on
        // subtree size to its own `superModel--heading` div — which holds no
        // controls, so the facet read empty forever.
        const humps = (value) => value.replace(/([a-z])([A-Z])/g, "$1 $2");

        let best = null;
        const groups = document.querySelectorAll(
          "[data-facet-group], [data-facet], fieldset, section, div[id], li[id]"
        );
        for (const group of groups) {
          const facetAttr = humps(
            clean(group.getAttribute("data-facet-group") || group.getAttribute("data-facet"))
          );
          const id = humps(clean(group.id));
          const heading = clean(
            group.querySelector("legend, h2, h3, h4, [role=heading], button")?.textContent
          );
          if (!want.test(`${facetAttr} ${id} ${heading}`)) continue;
          if (reject.test(`${facetAttr} ${id} ${heading}`)) continue;

          // Rank by how authoritative the match is, THEN by subtree size.
          //
          // Ranking on size alone picked DDC's inner `.panel-collapse` div
          // (its id also contains "model") over the real
          // `[data-facet-group="model"]` container. The inner div holds no
          // expand button, so the panel could never be opened and the facet
          // always read empty.
          const tier =
            facetAttr && want.test(facetAttr) ? 0 : id && want.test(id) ? 1 : 2;
          const score = tier * 1_000_000 + group.getElementsByTagName("*").length;
          if (!best || score < best.score) best = { group, score };
        }
        if (!best) return { found: false, expanded: false, rows: [] };

        const container = best.group;
        const controls = Array.from(container.querySelectorAll(CONTROL_SELECTOR));

        // Presence in the DOM, NOT rendered visibility.
        //
        // Chrome stops computing layout for backgrounded and occluded pages,
        // so getBoundingClientRect() collapses to zero there. Gating on
        // visibility meant the collector silently stopped working the moment
        // the operator switched to another tab or window. DDC only inserts
        // these controls on expand, so their presence is already the signal
        // we need.
        if (controls.length === 0) {
          const trigger = container.querySelector(
            'button[aria-expanded], button[aria-controls], [data-toggle="collapse"], .panel-heading button, button, [role="button"]'
          );
          // Only click a panel that is actually shut. The caller polls this
          // function, and clicking an already-open panel would toggle it
          // closed again on every poll.
          const alreadyOpen = trigger?.getAttribute("aria-expanded") === "true";
          if (trigger instanceof HTMLElement && !alreadyOpen) {
            trigger.scrollIntoView({ block: "center" });
            trigger.click();
          }
          // Rows are read on the caller's next poll once the panel populates.
          return { found: true, expanded: false, rows: [] };
        }

        const rows = [];
        for (const control of controls) {
          const input = control instanceof HTMLInputElement ? control : null;
          const labelElement =
            (input?.id
              ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`)
              : null) ||
            control.closest("label") ||
            control.parentElement;
          const aria = clean(control.getAttribute("aria-label"));
          const label = clean(labelElement?.innerText || labelElement?.textContent || aria);
          const rawValue = clean(control.getAttribute("data-value") || input?.value || "");

          // Two shapes in the wild:
          //   aria: "Model: Grand Cherokee. 12 matched vehicles"
          //   text: "Grand Cherokee (12)" / "Grand Cherokee 12"
          const semantic = (aria || label).match(
            /^[^:]+:\s*(.+?)\.\s*([\d,]+)\s+matched vehicles?/i
          );
          const counted = (aria || label).match(
            /^(.+?)\s*\(?([\d,]+)\)?(?:\s+(?:available|vehicles?|matches?))?$/i
          );

          // Prefer the human label over the control value. Values are opaque
          // tokens on some themes and full labels on others; the label is
          // consistently the display name.
          const name = clean(semantic?.[1] || counted?.[1] || label || rawValue);
          if (!name || /^(?:clear|all|view|apply|close|reset)\b/i.test(name)) continue;
          const countText = semantic?.[2] || counted?.[2] || "";
          const parsedCount = countText ? Number(countText.replace(/,/g, "")) : null;

          const selected = input
            ? input.checked
            : control.getAttribute("aria-checked") === "true" ||
              control.getAttribute("aria-pressed") === "true" ||
              /(?:^|\s)(?:selected|active|is-selected|is-active|checked)(?:\s|$)/i.test(
                control.className || ""
              );

          rows.push({
            name,
            value: rawValue,
            count: Number.isFinite(parsedCount) ? parsedCount : null,
            selected: Boolean(selected),
          });
        }

        const byKey = new Map();
        for (const row of rows) {
          const key = row.name.toLowerCase();
          const previous = byKey.get(key);
          if (!previous || (row.count ?? -1) > (previous.count ?? -1)) byKey.set(key, row);
        }
        return { found: true, expanded: true, rows: [...byKey.values()] };
      },
      [matcher.want, matcher.reject]
    );
  }

  /** Read a facet, giving a collapsed panel a moment to expand and render. */
  async function readFacetRows(tabId, kind, runtime, timeoutMs = 10_000) {
    const result = await runtime
      .waitFor(
        async () => {
          const attempt = await readFacetOnce(tabId, kind);
          if (!attempt.found) return null;
          return attempt.rows.length > 0 ? attempt : null;
        },
        { timeoutMs, intervalMs: 250, message: `Dealer.com ${kind} facet did not render rows` }
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
    if (
      /\b(?:road|rd\.?|street|st\.?|avenue|ave\.?|lane|ln\.?|boulevard|blvd\.?|drive|dr\.?|highway|hwy\.?)\b.*[,•]/i.test(
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

  /** Per-model counts for whatever filter the current URL already applies. */
  async function readModelCounts(tabId, make, runtime) {
    const rows = (await readFacetRows(tabId, "model", runtime))
      .filter((row) => Number.isFinite(row.count) && plausibleModelName(row.name))
      .map((row) => ({ name: canonicalModel(make, row.name), count: row.count }));

    const byName = new Map();
    for (const row of rows) byName.set(row.name, (byName.get(row.name) || 0) + row.count);
    const models = [...byName.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, count]) => ({ name, count }));
    return { models, total: models.reduce((sum, row) => sum + row.count, 0) };
  }

  // -------------------------------------------------------------------------
  // Filter verification
  // -------------------------------------------------------------------------

  /**
   * Confirm the make filter actually applied. A store that ignores URL params
   * would otherwise return unfiltered counts that look plausible and silently
   * inflate every make. Accepts either the URL keeping the param or the make
   * facet reporting the make as selected.
   */
  async function verifyMakeApplied(tabId, make) {
    return execute(
      tabId,
      (wanted) => {
        const normalize = (value) =>
          String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
        const target = normalize(wanted);
        const param = new URL(location.href).searchParams.get("make");
        if (param && normalize(param).split(",").includes(target)) return true;
        return Array.from(
          document.querySelectorAll(
            '[data-facet-group="make"] input, #make input, input[name="make" i]'
          )
        ).some((input) => input.checked && normalize(input.value) === target);
      },
      [make]
    );
  }

  /** Does this store publish an on-lot / in-transit split at all? */
  async function readStatusSplit(tabId, runtime) {
    const rows = await readFacetRows(tabId, "status", runtime, 6_000);
    const label = rows
      .map((row) => `${row.name} ${row.value}`)
      .join(" ")
      .replace(/[‐-―]/g, "-")
      .toLowerCase();
    return {
      present: rows.length > 0,
      onLot: /\b(?:on\s+(?:the\s+)?lot|in[- ]?stock|available\s+now|live)\b/.test(label),
      inTransit: /\b(?:in[- ]?transit|incoming|inbound)\b/.test(label),
    };
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
      platform: "ddc",
      helpers,
    });

    const landing = await inventoryNavigate.resolveInventoryPage({
      tabId,
      item,
      platform: "ddc",
      helpers,
      runtime,
      warnings,
      // Readiness asks only "can I filter inventory here?". It deliberately
      // does not re-prove the platform on every page: the adapter was already
      // chosen by stored platform or live sniffing, and gating each navigation
      // on a second DDC check turns one weak signal into a total failure.
      inspect: async (id) => {
        const candidate = await inventoryPageState(id);
        return { ...candidate, ready: candidate.hasControls };
      },
    });

    const srpUrl = landing.url;
    const makes = [...new Set((item.makeAllowList || []).filter(Boolean))];
    if (makes.length === 0) {
      throw new Error("Dealer.com collection requires a configured make allow-list");
    }

    const availableMakes = await readFacetRows(tabId, "make", runtime);
    const split = await readStatusSplit(tabId, runtime);
    const transitKnown = split.present && split.onLot && split.inTransit;
    if (split.present && !transitKnown) {
      warnings.push(
        "Dealer.com exposed a status facet without a public on-lot/in-transit split; transit left unresolved."
      );
    }

    const models = [];
    const makeSubtotals = [];

    for (const make of makes) {
      runtime.throwIfCancelled();

      if (
        availableMakes.length > 0 &&
        !availableMakes.some(
          (row) => row.name.localeCompare(make, undefined, { sensitivity: "accent" }) === 0
        )
      ) {
        warnings.push(
          `${make}: not offered in the current Dealer.com make facet; recorded as zero.`
        );
        makeSubtotals.push({ make, inStock: 0, inTransit: null });
        continue;
      }

      // One stateless navigation per make/status combination. Nothing to unwind
      // afterwards, and a failure on one make never corrupts the next.
      await inventoryNavigate.goto(
        tabId,
        inventoryNavigate.withParams(srpUrl, {
          make,
          status: transitKnown ? ON_LOT_STATUS : null,
        }),
        helpers,
        runtime
      );

      if (!(await verifyMakeApplied(tabId, make))) {
        warnings.push(
          `${make}: Dealer.com did not apply the make filter from the URL; skipped rather than reporting unfiltered counts.`
        );
        makeSubtotals.push({ make, inStock: 0, inTransit: null });
        continue;
      }

      const inStock = await readModelCounts(tabId, make, runtime);
      const pageTotal = (await inventoryPageState(tabId)).total;
      if (pageTotal !== null && inStock.total > 0 && Math.abs(pageTotal - inStock.total) > 2) {
        warnings.push(
          `${make}: Dealer.com model counts total ${inStock.total} against a reported ${pageTotal}; kept the model breakdown.`
        );
      }

      let inTransit = { models: [], total: 0 };
      if (transitKnown) {
        await inventoryNavigate.goto(
          tabId,
          inventoryNavigate.withParams(srpUrl, { make, status: IN_TRANSIT_STATUS }),
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
      throw new Error("Dealer.com collection produced no model rows");
    }

    const totalInStock = makeSubtotals.reduce((sum, row) => sum + row.inStock, 0);
    const allTransitKnown = makeSubtotals.every((row) => row.inTransit !== null);
    const totalInTransit = allTransitKnown
      ? makeSubtotals.reduce((sum, row) => sum + row.inTransit, 0)
      : null;
    if (totalInStock <= 0) {
      throw new Error("Dealer.com reconciled on-lot total was zero");
    }

    return {
      sourceUrl: srpUrl,
      detectedPlatform: "ddc",
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
    id: "dealer-com",
    platforms: ["ddc", "dealer.com", "dealercom", "dealerdotcom", "cox", "coxautomotive"],
    collect,
  });
})();
