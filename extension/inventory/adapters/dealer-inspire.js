/* global chrome */

(() => {
  const FACETS = {
    make: {
      attributes: ["make"],
      trigger: /^(?:vehicle\s+)?make$/i,
      dialog: /select\s+make/i,
    },
    model: {
      attributes: ["model"],
      trigger: /^(?:vehicle\s+)?model$/i,
      dialog: /select\s+model/i,
    },
    status: {
      attributes: ["availability", "in_transit_filter"],
      trigger: /^(?:information\s+)?(?:vehicle\s+)?status$|^availability$/i,
      dialog: /select\s+(?:availability|vehicle\s+status)/i,
    },
  };

  async function execute(tabId, func, args = []) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func,
      args,
    });
    return result;
  }

  async function mouseClick(tabId, point, runtime) {
    if (!point) return false;
    runtime.throwIfCancelled();
    let attached = false;
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
      attached = true;
      await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: point.x,
        y: point.y,
      });
      await runtime.sleep(200);
      await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: point.x,
        y: point.y,
        button: "left",
        clickCount: 1,
      });
      await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: point.x,
        y: point.y,
        button: "left",
        clickCount: 1,
      });
      return true;
    } finally {
      if (attached) await chrome.debugger.detach({ tabId }).catch(() => {});
    }
  }

  async function inventoryNavigationPoint(tabId) {
    return execute(tabId, () => {
      const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return (
          rect.width > 10 &&
          rect.height > 10 &&
          style.display !== "none" &&
          style.visibility !== "hidden"
        );
      };
      const candidates = Array.from(
        document.querySelectorAll("a[href], button, [role=menuitem]")
      )
        .filter((element) => element instanceof HTMLElement && visible(element))
        .map((element) => {
          const text = clean(
            element.innerText ||
              element.getAttribute("aria-label") ||
              element.getAttribute("title")
          );
          const href = element instanceof HTMLAnchorElement ? element.href : "";
          let score = -100;
          if (/^new vehicles?$/i.test(text)) score = 180;
          else if (/^new inventory$/i.test(text)) score = 170;
          else if (/^view all new$/i.test(text)) score = 160;
          else if (/^shop(?: new)?$/i.test(text)) score = 150;
          else if (/^new$/i.test(text)) score = 130;
          if (/\/new-vehicles\/(?:[?#]|$)/i.test(href)) score += 120;
          else if (/\/new-vehicles\//i.test(href)) score += 40;
          if (/used|pre-owned|certified|special|offer|service|parts/i.test(text)) {
            score = -100;
          }
          const rect = element.getBoundingClientRect();
          if (rect.top >= -20 && rect.top <= Math.min(innerHeight * 0.5, 460)) {
            score += 30;
          }
          return {
            element,
            text,
            href,
            score,
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          };
        })
        .filter((candidate) => candidate.score > 0)
        .sort((left, right) => right.score - left.score);
      const chosen = candidates[0];
      if (!chosen) return null;
      chosen.element.scrollIntoView({ block: "nearest", inline: "nearest" });
      chosen.element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      return {
        x: chosen.x,
        y: chosen.y,
        text: chosen.text,
        href: chosen.href,
      };
    });
  }

  async function inventoryPageState(tabId) {
    return execute(tabId, () => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden"
        );
      };
      const hasVehicles = Boolean(document.querySelector("[data-vehicle]"));
      const hasModelFacet = Boolean(
        document.querySelector('[data-facettype="model"], [data-facet="model"]')
      );
      const isDealerInspire = Boolean(
        globalThis.LightningVRP ||
          (hasVehicles && document.querySelector("[data-facettype], [data-facet]"))
      );
      const busy = Array.from(
        document.querySelectorAll(
          '[aria-busy="true"], .loading, .is-loading, .spinner, [class*="loading" i]'
        )
      ).some(visible);
      return {
        url: location.href,
        ready: hasVehicles && hasModelFacet,
        isDealerInspire,
        busy,
      };
    });
  }

  async function adoptInventoryChildTab(tabId, helpers) {
    const tabs = await chrome.tabs.query({});
    const child = tabs.find(
      (tab) =>
        tab.id !== undefined &&
        tab.openerTabId === tabId &&
        typeof tab.url === "string" &&
        /\/new-vehicles\/(?:[?#]|$)/i.test(tab.url)
    );
    if (!child?.id || !child.url) return false;
    await chrome.tabs.remove(child.id).catch(() => {});
    await chrome.tabs.update(tabId, { url: child.url, active: true });
    await helpers.waitForTabComplete(tabId);
    return true;
  }

  async function waitForInventoryPage(tabId, runtime, timeoutMs = 15_000) {
    return runtime.waitFor(
      async () => {
        const state = await inventoryPageState(tabId);
        return state.ready && state.isDealerInspire ? state : null;
      },
      {
        timeoutMs,
        intervalMs: 300,
        message: "Dealer Inspire New Vehicles did not expose LightningVRP filters",
      }
    );
  }

  async function navigateToInventory(tabId, helpers, runtime) {
    const initial = await inventoryPageState(tabId);
    if (initial.ready && initial.isDealerInspire) return initial;

    await runtime.suppressPopups(tabId);
    const point = await inventoryNavigationPoint(tabId);
    if (!point) {
      throw new Error("Dealer Inspire top navigation did not expose New Vehicles");
    }
    await mouseClick(tabId, point, runtime);
    await helpers.waitAfterInteraction(tabId, 1_000).catch(() => {});
    try {
      return await waitForInventoryPage(tabId, runtime);
    } catch {
      if (await adoptInventoryChildTab(tabId, helpers).catch(() => false)) {
        return waitForInventoryPage(tabId, runtime);
      }
      throw new Error(
        `Dealer Inspire ${point.text || "New Vehicles"} navigation did not reach LightningVRP inventory`
      );
    }
  }

  async function openFacet(tabId, kind) {
    return execute(
      tabId,
      (facetKind, config) => {
        const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const visible = (element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden"
          );
        };
        const dialogs = Array.from(
          document.querySelectorAll('[role="dialog"], dialog')
        ).filter((element) => element instanceof HTMLElement && visible(element));
        const alreadyOpen = dialogs.find((dialog) => {
          const text = clean(dialog.innerText);
          const rows = Array.from(dialog.querySelectorAll("[data-facet]"));
          return (
            new RegExp(config.dialog, "i").test(text) &&
            rows.some((row) => {
              const facet = clean(row.getAttribute("data-facet")).toLowerCase();
              return config.attributes.includes(facet);
            })
          );
        });
        if (alreadyOpen) return { found: true, opened: true };

        const triggers = Array.from(document.querySelectorAll("[data-facettype]"))
          .filter((element) => element instanceof HTMLElement && visible(element))
          .map((element) => {
            const attribute = clean(element.getAttribute("data-facettype")).toLowerCase();
            const label = clean(
              element.innerText ||
                element.getAttribute("aria-label") ||
                element.getAttribute("title")
            );
            let score = config.attributes.includes(attribute) ? 200 : 0;
            if (new RegExp(config.trigger, "i").test(label)) score += 100;
            if (element.closest("#lvrp-filters-column")) score += 20;
            return { element, score };
          })
          .filter((candidate) => candidate.score > 0)
          .sort((left, right) => right.score - left.score);
        const trigger = triggers[0]?.element;
        if (!(trigger instanceof HTMLElement)) {
          return { found: false, opened: false, kind: facetKind };
        }
        trigger.scrollIntoView({ block: "center", inline: "nearest" });
        trigger.click();
        return { found: true, opened: false };
      },
      [
        kind,
        {
          attributes: FACETS[kind].attributes,
          trigger: FACETS[kind].trigger.source,
          dialog: FACETS[kind].dialog.source,
        },
      ]
    );
  }

  async function ensureFacetOpen(tabId, kind, runtime) {
    const opened = await openFacet(tabId, kind);
    if (!opened.found) return false;
    if (!opened.opened) await runtime.sleep(350);
    return runtime.waitFor(
      async () => {
        const rows = await readFacetRows(tabId, kind);
        return rows.length > 0 ? true : null;
      },
      {
        timeoutMs: 5_000,
        intervalMs: 200,
        message: `Dealer Inspire ${kind} filter did not open`,
      }
    );
  }

  async function readFacetRows(tabId, kind) {
    return execute(
      tabId,
      (config) => {
        const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const normalize = (value) => clean(value).toLowerCase();
        const visible = (element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden"
          );
        };
        const dialog = Array.from(
          document.querySelectorAll('[role="dialog"], dialog')
        ).find(
          (element) =>
            element instanceof HTMLElement &&
            visible(element) &&
            new RegExp(config.dialog, "i").test(clean(element.innerText))
        );
        if (!(dialog instanceof HTMLElement)) return [];

        const refinements = Array.from(new URL(location.href).searchParams.entries());
        const rows = [];
        for (const element of dialog.querySelectorAll("[data-facet]")) {
          if (!(element instanceof HTMLElement) || !visible(element)) continue;
          const facet = clean(element.getAttribute("data-facet")).toLowerCase();
          if (!config.attributes.includes(facet)) continue;
          const value = clean(element.getAttribute("data-value"));
          const name = clean(
            element.querySelector(".facet__details--name")?.textContent ||
              value ||
              element.innerText.replace(/\s+[\d,]+\s+available.*$/i, "")
          );
          const countText = clean(
            element.querySelector(".facet__details--count")?.textContent ||
              element.innerText
          );
          const countMatch = countText.match(/([\d,]+)\s+available\b/i);
          const count = countMatch
            ? Number(countMatch[1].replace(/,/g, ""))
            : null;
          const check = element.querySelector('input[type="checkbox"], [role="checkbox"]');
          const classText = `${element.className || ""} ${
            element.parentElement?.className || ""
          }`;
          const selectedByUrl = refinements.some(([key, selectedValue]) => {
            const normalizedKey = normalize(key);
            return (
              normalizedKey.includes(facet) &&
              normalize(selectedValue) === normalize(value || name)
            );
          });
          const selected = Boolean(
            selectedByUrl ||
              (check instanceof HTMLInputElement && check.checked) ||
              check?.getAttribute("aria-checked") === "true" ||
              element.getAttribute("aria-selected") === "true" ||
              element.getAttribute("aria-pressed") === "true" ||
              /(?:^|\s)(?:active|selected|checked|is-active|is-selected)(?:\s|$)/i.test(
                classText
              )
          );
          if (name && Number.isFinite(count)) {
            rows.push({ name, value: value || name, count, selected, facet });
          }
        }
        const byKey = new Map();
        for (const row of rows) {
          const key = normalize(row.value || row.name);
          const previous = byKey.get(key);
          if (!previous || row.count > previous.count) byKey.set(key, row);
        }
        return [...byKey.values()];
      },
      [
        {
          attributes: FACETS[kind].attributes,
          dialog: FACETS[kind].dialog.source,
        },
      ]
    );
  }

  async function readDialogCount(tabId, kind) {
    return execute(
      tabId,
      (dialogPattern) => {
        const visible = (element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden"
          );
        };
        const dialog = Array.from(
          document.querySelectorAll('[role="dialog"], dialog')
        ).find(
          (element) =>
            element instanceof HTMLElement &&
            visible(element) &&
            new RegExp(dialogPattern, "i").test(element.innerText || "")
        );
        if (!(dialog instanceof HTMLElement)) return null;
        const apply = Array.from(
          dialog.querySelectorAll("a, button, [role=button]")
        ).find((element) => /view\s+[\d,]+\s+matches/i.test(element.innerText || ""));
        const match = (apply?.innerText || dialog.innerText || "").match(
          /view\s+([\d,]+)\s+matches/i
        );
        return match ? Number(match[1].replace(/,/g, "")) : null;
      },
      [FACETS[kind].dialog.source]
    );
  }

  async function clickDialogApply(tabId, kind) {
    return execute(
      tabId,
      (dialogPattern) => {
        const visible = (element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden"
          );
        };
        const dialog = Array.from(
          document.querySelectorAll('[role="dialog"], dialog')
        ).find(
          (element) =>
            element instanceof HTMLElement &&
            visible(element) &&
            new RegExp(dialogPattern, "i").test(element.innerText || "")
        );
        if (!(dialog instanceof HTMLElement)) return false;
        const apply = Array.from(
          dialog.querySelectorAll("a, button, [role=button]")
        ).find(
          (element) =>
            element instanceof HTMLElement &&
            visible(element) &&
            /^view\s+[\d,]+\s+matches$/i.test(
              String(element.innerText || "").replace(/\s+/g, " ").trim()
            )
        );
        if (!(apply instanceof HTMLElement)) return false;
        apply.click();
        return true;
      },
      [FACETS[kind].dialog.source]
    );
  }

  async function clickFacetOption(tabId, kind, row, shouldSelect) {
    return execute(
      tabId,
      (config, requested, desired) => {
        const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const normalize = (value) => clean(value).toLowerCase();
        const visible = (element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden"
          );
        };
        const dialog = Array.from(
          document.querySelectorAll('[role="dialog"], dialog')
        ).find(
          (element) =>
            element instanceof HTMLElement &&
            visible(element) &&
            new RegExp(config.dialog, "i").test(element.innerText || "")
        );
        if (!(dialog instanceof HTMLElement)) return false;
        const refinements = Array.from(new URL(location.href).searchParams.entries());
        for (const element of dialog.querySelectorAll("[data-facet]")) {
          if (!(element instanceof HTMLElement) || !visible(element)) continue;
          const facet = clean(element.getAttribute("data-facet")).toLowerCase();
          if (!config.attributes.includes(facet)) continue;
          const value = clean(element.getAttribute("data-value"));
          const name = clean(
            element.querySelector(".facet__details--name")?.textContent ||
              value ||
              element.innerText.replace(/\s+[\d,]+\s+available.*$/i, "")
          );
          if (
            normalize(name) !== normalize(requested.name) &&
            normalize(value) !== normalize(requested.value)
          ) {
            continue;
          }
          const selected = refinements.some(
            ([key, selectedValue]) =>
              normalize(key).includes(facet) &&
              normalize(selectedValue) === normalize(value || name)
          );
          if (selected === desired) return true;
          element.scrollIntoView({ block: "center", inline: "nearest" });
          element.click();
          return true;
        }
        return false;
      },
      [
        {
          attributes: FACETS[kind].attributes,
          dialog: FACETS[kind].dialog.source,
        },
        row,
        Boolean(shouldSelect),
      ]
    );
  }

  async function readOpenFacetRows(tabId, kind, runtime) {
    if (!(await ensureFacetOpen(tabId, kind, runtime))) return [];
    return readFacetRows(tabId, kind);
  }

  async function toggleFacetOption(tabId, kind, row, shouldSelect, runtime) {
    if (!(await ensureFacetOpen(tabId, kind, runtime))) return false;
    const before = await inventoryPageState(tabId);
    const clicked = await clickFacetOption(tabId, kind, row, shouldSelect);
    if (!clicked) return false;

    await runtime.waitFor(
      async () => {
        const rows = await readFacetRows(tabId, kind);
        const target = rows.find(
          (candidate) =>
            candidate.name.toLowerCase() === row.name.toLowerCase() ||
            candidate.value.toLowerCase() === row.value.toLowerCase()
        );
        return target && Boolean(target.selected) === Boolean(shouldSelect)
          ? target
          : null;
      },
      {
        timeoutMs: 7_000,
        intervalMs: 200,
        message: `Dealer Inspire did not register ${kind} ${row.name}`,
      }
    );

    if (!(await clickDialogApply(tabId, kind))) {
      throw new Error(`Dealer Inspire ${kind} dialog did not expose View Matches`);
    }
    await runtime.waitFor(
      async () => {
        const state = await inventoryPageState(tabId);
        const dialogCount = await readDialogCount(tabId, kind);
        if (state.busy || dialogCount !== null) return null;
        return state.url !== before.url || Boolean(row.selected) !== Boolean(shouldSelect)
          ? state
          : null;
      },
      {
        timeoutMs: 10_000,
        intervalMs: 250,
        message: `Dealer Inspire did not settle after changing ${kind} ${row.name}`,
      }
    );
    await runtime.sleep(350);
    return true;
  }

  async function setExclusiveFacet(tabId, kind, target, shouldSelect, runtime) {
    if (!(await ensureFacetOpen(tabId, kind, runtime))) return false;
    return runtime.selectExclusive({
      target,
      shouldSelect,
      readOptions: () => readOpenFacetRows(tabId, kind, runtime),
      toggle: (row, desired) =>
        toggleFacetOption(tabId, kind, row, desired, runtime),
    });
  }

  async function closeFacet(tabId, kind, runtime) {
    if (await clickDialogApply(tabId, kind)) {
      await runtime.waitFor(
        async () => ((await readDialogCount(tabId, kind)) === null ? true : null),
        {
          timeoutMs: 5_000,
          intervalMs: 200,
          message: `Dealer Inspire ${kind} dialog did not close`,
        }
      );
    }
  }

  function plausibleModelName(name) {
    const normalized = String(name || "").replace(/\s+/g, " ").trim();
    if (!normalized || normalized.length > 80) return false;
    if (/\b(?:sales|service|parts|directions|contact|results?|matches|vehicles?|inventory|stock:)\b/i.test(normalized)) {
      return false;
    }
    return /[A-Za-z0-9]/.test(normalized);
  }

  function canonicalModel(make, model) {
    const cleaned = String(model || "").replace(/\s+/g, " ").trim();
    if (/^ram$/i.test(make) && !/^ram\b/i.test(cleaned)) return `Ram ${cleaned}`;
    return cleaned;
  }

  async function readReconciledModels(tabId, make, runtime) {
    if (!(await ensureFacetOpen(tabId, "model", runtime))) {
      throw new Error(`${make}: Dealer Inspire did not expose its Model filter`);
    }
    const snapshot = await runtime.waitFor(
      async () => {
        const [rows, visibleTotal] = await Promise.all([
          readFacetRows(tabId, "model"),
          readDialogCount(tabId, "model"),
        ]);
        const values = rows
          .filter((row) => Number.isFinite(row.count) && plausibleModelName(row.name))
          .map((row) => ({
            name: canonicalModel(make, row.value || row.name),
            count: row.count,
          }));
        return values.length > 0 && visibleTotal !== null
          ? { values, visibleTotal }
          : null;
      },
      {
        timeoutMs: 8_000,
        intervalMs: 250,
        message: `${make}: Dealer Inspire Model opened without counted rows and View Matches`,
      }
    );
    const byName = new Map();
    for (const row of snapshot.values) {
      byName.set(row.name, Math.max(byName.get(row.name) || 0, row.count));
    }
    const models = [...byName.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, count]) => ({ name, count }));
    const modelTotal = models.reduce((sum, row) => sum + row.count, 0);
    await closeFacet(tabId, "model", runtime);
    if (Math.abs(snapshot.visibleTotal - modelTotal) > 2) {
      throw new Error(
        `${make}: Dealer Inspire Model counts total ${modelTotal}, but View Matches reports ${snapshot.visibleTotal}`
      );
    }
    return { models, total: modelTotal, visibleTotal: snapshot.visibleTotal };
  }

  function classifyStatus(row) {
    const label = `${row.name} ${row.value}`
      .replace(/[\u2010-\u2015]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    if (/\b(?:on\s+(?:the\s+)?lot|in[- ]?stock|available\s+now)\b/.test(label)) {
      return "inStock";
    }
    if (/\b(?:in[- ]?transit|incoming|inbound)\b/.test(label)) {
      return "inTransit";
    }
    if (/\b(?:being\s+built|in\s+production|on\s+order|factory\s+order)\b/.test(label)) {
      return "excluded";
    }
    return null;
  }

  async function statusFacet(tabId, runtime) {
    try {
      if (!(await ensureFacetOpen(tabId, "status", runtime))) return null;
    } catch {
      return null;
    }
    const rows = await readFacetRows(tabId, "status");
    const classified = rows.map((row) => ({ ...row, kind: classifyStatus(row) }));
    return {
      inStock: classified.find((row) => row.kind === "inStock") || null,
      inTransit: classified.find((row) => row.kind === "inTransit") || null,
      excluded: classified.filter((row) => row.kind === "excluded"),
    };
  }

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

  async function collectMake(tabId, make, runtime, warnings) {
    const facet = await statusFacet(tabId, runtime);
    if (!facet?.inStock) {
      if (facet?.inTransit) {
        throw new Error(`${make}: Dealer Inspire exposed transit without an on-lot status`);
      }
      if (facet?.excluded.length) {
        warnings.push(
          `${make}: Dealer Inspire exposed build/order statuses without a public on-lot split; transit remains unknown.`
        );
      }
      await closeFacet(tabId, "status", runtime).catch(() => {});
      const combined = await readReconciledModels(tabId, make, runtime);
      return {
        models: mergeStatusModels(make, combined.models, [], false),
        subtotal: { make, inStock: combined.total, inTransit: null },
      };
    }

    if (
      !(await setExclusiveFacet(
        tabId,
        "status",
        facet.inStock.value || facet.inStock.name,
        true,
        runtime
      ))
    ) {
      throw new Error(`${make}: could not select Dealer Inspire ${facet.inStock.name}`);
    }
    const inStock = await readReconciledModels(tabId, make, runtime);
    let inTransit = { models: [], total: 0 };
    let transitKnown = false;

    if (facet.inTransit) {
      if (
        !(await setExclusiveFacet(
          tabId,
          "status",
          facet.inTransit.value || facet.inTransit.name,
          true,
          runtime
        ))
      ) {
        throw new Error(`${make}: could not select Dealer Inspire ${facet.inTransit.name}`);
      }
      inTransit = await readReconciledModels(tabId, make, runtime);
      transitKnown = true;
    }

    const active = facet.inTransit || facet.inStock;
    await setExclusiveFacet(
      tabId,
      "status",
      active.value || active.name,
      false,
      runtime
    ).catch(() => false);
    return {
      models: mergeStatusModels(make, inStock.models, inTransit.models, transitKnown),
      subtotal: {
        make,
        inStock: inStock.total,
        inTransit: transitKnown ? inTransit.total : null,
      },
    };
  }

  function assertInternalReconciliation(makeSubtotals, models) {
    for (const subtotal of makeSubtotals) {
      const makeModels = models.filter((row) => row.make === subtotal.make);
      const inStock = makeModels.reduce((sum, row) => sum + (row.inStock || 0), 0);
      const inTransit = makeModels.reduce((sum, row) => sum + (row.inTransit || 0), 0);
      if (inStock !== subtotal.inStock) {
        throw new Error(
          `${subtotal.make}: model on-lot counts ${inStock} do not reconcile to make subtotal ${subtotal.inStock}`
        );
      }
      if (subtotal.inTransit !== null && inTransit !== subtotal.inTransit) {
        throw new Error(
          `${subtotal.make}: model transit counts ${inTransit} do not reconcile to make subtotal ${subtotal.inTransit}`
        );
      }
    }
  }

  async function collect({ item, helpers, runtime }) {
    const warnings = [];
    const { tabId } = await helpers.ensureSiteSession(item);
    await navigateToInventory(tabId, helpers, runtime);
    await runtime.suppressPopups(tabId);

    const state = await inventoryPageState(tabId);
    if (!state.ready || !state.isDealerInspire) {
      throw new Error(
        "The configured Dealer Inspire site did not expose LightningVRP inventory controls"
      );
    }

    const makes = [...new Set((item.makeAllowList || []).filter(Boolean))];
    if (makes.length === 0) {
      throw new Error("Dealer Inspire collection requires a configured make allow-list");
    }
    const hasMakeFacet = await ensureFacetOpen(tabId, "make", runtime).catch(
      () => false
    );
    if (!hasMakeFacet && makes.length > 1) {
      throw new Error("Multi-brand Dealer Inspire inventory did not expose its Make filter");
    }
    const availableMakes = hasMakeFacet ? await readFacetRows(tabId, "make") : [];
    if (hasMakeFacet && availableMakes.length === 0) {
      throw new Error("Dealer Inspire Make opened without counted choices");
    }

    const models = [];
    const makeSubtotals = [];
    for (const make of makes) {
      runtime.throwIfCancelled();
      if (hasMakeFacet) {
        const option = availableMakes.find(
          (row) =>
            row.name.localeCompare(make, undefined, { sensitivity: "accent" }) === 0 ||
            row.value.localeCompare(make, undefined, { sensitivity: "accent" }) === 0
        );
        if (!option) {
          warnings.push(
            `${make}: not present in the current Dealer Inspire Make filter; recorded as zero.`
          );
          makeSubtotals.push({ make, inStock: 0, inTransit: null });
          continue;
        }
        const selected = await setExclusiveFacet(
          tabId,
          "make",
          option.value || option.name,
          true,
          runtime
        );
        if (!selected) {
          throw new Error(
            `${make}: could not verify it as the only selected Dealer Inspire Make`
          );
        }
      }

      const collected = await collectMake(tabId, make, runtime, warnings);
      models.push(...collected.models);
      makeSubtotals.push(collected.subtotal);

      if (hasMakeFacet) {
        await setExclusiveFacet(tabId, "make", make, false, runtime).catch(
          () => false
        );
      }
    }

    if (models.length === 0) {
      throw new Error("Dealer Inspire collection produced no reconciled model rows");
    }
    assertInternalReconciliation(makeSubtotals, models);
    const totalInStock = makeSubtotals.reduce((sum, row) => sum + row.inStock, 0);
    const transitKnown = makeSubtotals.every((row) => row.inTransit !== null);
    const totalInTransit = transitKnown
      ? makeSubtotals.reduce((sum, row) => sum + row.inTransit, 0)
      : null;
    if (totalInStock <= 0) {
      throw new Error("Dealer Inspire reconciled on-lot total was zero");
    }
    const metadata = await execute(tabId, () => ({ sourceUrl: location.href }));
    return {
      sourceUrl: metadata.sourceUrl,
      detectedPlatform: "dealer_inspire",
      totals: {
        inStock: totalInStock,
        inTransit: totalInTransit,
        displayValue:
          totalInTransit === null
            ? String(totalInStock)
            : `${totalInStock}/${totalInTransit}*`,
      },
      makeSubtotals,
      models,
      warnings,
    };
  }

  globalThis.inventoryPlatformAdapters ||= [];
  globalThis.inventoryPlatformAdapters.push({
    id: "dealer-inspire",
    platforms: ["dealer_inspire", "dealer-inspire", "dealerinspire"],
    collect,
  });
})();
