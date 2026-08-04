(() => {
  function abortError(signal, fallback = "Inventory collection cancelled") {
    if (signal?.reason instanceof Error) return signal.reason;
    return new DOMException(fallback, "AbortError");
  }

  function throwIfCancelled(signal) {
    if (signal?.aborted) throw abortError(signal);
  }

  function sleep(ms, signal) {
    throwIfCancelled(signal);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      function onAbort() {
        clearTimeout(timeout);
        reject(abortError(signal));
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async function waitFor(check, options = {}) {
    const {
      timeoutMs = 10_000,
      intervalMs = 250,
      signal,
      message = "Timed out waiting for the visible inventory page",
    } = options;
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      throwIfCancelled(signal);
      try {
        const value = await check();
        if (value) return value;
      } catch (error) {
        lastError = error;
      }
      await sleep(intervalMs, signal);
    }
    if (lastError instanceof Error && /abort|cancel/i.test(lastError.message)) {
      throw lastError;
    }
    throw new Error(message);
  }

  async function withTimeout(task, options) {
    const { timeoutMs, signal: outerSignal, message } = options;
    const controller = new AbortController();
    const abortFromOuter = () => controller.abort(abortError(outerSignal));
    outerSignal?.addEventListener("abort", abortFromOuter, { once: true });
    const timeout = setTimeout(
      () => controller.abort(new Error(message)),
      timeoutMs
    );
    try {
      return await task(controller.signal);
    } finally {
      clearTimeout(timeout);
      outerSignal?.removeEventListener("abort", abortFromOuter);
    }
  }

  async function withGuaranteedCleanup(task, cleanup) {
    let taskError;
    try {
      return await task();
    } catch (error) {
      taskError = error;
      throw error;
    } finally {
      try {
        await cleanup();
      } catch (cleanupError) {
        if (!taskError) throw cleanupError;
      }
    }
  }

  function createRuntime({ helpers, signal }) {
    return {
      signal,
      sleep: (ms) => sleep(ms, signal),
      throwIfCancelled: () => throwIfCancelled(signal),
      waitFor: (check, options) => waitFor(check, { ...options, signal }),
      suppressPopups: async (tabId) => {
        throwIfCancelled(signal);
        await helpers.suppressPageObstructions(tabId);
        throwIfCancelled(signal);
      },
    };
  }

  /**
   * The wall-clock budget one dealer's inventory collection gets.
   *
   * Sized from what the adapters actually do rather than from a round number.
   * Per make: two SRP navigations (filter, then in-transit) plus two model
   * facet reads, whose own poll ceiling is 10s each. Fixed cost: opening the
   * session window, loading the homepage, reaching the SRP, and reading the
   * make and status facets once.
   *
   * The previous 30s + 30s/make could not cover that for even a single make —
   * a one-make dealer was given 60s for roughly 85s of work, so it failed on
   * the clock every time and reported the last tier it happened to be in.
   *
   * Exported so the session watchdog derives from the SAME number. The two
   * used to be computed independently (60s/make + 5s there, 30s + 30s/make
   * here), which for one make put the window teardown 5s after the collection
   * deadline — close enough that cleanup raced the work still in flight and
   * produced "No tab with id" mid-run.
   */
  function collectionBudgetMs(makeCount) {
    const makePasses = Math.max(1, makeCount || 1);
    return 45_000 + makePasses * 45_000;
  }

  /** Never let the window be reclaimed while collection may still be using it. */
  function sessionLifetimeMs(makeCount) {
    return collectionBudgetMs(makeCount) + 30_000;
  }

  globalThis.inventoryShared = {
    collectionBudgetMs,
    createRuntime,
    sessionLifetimeMs,
    sleep,
    throwIfCancelled,
    waitFor,
    withGuaranteedCleanup,
    withTimeout,
  };
})();
