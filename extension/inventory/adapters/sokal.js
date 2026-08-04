/* global inventoryNavigate, inventoryTally */

/**
 * Sokal inventory.
 *
 * Sokal stores sit behind DataDome. A headless or datacentre request gets an
 * interstitial instead of the SRP, which is the main reason this platform
 * never worked from the server-side collector. Visible Chrome is the right
 * place for it: the window is on the operator's screen, so a challenge can be
 * cleared by a human and collection continues. This adapter therefore waits
 * for the interstitial to clear rather than failing on sight, and when it does
 * give up it says exactly what to do.
 *
 * Sokal publishes no on-lot/in-transit split, so transit is reported as
 * unresolved rather than as a zero we did not observe.
 *
 * Reading is tiered, most trustworthy first:
 *
 *   1. a model refinement list, located by its "Model" heading
 *   2. the model teaser strip ("Sportage 12 available")
 *   3. the "Model ... Trim" text block with parenthetical counts
 *
 * Tiers 2 and 3 read prose rather than structure, so results that come from
 * them carry a warning into the stored record.
 */
(() => {
  // The operator can see this window. Give a human time to clear a challenge
  // before burning the dealer's attempt.
  const CHALLENGE_CLEAR_TIMEOUT_MS = 45_000;

  const execute = (tabId, func, args) => inventoryNavigate.execute(tabId, func, args);

  // -------------------------------------------------------------------------
  // Bot challenge
  // -------------------------------------------------------------------------

  async function readChallengeState(tabId) {
    return execute(tabId, () => {
      const html = document.documentElement?.outerHTML || "";
      const text = `${document.title || ""}\n${document.body?.innerText || ""}`;
      return {
        url: location.href,
        challenged:
          /captcha-delivery\.com|datadome|please enable js and disable any ad blocker/i.test(
            html
          ) ||
          /attention required|verify you are human|complete the captcha|security check|request blocked/i.test(
            text
          ),
      };
    });
  }

  /**
   * Poll until the interstitial is gone. Returns true if the operator (or the
   * challenge itself) cleared it, false if it is still up when time runs out.
   */
  async function waitForChallengeToClear(tabId, runtime) {
    const cleared = await runtime
      .waitFor(
        async () => {
          const state = await readChallengeState(tabId);
          return state.challenged ? null : state;
        },
        {
          timeoutMs: CHALLENGE_CLEAR_TIMEOUT_MS,
          intervalMs: 1_500,
          message: "Sokal bot challenge did not clear",
        }
      )
      .catch(() => null);
    return Boolean(cleared);
  }

  // -------------------------------------------------------------------------
  // Model reading
  // -------------------------------------------------------------------------

  /**
   * Tier 1 — a refinement list found by its heading.
   *
   * Anchored on the visible "Model" heading rather than on a class name,
   * because Sokal themes vary and none of them publish a stable facet
   * attribute the way Dealer.com and Dealer Inspire do.
   */
  async function readModelFacet(tabId) {
    return execute(tabId, () => {
      const clean = (value) =>
        String(value || "")
          .replace(/\s+/g, " ")
          .trim();

      const headings = Array.from(
        document.querySelectorAll("h1,h2,h3,h4,h5,legend,button,summary,[role=heading],label,span")
      ).filter((element) => /^models?$/i.test(clean(element.textContent)));

      for (const heading of headings) {
        // Walk outward until an ancestor holds several counted rows. The
        // heading's immediate parent is usually just the panel header.
        let container = heading.parentElement;
        for (let depth = 0; depth < 5 && container; depth += 1) {
          const rows = Array.from(container.querySelectorAll("label, li, a, [role=checkbox]"))
            .map((row) => clean(row.innerText || row.textContent))
            .map((text) => {
              const match = text.match(/^(.+?)\s*[\(\[]?\s*([\d,]+)\s*[\)\]]?(?:\s*available)?$/i);
              if (!match) return null;
              const count = Number(match[2].replace(/,/g, ""));
              const name = clean(match[1]);
              if (!name || !Number.isFinite(count)) return null;
              return { name, count };
            })
            .filter(Boolean);

          // Two counted rows is the smallest thing that is plausibly a facet
          // rather than one stray "Showing 24" line.
          if (rows.length >= 2) return { found: true, rows };
          container = container.parentElement;
        }
      }
      return { found: false, rows: [] };
    });
  }

  /**
   * Tiers 2 and 3 — prose. The teaser strip lists each model with either a
   * count or "Contact for availability"; only counted entries are usable.
   */
  async function readModelProse(tabId, make) {
    return execute(
      tabId,
      (primaryMake) => {
        const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
        const escaped = escape(primaryMake);

        const teaser = [];
        const teaserPattern = new RegExp(
          `(?:${escaped}\\s+)?([a-z0-9&+\\-/' ]+?)\\s+([\\d,]+)\\s+available`,
          "gi"
        );
        for (const match of text.matchAll(teaserPattern)) {
          const count = Number(match[2].replace(/,/g, ""));
          const name = String(match[1] || "")
            .replace(/^.*?\bNew\s+/i, "")
            .replace(new RegExp(`^${escaped}\\s+`, "i"), "")
            .replace(/\s+/g, " ")
            .trim();
          if (!name || !Number.isFinite(count)) continue;
          teaser.push({ name, count });
        }

        const section = text.match(/\bModel\s+(.*?)\s+Trim\b/i)?.[1] ?? "";
        const parenthetical = [];
        for (const match of section.matchAll(/([A-Za-z0-9&+\-/' ]+?)\s*\((\d[\d,]*)\)/g)) {
          const count = Number(match[2].replace(/,/g, ""));
          const name = String(match[1] || "").trim();
          if (!name || !Number.isFinite(count)) continue;
          parenthetical.push({ name, count });
        }

        return { teaser, parenthetical };
      },
      [make]
    );
  }

  async function inventoryPageState(tabId) {
    return execute(tabId, () => {
      const text = document.body?.innerText || "";
      return {
        url: location.href,
        // Either shape of inventory page qualifies: a filterable SRP, or the
        // model landing page whose teaser strip carries the same counts.
        hasControls:
          /\b\d[\d,]*\s+available\b/i.test(text) ||
          /\bModel\b[\s\S]{0,4000}\bTrim\b/i.test(text) ||
          document.querySelectorAll("[data-vehicle], .vehicle-card, [class*='vehicle-card' i]")
            .length > 0,
        vehicles: document.querySelectorAll(
          "[data-vehicle], .vehicle-card, [class*='vehicle-card' i]"
        ).length,
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
      platform: "sokal",
      helpers,
    });

    const challenge = await readChallengeState(tabId);
    if (challenge.challenged) {
      warnings.push("Sokal presented a bot challenge; waited for it to clear.");
      const cleared = await waitForChallengeToClear(tabId, runtime);
      if (!cleared) {
        throw new Error(
          `${item.siteName}: Sokal is showing a bot challenge in the collection window. Clear the check in that window, then rerun this dealer.`
        );
      }
    }

    const makes = [...new Set((item.makeAllowList || []).filter(Boolean))];
    if (makes.length === 0) {
      throw new Error("Sokal collection requires a configured make allow-list");
    }
    const primaryMake = makes[0];
    if (makes.length > 1) {
      warnings.push(
        `Sokal publishes no make refinement; all model rows were recorded under ${primaryMake}.`
      );
    }

    const landing = await inventoryNavigate.resolveInventoryPage({
      tabId,
      item,
      platform: "sokal",
      helpers,
      runtime,
      warnings,
      inspect: async (id) => {
        const state = await readChallengeState(id);
        if (state.challenged) return { ...state, ready: false };
        const candidate = await inventoryPageState(id);
        return { ...candidate, ready: candidate.hasControls };
      },
    });

    const facet = await readModelFacet(tabId).catch(() => ({ found: false, rows: [] }));
    let rows = facet.found ? facet.rows : [];

    if (rows.length === 0) {
      const prose = await readModelProse(tabId, primaryMake).catch(() => ({
        teaser: [],
        parenthetical: [],
      }));
      rows = prose.teaser.length > 0 ? prose.teaser : prose.parenthetical;
      if (rows.length > 0) {
        warnings.push(
          "Sokal model counts were read from page text rather than a model refinement list; verify against the dealer site before publishing."
        );
      }
    }

    if (rows.length === 0) {
      throw new Error("Sokal model discovery found no counted model rows on the inventory page");
    }

    // Sokal exposes no availability split anywhere on the SRP.
    const tally = inventoryTally.createInventoryTally({
      makeAllowList: makes,
      transitKnown: false,
    });
    for (const row of rows) {
      tally.addModelCount(primaryMake, row.name, { inStock: row.count });
    }
    const counted = tally.result();

    warnings.push("Sokal publishes no in-transit split; transit left unresolved.");
    for (const make of counted.missingMakes) {
      warnings.push(`${make}: no Sokal model rows resolved; recorded as zero.`);
    }

    if (counted.models.length === 0) {
      throw new Error("Sokal collection produced no model rows");
    }
    if (counted.totals.inStock <= 0) {
      throw new Error("Sokal reconciled on-lot total was zero");
    }

    return {
      sourceUrl: landing.url,
      detectedPlatform: "sokal",
      totals: counted.totals,
      makeSubtotals: counted.makeSubtotals,
      models: counted.models,
      warnings,
    };
  }

  globalThis.inventoryPlatformAdapters ||= [];
  globalThis.inventoryPlatformAdapters.push({
    id: "sokal",
    platforms: ["sokal", "socal", "sokal_media", "sokalmedia"],
    collect,
  });
})();
