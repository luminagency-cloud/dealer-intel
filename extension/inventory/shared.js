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

  globalThis.inventoryShared = {
    createRuntime,
    sleep,
    throwIfCancelled,
    waitFor,
    withGuaranteedCleanup,
    withTimeout,
  };
})();
