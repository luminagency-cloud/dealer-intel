/* global chrome */

(() => {
  const FACETS = {
    make: ["make"],
    model: ["model", "model-family", "modelFamily"],
    status: ["status"],
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
      await runtime.sleep(250);
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

  async function navigationPoint(tabId, mode, avoidPoint = null) {
    return execute(
      tabId,
      (navigationMode, pointToAvoid) => {
        const clean = (value) =>
          String(value || "")
            .replace(/[\uE000-\uF8FF]/g, "")
            .replace(/\s+/g, " ")
            .trim();
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
          document.querySelectorAll("a, button, [role=menuitem]")
        )
          .filter((element) => {
            if (!(element instanceof HTMLElement) || !visible(element)) return false;
            if (navigationMode !== "primary") return true;
            const rect = element.getBoundingClientRect();
            return rect.top >= -20 && rect.top <= Math.min(innerHeight * 0.45, 420);
          })
          .map((element) => {
            const text = clean(
              element.innerText ||
                element.getAttribute("aria-label") ||
                element.getAttribute("title")
            );
            const href = element instanceof HTMLAnchorElement ? element.href : "";
            let score = -100;
            if (navigationMode === "primary") {
              if (/^new inventory$/i.test(text)) score = 140;
              else if (/^new vehicles?$/i.test(text)) score = 130;
              else if (/^shop new$/i.test(text)) score = 120;
              else if (/^new$/i.test(text)) score = 100;
            } else {
              if (/^view all new/i.test(text)) score = 180;
              else if (/^all new(?: inventory| vehicles?)?$/i.test(text)) score = 170;
              else if (/^new (?:[a-z0-9&-]+\s+)*(?:vehicle\s+)?inventory$/i.test(text)) score = 160;
              else if (/^new vehicles?$/i.test(text)) score = 150;
              else if (/^shop (?:all )?new/i.test(text)) score = 140;
            }
            if (/used|pre-owned|certified|special|offer|service|parts/i.test(text)) {
              score = -100;
            }
            if (/\/new-inventory\/index\.htm(?:[?#]|$)/i.test(href)) score += 80;
            else if (/\/new-inventory\//i.test(href)) score += 30;
            const rect = element.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            if (navigationMode === "primary" && rect.top < 200) score += 30;
            if (
              navigationMode === "submenu" &&
              pointToAvoid &&
              Math.hypot(x - pointToAvoid.x, y - pointToAvoid.y) < 36
            ) {
              score = -100;
            }
            return { element, text, href, score, x, y };
          })
          .filter((candidate) => candidate.score > 0)
          .sort((left, right) => right.score - left.score);
        const chosen = candidates[0];
        if (!chosen) return null;
        chosen.element.scrollIntoView({ block: "nearest", inline: "nearest" });
        chosen.element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        chosen.element.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
        return {
          x: chosen.x,
          y: chosen.y,
          text: chosen.text,
          href: chosen.href,
        };
      },
      [mode, avoidPoint]
    );
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
      const clean = (value) =>
        String(value || "")
          .replace(/[\uE000-\uF8FF]/g, "")
          .replace(/\s+/g, " ")
          .trim();
      const facet = (id) =>
        document.querySelector(`[data-facet-group="${id}"]`) ||
        document.getElementById(id);
      const modelFacet = facet("model") || facet("model-family") || facet("modelFamily");
      const provider = document.querySelector('meta[name="providerID" i]')?.getAttribute("content");
      const isDdc = /^ddc$/i.test(provider || "") || Boolean(globalThis.DDC);
      const countElements = Array.from(
        document.querySelectorAll(
          '[data-testid*="result-count" i], [data-testid*="inventory-count" i], [data-inventory-count], .inventory-count, .results-count, .result-count, .vehicle-count, [role=status], [aria-live], h1, h2'
        )
      ).filter(visible);
      const patterns = [
        /showing\s+\d+\s*[-–]\s*\d+\s+of\s+([\d,]+)/i,
        /(?:search\s+)?results?\s*\(?\s*([\d,]+)\s*\)?/i,
        /([\d,]+)\s+(?:new\s+)?vehicles?(?:\s+found|\s+available)?/i,
        /([\d,]+)\s+matches/i,
      ];
      let total = null;
      for (const element of countElements) {
        const text = clean(element.innerText || element.getAttribute("aria-label"));
        if (!text || text.length > 140) continue;
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
      const modelSignature = modelFacet
        ? Array.from(modelFacet.querySelectorAll("input, [role=checkbox]"))
            .slice(0, 80)
            .map((control) => {
              const input = control instanceof HTMLInputElement ? control : null;
              const label =
                (input?.id
                  ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`)
                  : null) || control.closest("label") || control.parentElement;
              return clean(label?.textContent || control.getAttribute("aria-label"));
            })
            .filter(Boolean)
            .join("|")
        : "";
      const busy = Array.from(
        document.querySelectorAll(
          '[aria-busy="true"], .loading, .is-loading, .spinner, [class*="loading" i]'
        )
      ).some(visible);
      return {
        url: location.href,
        ready: Boolean(modelFacet),
        isDdc,
        total,
        modelSignature,
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
        /\/new-inventory\/index\.htm(?:[?#]|$)/i.test(tab.url)
    );
    if (!child?.id || !child.url) return false;
    await chrome.tabs.remove(child.id).catch(() => {});
    await chrome.tabs.update(tabId, { url: child.url, active: true });
    await helpers.waitForTabComplete(tabId);
    return true;
  }

  async function waitForInventoryPage(tabId, helpers, runtime, timeoutMs = 12_000) {
    return runtime.waitFor(
      async () => {
        const state = await inventoryPageState(tabId);
        return state.ready && state.isDdc ? state : null;
      },
      {
        timeoutMs,
        intervalMs: 300,
        message: "Dealer.com New Inventory did not expose its model facet",
      }
    );
  }

  async function navigateToInventory(tabId, helpers, runtime, warnings) {
    await runtime.suppressPopups(tabId);
    const primary = await navigationPoint(tabId, "primary");
    if (!primary) {
      throw new Error("Dealer.com top navigation did not expose New Inventory");
    }

    await runtime.sleep(350);
    let submenu = await navigationPoint(tabId, "submenu", primary);
    if (submenu) {
      await mouseClick(tabId, submenu, runtime);
      await helpers.waitAfterInteraction(tabId, 1_200).catch(() => {});
      try {
        return await waitForInventoryPage(tabId, helpers, runtime);
      } catch {
        if (await adoptInventoryChildTab(tabId, helpers).catch(() => false)) {
          return waitForInventoryPage(tabId, helpers, runtime);
        }
      }
    }

    await mouseClick(tabId, primary, runtime);
    await helpers.waitAfterInteraction(tabId, 700).catch(() => {});
    try {
      return await waitForInventoryPage(tabId, helpers, runtime, 5_000);
    } catch {
      if (await adoptInventoryChildTab(tabId, helpers).catch(() => false)) {
        return waitForInventoryPage(tabId, helpers, runtime);
      }
    }

    submenu = await navigationPoint(tabId, "submenu", primary);
    if (submenu) {
      await mouseClick(tabId, submenu, runtime);
      await helpers.waitAfterInteraction(tabId, 1_200).catch(() => {});
      return waitForInventoryPage(tabId, helpers, runtime);
    }

    warnings.push("Dealer.com top-menu navigation did not reach /new-inventory/index.htm.");
    throw new Error("Could not reach Dealer.com New Inventory through its visible top menu");
  }

  async function openFacet(tabId, facetIds) {
    return execute(
      tabId,
      (ids) => {
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
        const container = ids
          .map(
            (id) =>
              document.querySelector(`[data-facet-group="${id}"]`) ||
              document.getElementById(id)
          )
          .find(Boolean);
        if (!(container instanceof HTMLElement)) return { found: false, opened: false };
        const controls = Array.from(
          container.querySelectorAll('input[type="checkbox"], [role="checkbox"]')
        );
        const choicesVisible = controls.some((control) => {
          if (visible(control)) return true;
          const input = control instanceof HTMLInputElement ? control : null;
          const label =
            (input?.id
              ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`)
              : null) || control.closest("label") || control.parentElement;
          return Boolean(label && visible(label));
        });
        if (!choicesVisible) {
          const trigger = container.querySelector(
            'button[aria-controls], [data-toggle="collapse"], .panel-heading button, button, [role="button"]'
          );
          if (trigger instanceof HTMLElement) {
            trigger.scrollIntoView({ block: "center" });
            trigger.click();
          }
        }
        return { found: true, opened: choicesVisible };
      },
      [facetIds]
    );
  }

  async function ensureFacetOpen(tabId, facetIds, runtime) {
    const opened = await openFacet(tabId, facetIds);
    if (!opened.found) return false;
    if (!opened.opened) await runtime.sleep(350);
    return true;
  }

  async function readFacetRows(tabId, facetIds, kind) {
    return execute(
      tabId,
      (ids, facetKind) => {
        const clean = (value) =>
          String(value || "")
            .replace(/[\uE000-\uF8FF]/g, "")
            .replace(/\s+/g, " ")
            .replace(/^([A-Za-z][A-Za-z0-9 -]+)\s+\1\b/i, "$1")
            .trim();
        const container = ids
          .map(
            (id) =>
              document.querySelector(`[data-facet-group="${id}"]`) ||
              document.getElementById(id)
          )
          .find(Boolean);
        if (!container) return [];

        const controls = Array.from(
          container.querySelectorAll(
            'input[type="checkbox"], [role="checkbox"], button[aria-label*="matched vehicles" i]'
          )
        );
        const rows = [];
        for (const control of controls) {
          const input = control instanceof HTMLInputElement ? control : null;
          const labelElement =
            (input?.id
              ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`)
              : null) || control.closest("label") || control.parentElement;
          const aria = clean(control.getAttribute("aria-label"));
          const label = clean(labelElement?.innerText || labelElement?.textContent || aria);
          const value = clean(input?.value || control.getAttribute("data-value") || "");
          const semantic = (aria || label).match(
            /^[^:]+:\s*(.+?)\.\s*([\d,]+)\s+matched vehicles?/i
          );
          const counted = (aria || label).match(
            /^(.+?)\s+\(?([\d,]+)\)?(?:\s+(?:available|vehicles?|matches?))?$/i
          );
          let name = clean(semantic?.[1] || counted?.[1] || label || value);
          const countText = semantic?.[2] || counted?.[2] || "";
          const count = countText ? Number(countText.replace(/,/g, "")) : null;
          if (
            (facetKind === "make" || facetKind === "model") &&
            value &&
            !/^(?:true|false|on|off|\d+-\d+)$/i.test(value)
          ) {
            name = value;
          }
          if (!name || /^(?:clear|all|view|apply|close)\b/i.test(name)) continue;
          const selected = input
            ? input.checked
            : control.getAttribute("aria-checked") === "true" ||
              control.getAttribute("aria-pressed") === "true" ||
              control.classList.contains("selected") ||
              control.classList.contains("active");
          rows.push({ name, value, count, selected });
        }

        const byKey = new Map();
        for (const row of rows) {
          const key = row.name.toLowerCase();
          const previous = byKey.get(key);
          if (!previous || (row.count ?? -1) > (previous.count ?? -1)) {
            byKey.set(key, row);
          }
        }
        return [...byKey.values()];
      },
      [facetIds, kind]
    );
  }

  async function clickApplyIfPresent(tabId, facetIds) {
    return execute(
      tabId,
      (ids) => {
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
        const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const container = ids
          .map(
            (id) =>
              document.querySelector(`[data-facet-group="${id}"]`) ||
              document.getElementById(id)
          )
          .find(Boolean);
        const scopes = [container, ...document.querySelectorAll('[role="dialog"], dialog')].filter(Boolean);
        for (const scope of scopes) {
          const apply = Array.from(
            scope.querySelectorAll("a, button, [role=button]")
          ).find((element) => {
            if (!visible(element)) return false;
            const label = clean(element.innerText || element.getAttribute("aria-label"));
            return /^(?:apply(?: filters?)?|view\s+[\d,]+\s+matches|view results|(?:show|see)\s+[\d,]+\s+(?:vehicles?|results?))$/i.test(label);
          });
          if (apply instanceof HTMLElement) {
            apply.click();
            return true;
          }
        }
        return false;
      },
      [facetIds]
    );
  }

  async function clickFacetOption(tabId, facetIds, kind, row, shouldSelect) {
    return execute(
      tabId,
      (ids, facetKind, requested, desired) => {
        const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const normalize = (value) => clean(value).toLowerCase();
        const container = ids
          .map(
            (id) =>
              document.querySelector(`[data-facet-group="${id}"]`) ||
              document.getElementById(id)
          )
          .find(Boolean);
        if (!container) return false;
        const controls = Array.from(
          container.querySelectorAll(
            'input[type="checkbox"], [role="checkbox"], button[aria-label*="matched vehicles" i]'
          )
        );
        for (const control of controls) {
          const input = control instanceof HTMLInputElement ? control : null;
          const labelElement =
            (input?.id
              ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`)
              : null) || control.closest("label") || control.parentElement;
          const aria = clean(control.getAttribute("aria-label"));
          const label = clean(labelElement?.innerText || labelElement?.textContent || aria);
          const semantic = (aria || label).match(/^[^:]+:\s*(.+?)\.\s*[\d,]+\s+matched vehicles?/i);
          const counted = (aria || label).match(/^(.+?)\s+\(?[\d,]+\)?(?:\s+(?:available|vehicles?|matches?))?$/i);
          const value = clean(input?.value || control.getAttribute("data-value") || "");
          let name = clean(semantic?.[1] || counted?.[1] || label || value);
          if (
            (facetKind === "make" || facetKind === "model") &&
            value &&
            !/^(?:true|false|on|off|\d+-\d+)$/i.test(value)
          ) {
            name = value;
          }
          if (
            normalize(name) !== normalize(requested.name) &&
            normalize(value) !== normalize(requested.value)
          ) {
            continue;
          }
          const selected = input
            ? input.checked
            : control.getAttribute("aria-checked") === "true" ||
              control.getAttribute("aria-pressed") === "true" ||
              control.classList.contains("selected") ||
              control.classList.contains("active");
          if (selected === desired) return true;
          const clickTarget =
            labelElement instanceof HTMLElement && labelElement !== container
              ? labelElement
              : control;
          if (!(clickTarget instanceof HTMLElement)) return false;
          clickTarget.scrollIntoView({ block: "center" });
          clickTarget.click();
          return true;
        }
        return false;
      },
      [facetIds, kind, row, Boolean(shouldSelect)]
    );
  }

  async function toggleFacetOption(
    tabId,
    facetIds,
    kind,
    row,
    shouldSelect,
    runtime
  ) {
    await ensureFacetOpen(tabId, facetIds, runtime);
    const before = await inventoryPageState(tabId);
    const clicked = await clickFacetOption(
      tabId,
      facetIds,
      kind,
      row,
      shouldSelect
    );
    if (!clicked) return false;
    await clickApplyIfPresent(tabId, facetIds);

    await runtime.waitFor(
      async () => {
        const [state, rows] = await Promise.all([
          inventoryPageState(tabId),
          readFacetRows(tabId, facetIds, kind),
        ]);
        const target = rows.find(
          (candidate) =>
            candidate.name.toLowerCase() === row.name.toLowerCase() ||
            (row.value && candidate.value.toLowerCase() === row.value.toLowerCase())
        );
        if (!target || Boolean(target.selected) !== Boolean(shouldSelect) || state.busy) {
          return null;
        }
        const changed =
          state.url !== before.url ||
          state.total !== before.total ||
          state.modelSignature !== before.modelSignature ||
          Boolean(target.selected) !== Boolean(row.selected);
        return changed ? state : null;
      },
      {
        timeoutMs: 10_000,
        intervalMs: 250,
        message: `Dealer.com did not settle after changing ${kind} ${row.name}`,
      }
    );
    await runtime.sleep(450);
    return true;
  }

  async function setExclusiveFacet(tabId, kind, target, shouldSelect, runtime) {
    const facetIds = FACETS[kind];
    if (!(await ensureFacetOpen(tabId, facetIds, runtime))) return false;
    return runtime.selectExclusive({
      target,
      shouldSelect,
      readOptions: () => readFacetRows(tabId, facetIds, kind),
      toggle: (row, desired) =>
        toggleFacetOption(tabId, facetIds, kind, row, desired, runtime),
    });
  }

  function plausibleModelName(name) {
    const normalized = String(name || "").replace(/\s+/g, " ").trim();
    if (!normalized || normalized.length > 80) return false;
    if (/\b(?:sales|service|parts|directions|contact|results?|matches|vehicles?|inventory|stock:)\b/i.test(normalized)) {
      return false;
    }
    if (/\b(?:road|rd\.?|street|st\.?|avenue|ave\.?|lane|ln\.?|boulevard|blvd\.?|drive|dr\.?|highway|hwy\.?)\b.*[,•]/i.test(normalized)) {
      return false;
    }
    return /[A-Za-z0-9]/.test(normalized);
  }

  function canonicalModel(make, model) {
    const cleaned = String(model || "").replace(/\s+/g, " ").trim();
    if (/^ram$/i.test(make) && !/^ram\b/i.test(cleaned)) {
      return `Ram ${cleaned}`;
    }
    return cleaned;
  }

  async function readReconciledModels(tabId, make, runtime) {
    if (!(await ensureFacetOpen(tabId, FACETS.model, runtime))) {
      throw new Error(`${make}: Dealer.com did not expose its Model facet`);
    }
    const rows = await runtime.waitFor(
      async () => {
        const values = (await readFacetRows(tabId, FACETS.model, "model"))
          .filter((row) => Number.isFinite(row.count) && plausibleModelName(row.name))
          .map((row) => ({
            name: canonicalModel(make, row.name),
            count: row.count,
          }));
        return values.length > 0 ? values : null;
      },
      {
        timeoutMs: 8_000,
        intervalMs: 300,
        message: `${make}: Dealer.com Model opened without count rows`,
      }
    );
    const byName = new Map();
    for (const row of rows) {
      byName.set(row.name, (byName.get(row.name) || 0) + row.count);
    }
    const models = [...byName.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, count]) => ({ name, count }));
    const modelTotal = models.reduce((sum, row) => sum + row.count, 0);
    const state = await inventoryPageState(tabId);
    if (state.total !== null && Math.abs(state.total - modelTotal) > 2) {
      throw new Error(
        `${make}: Dealer.com Model counts total ${modelTotal}, but the result count is ${state.total}`
      );
    }
    return { models, total: modelTotal, visibleTotal: state.total };
  }

  function classifyStatus(row) {
    const value = String(row.value || "").toLowerCase();
    const label = String(row.name || "")
      .replace(/[\u2010-\u2015]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    if (value === "1-1" || /\b(?:on\s+(?:the\s+)?lot|in[- ]?stock|at\s+(?:the\s+)?dealer|available\s+now)\b/.test(label)) {
      return "inStock";
    }
    if (value === "7-7" || /\b(?:in[- ]?transit|incoming|inbound)\b/.test(label)) {
      return "inTransit";
    }
    if (/\b(?:being\s+built|in\s+production|on\s+order|factory\s+order|dealer\s+ordered)\b/.test(label)) {
      return "excluded";
    }
    return null;
  }

  async function statusFacet(tabId, runtime) {
    if (!(await ensureFacetOpen(tabId, FACETS.status, runtime))) return null;
    const rows = await readFacetRows(tabId, FACETS.status, "status");
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
        throw new Error(`${make}: Dealer.com exposed transit without an on-lot status`);
      }
      if (facet && facet.excluded.length > 0) {
        warnings.push(
          `${make}: Dealer.com exposed build/order statuses without a public on-lot split; transit remains unknown.`
        );
      }
      const combined = await readReconciledModels(tabId, make, runtime);
      return {
        models: mergeStatusModels(make, combined.models, [], false),
        subtotal: { make, inStock: combined.total, inTransit: null },
      };
    }

    if (!(await setExclusiveFacet(tabId, "status", facet.inStock.value || facet.inStock.name, true, runtime))) {
      throw new Error(`${make}: could not select Dealer.com on-lot status ${facet.inStock.name}`);
    }
    const inStock = await readReconciledModels(tabId, make, runtime);
    let inTransit = { models: [], total: 0 };
    let transitKnown = false;

    if (facet.inTransit) {
      if (!(await setExclusiveFacet(tabId, "status", facet.inTransit.value || facet.inTransit.name, true, runtime))) {
        throw new Error(`${make}: could not select Dealer.com transit status ${facet.inTransit.name}`);
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
    await navigateToInventory(tabId, helpers, runtime, warnings);
    await runtime.suppressPopups(tabId);

    const state = await inventoryPageState(tabId);
    if (!state.ready || !state.isDdc) {
      throw new Error("The configured Dealer.com site did not expose Dealer.com inventory controls");
    }

    const makes = [...new Set((item.makeAllowList || []).filter(Boolean))];
    if (makes.length === 0) {
      throw new Error("Dealer.com collection requires a configured make allow-list");
    }
    const hasMakeFacet = await ensureFacetOpen(tabId, FACETS.make, runtime);
    if (!hasMakeFacet && makes.length > 1) {
      throw new Error("Multi-brand Dealer.com inventory did not expose its Make facet");
    }
    const availableMakes = hasMakeFacet
      ? await readFacetRows(tabId, FACETS.make, "make")
      : [];
    if (hasMakeFacet && availableMakes.length === 0) {
      throw new Error("Dealer.com Make opened without visible choices");
    }

    const models = [];
    const makeSubtotals = [];
    for (const make of makes) {
      runtime.throwIfCancelled();
      if (hasMakeFacet) {
        const option = availableMakes.find(
          (row) => row.name.localeCompare(make, undefined, { sensitivity: "accent" }) === 0
        );
        if (!option) {
          warnings.push(`${make}: not present in the current Dealer.com Make facet; recorded as zero.`);
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
          throw new Error(`${make}: could not verify it as the only selected Dealer.com Make`);
        }
      }

      const collected = await collectMake(tabId, make, runtime, warnings);
      models.push(...collected.models);
      makeSubtotals.push(collected.subtotal);

      if (hasMakeFacet) {
        await setExclusiveFacet(tabId, "make", make, false, runtime).catch(() => false);
      }
    }

    if (models.length === 0) {
      throw new Error("Dealer.com collection produced no reconciled model rows");
    }
    assertInternalReconciliation(makeSubtotals, models);
    const totalInStock = makeSubtotals.reduce((sum, row) => sum + row.inStock, 0);
    const transitKnown = makeSubtotals.every((row) => row.inTransit !== null);
    const totalInTransit = transitKnown
      ? makeSubtotals.reduce((sum, row) => sum + row.inTransit, 0)
      : null;
    if (totalInStock <= 0) {
      throw new Error("Dealer.com reconciled on-lot total was zero");
    }
    const metadata = await execute(tabId, () => ({ sourceUrl: location.href }));
    return {
      sourceUrl: metadata.sourceUrl,
      detectedPlatform: "ddc",
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
    id: "dealer-com",
    platforms: ["ddc", "dealer.com", "dealercom"],
    collect,
  });
})();
