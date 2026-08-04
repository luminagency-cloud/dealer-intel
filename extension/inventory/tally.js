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

  /**
   * Reject text that is obviously page furniture rather than a model name.
   * Count readers scrape labels, and a dealer address or a "Results" heading
   * that slips through becomes a permanent bogus model row in reporting.
   */
  function plausibleModelName(name) {
    const normalized = normalizeName(name);
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
    createInventoryTally,
    normalizeKey,
    normalizeName,
    plausibleModelName,
  };
})();
