/**
 * Platform-neutral inventory tallying.
 *
 * Every adapter ends up doing the same three things: fold rows into make/model
 * buckets, hold those buckets against the dealer's configured make allow-list,
 * and reconcile subtotals into the result shape the app stores. Writing that
 * once per platform invited several subtly different answers to the same
 * question, so it lives here.
 *
 * Deliberately knows nothing about selectors, URLs, or navigation. `shared.js`
 * owns lifecycle and cancellation, `navigate.js` owns page resolution, the
 * adapters own platform behavior, and this file only counts.
 */
(() => {
  function normalizeName(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeKey(value) {
    return normalizeName(value).toLowerCase();
  }

  /**
   * Ram model facets read "1500" on most platforms and "Ram 1500" on others.
   * Reports compare model rows across dealers, so the stored name has to be
   * the same string either way.
   */
  function canonicalModel(make, model) {
    const cleaned = normalizeName(model);
    if (/^ram$/i.test(make) && !/^ram\b/i.test(cleaned)) return `Ram ${cleaned}`;
    return cleaned;
  }

  /** Words a nameplate never carries, but a scraped label often does. */
  const FURNITURE_WORDS =
    /\b(?:sales|service|parts|directions|contact|compare|call|hours|appointment|results?|matches|vehicles?|inventory|stock|specials?|window\s+sticker)\b/i;

  /** Street types, for the address rule below. Bare, so `4dr` and `CT5` miss. */
  const STREET_WORD =
    /\b(?:road|rd|street|st|avenue|ave|lane|ln|boulevard|blvd|drive|dr|highway|hwy|route|rt|turnpike|pike|circle|cir|court|ct|place|pl|parkway|pkwy|way|terrace|trail)\b\.?/i;

  /** A number standing on its own: `Camry 26`, not `CX-90` or `Mazda3`. */
  const BARE_NUMBER = /(?:^|\s)\d[\d,]*(?=\s|$)/g;

  /**
   * Reject text that is obviously page furniture rather than a model name.
   *
   * Count readers scrape labels, and a dealer address, a compare-widget caption
   * or a whole facet panel read as one string becomes a permanent bogus model
   * row in reporting — the stored rows are what the report compares, so nothing
   * downstream can tell them from a real nameplate afterwards.
   *
   * Every rule here has to survive the real names that look like junk: `GR86`,
   * `Mazda3`, `CX-90 PHEV`, `bZ4X`, `MX-5 Miata RF`, `IONIQ 5`, `Ram ProMaster
   * 3500 Cutaway`, and the digits-only `300` and `911`. So the rules key on
   * things a nameplate genuinely never has: label punctuation, a model year, a
   * street address, or several counts strung together.
   */
  function plausibleModelName(name) {
    const normalized = normalizeName(name);
    if (!normalized || normalized.length > 60) return false;
    if (!/[A-Za-z0-9]/.test(normalized)) return false;

    // Label punctuation. `Compare New 2025 Kia K5 EX Stock:` came in through a
    // keyword rule whose trailing `\b` could never match after the colon.
    if (/[:;•|]/.test(normalized)) return false;

    // A model year belongs to a listing, never to a nameplate. Ram 2500 and
    // Sierra 3500 are outside the 19xx/20xx window on purpose.
    if (/\b(?:19|20)\d{2}\b/.test(normalized)) return false;

    if (FURNITURE_WORDS.test(normalized)) return false;

    // A whole facet panel read as one label: `4Runner 7 BZ 7 C-HR 5 Camry 26`.
    // Real names carry at most one standalone number (`IONIQ 5`, `Ram 1500`).
    if ((normalized.match(BARE_NUMBER) || []).length >= 3) return false;

    // Dealer address. Either shape is enough on its own: a house number in
    // front (`1030 Hingham St`) or a city/state tail (`Broad St, Bristol, CT`).
    // The earlier rule demanded the tail, so every bullet-free address stored.
    if (STREET_WORD.test(normalized) && (/^\d{1,6}\s/.test(normalized) || /,/.test(normalized))) {
      return false;
    }

    return true;
  }

  /**
   * Prove a per-make facet read is that make's data and not the whole store's.
   *
   * A facet-reading adapter navigates to a make-filtered SRP URL and then reads
   * whatever model facet the page rendered. When the site ignores that filter,
   * the read still succeeds — and returns the WHOLE store's models, which are
   * then banked under the one make we happened to be asking for. That is how a
   * Buick row ended up holding Golf GTI and IONIQ 5, and how each make at a
   * CDJR store ended up holding every other make's trucks.
   *
   * The adapters used to answer this by re-reading the query param they had
   * just written into the URL themselves, which can only ever say yes. This
   * asks the PAGE instead, and takes either kind of evidence:
   *
   *   - the make facet reports the target make as selected, or
   *   - the model counts total no more than the store's own count for that
   *     make (an unfiltered read totals the whole store, so it cannot).
   *
   *   - the per-make read is smaller than the store's own unfiltered model
   *     read, which an unfiltered read cannot be.
   *
   * Any one alone proves the page narrowed. Requiring more than one would fail
   * honest stores: some themes never render the facet control as checked, and
   * some publish no per-make counts.
   *
   * That last form is the one that keeps the guard from failing closed. The
   * first two both depend on the make facet — on its checked state, or on it
   * publishing a count — and when a store's make facet offers neither, EVERY
   * make failed the guard at once and the dealer ended the run with no model
   * rows at all. Every multi-make Dealer Inspire store failed this way while
   * every single-brand store passed, because a single-brand store never gets
   * this far. Comparing against the unfiltered read asks the page a question
   * it can always answer.
   *
   * The guard only means anything where a store has more than one make to
   * confuse. On a single-brand store the unfiltered read IS that make's read,
   * so it stands down rather than inventing a failure.
   *
   * @param {object} options
   * @param {string} options.make the make this read was supposed to be scoped to
   * @param {number} options.modelTotal sum of the model rows just read
   * @param {Array<{name?: string, value?: string, count?: number|null}>}
   *   options.storeMakes the make facet as read BEFORE any make filter applied
   * @param {string[]} [options.selectedMakes] makes the page's own markup
   *   reports as selected AFTER filtering. Must be read from the DOM, never
   *   from the URL — the URL only ever repeats what we put there.
   * @param {number|null} [options.storeModelTotal] the model facet total read
   *   on the SAME page before any make filter applied — the whole store. A
   *   per-make read that comes back this big is the read the guard exists to
   *   catch; anything smaller narrowed.
   * @returns {{scoped: boolean, reason: string|null}} `scoped` false means the
   *   counts belong to the store rather than to this make and must be dropped.
   */
  function checkMakeScope(options = {}) {
    const {
      make,
      modelTotal,
      storeMakes = [],
      selectedMakes = [],
      storeModelTotal = null,
    } = options;
    const ok = { scoped: true, reason: null };

    const offered = storeMakes.filter((row) => normalizeKey(row?.name || row?.value));
    if (offered.length <= 1) return ok;
    if (!(Number(modelTotal) > 0)) return ok;

    const key = normalizeKey(make);
    const matches = (row) =>
      normalizeKey(row?.name) === key || normalizeKey(row?.value) === key;

    if (selectedMakes.some((name) => normalizeKey(name) === key)) return ok;

    const own = offered.find(matches);
    const count = Number(own?.count);
    // Tolerance, not equality: a status-split pass reads legitimately FEWER
    // vehicles than the make's all-status facet count, and counts drift a
    // little between two page loads. Only an over-count is evidence.
    if (Number.isFinite(count) && Number(modelTotal) <= count + 2) return ok;

    // Same tolerance, same direction: the unfiltered read is the ceiling, so
    // only landing at or above it is evidence of a filter that never applied.
    const whole = Number(storeModelTotal);
    if (Number.isFinite(whole) && whole > 0 && Number(modelTotal) <= whole - 2) return ok;

    if (!Number.isFinite(count)) {
      return {
        scoped: false,
        reason: `the make facet neither reports ${make} as selected nor publishes a ${make} count, and ${modelTotal} model vehicles is the whole store's unfiltered read (${
          Number.isFinite(whole) ? whole : "unknown"
        }), so they could not be confirmed as ${make} alone`,
      };
    }
    return {
      scoped: false,
      reason: `model counts total ${modelTotal} against ${count} ${make} in the store's own make facet, and the page does not report ${make} as selected; the make filter did not apply`,
    };
  }

  /**
   * @param {object} options
   * @param {string[]} options.makeAllowList dealer's configured makes; rows for
   *   any other make are dropped and reported through `ignoredMakes`.
   * @param {boolean} [options.transitKnown] false when the platform publishes
   *   no on-lot/in-transit split. Every transit figure is then reported as
   *   `null` rather than as a zero we did not actually observe.
   * @param {boolean} [options.enumerated] true when the source listed the
   *   store's whole new inventory in one read, so a configured make that never
   *   appeared is confirmed absent rather than possibly-missed.
   *
   *   An enumerated source counted every car on the lot, so it drops the make
   *   rather than publishing a zero row. A facet reader cannot: for it, zero
   *   is indistinguishable from a refinement that silently failed, so the zero
   *   row stays as the visible signal.
   *
   *   This is not cosmetic. `scripts/compare-inventory-batches.mjs` treats a
   *   make present on one side and absent on the other as a hard failure, with
   *   none of the +/-2 tolerance it allows model rows, and the API baseline
   *   omits makes it found no vehicles for. An enumerated adapter that emitted
   *   a zero row would fail its own matched-batch check.
   */
  function createInventoryTally(options = {}) {
    const makeAllowList = [
      ...new Set((options.makeAllowList || []).map(normalizeName).filter(Boolean)),
    ];
    const allowByKey = new Map(makeAllowList.map((make) => [normalizeKey(make), make]));
    const transitKnown = options.transitKnown !== false;
    const enumerated = options.enumerated === true;

    const rows = new Map();
    const ignoredMakes = new Map();

    /** Resolve a source make to its allow-list spelling, or null if excluded. */
    function resolveMake(make) {
      const key = normalizeKey(make);
      if (!key) return null;
      if (allowByKey.size === 0) return normalizeName(make);
      return allowByKey.get(key) ?? null;
    }

    function addModelCount(make, model, counts = {}) {
      const resolvedMake = resolveMake(make);
      const modelName = canonicalModel(resolvedMake ?? make, model);
      if (!resolvedMake) {
        if (normalizeKey(make)) {
          const key = normalizeKey(make);
          const previous = ignoredMakes.get(key) ?? { make: normalizeName(make), count: 0 };
          previous.count += Number(counts.inStock || 0) + Number(counts.inTransit || 0);
          ignoredMakes.set(key, previous);
        }
        return;
      }
      if (!plausibleModelName(modelName)) return;

      const key = `${normalizeKey(resolvedMake)}::${normalizeKey(modelName)}`;
      const row = rows.get(key) ?? {
        make: resolvedMake,
        model: modelName,
        inStock: 0,
        inTransit: 0,
      };
      row.inStock += Number(counts.inStock || 0);
      row.inTransit += Number(counts.inTransit || 0);
      rows.set(key, row);
    }

    /** One physical vehicle. Used by sources that enumerate stock directly. */
    function addVehicle(make, model, state = {}) {
      addModelCount(make, model, {
        inStock: state.inTransit ? 0 : 1,
        inTransit: state.inTransit ? 1 : 0,
      });
    }

    function result() {
      const models = [...rows.values()]
        .sort(
          (left, right) =>
            left.make.localeCompare(right.make) || left.model.localeCompare(right.model)
        )
        .map((row) => ({
          make: row.make,
          model: row.model,
          inStock: row.inStock,
          inTransit: transitKnown ? row.inTransit : null,
          status: "ok",
        }));

      // Subtotals follow the dealer's configured make order, so a facet reader
      // that came back empty for one of the store's own brands stays visible
      // as a zero row instead of silently vanishing.
      //
      // An enumerated source drops the make instead. It read the whole lot, so
      // a configured make with no cars is an answer, not a gap, and the API
      // baseline it gets compared against omits the make for the same reason.
      const observed = new Set(models.map((row) => normalizeKey(row.make)));
      const configuredMakes =
        makeAllowList.length > 0
          ? makeAllowList
          : [...new Set(models.map((row) => row.make))].sort((left, right) =>
              left.localeCompare(right)
            );
      const orderedMakes = enumerated
        ? configuredMakes.filter((make) => observed.has(normalizeKey(make)))
        : configuredMakes;

      const makeSubtotals = orderedMakes.map((make) => {
        const key = normalizeKey(make);
        const owned = models.filter((row) => normalizeKey(row.make) === key);
        return {
          make,
          inStock: owned.reduce((sum, row) => sum + row.inStock, 0),
          inTransit: transitKnown
            ? owned.reduce((sum, row) => sum + (row.inTransit || 0), 0)
            : null,
        };
      });

      const totalInStock = makeSubtotals.reduce((sum, row) => sum + row.inStock, 0);
      const totalInTransit = transitKnown
        ? makeSubtotals.reduce((sum, row) => sum + (row.inTransit || 0), 0)
        : null;

      return {
        models,
        makeSubtotals,
        totals: {
          inStock: totalInStock,
          inTransit: totalInTransit,
          displayValue:
            totalInTransit === null
              ? String(totalInStock)
              : `${totalInStock}/${totalInTransit}*`,
        },
        // Configured makes the source never mentioned. Computed against the
        // full configured list, not against `makeSubtotals`, so it stays
        // truthful when `enumerated` has already dropped those rows.
        //
        // What it means depends on the source: for a facet reader it is a
        // warning (a refinement may have failed silently); for an enumerated
        // one it is just a brand this store does not stock.
        missingMakes: configuredMakes.filter((make) => !observed.has(normalizeKey(make))),
        // Makes the source reported that the dealer is not configured for.
        ignoredMakes: [...ignoredMakes.values()].sort((left, right) =>
          left.make.localeCompare(right.make)
        ),
      };
    }

    return { addModelCount, addVehicle, result };
  }

  globalThis.inventoryTally = {
    canonicalModel,
    checkMakeScope,
    createInventoryTally,
    normalizeKey,
    normalizeName,
    plausibleModelName,
  };
})();
