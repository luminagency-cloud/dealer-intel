"use client";

const REQUEST_TYPE = "DEALER_INTEL_EXTENSION_REQUEST";
const RESPONSE_TYPE = "DEALER_INTEL_EXTENSION_RESPONSE";
const PROTOCOL_VERSION = 5;
const MIN_EXTENSION_VERSION = "1.4.3";

class ChromeCollectorTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(
      `Dealer collection exceeded its ${Math.round(timeoutMs / 1_000)}-second limit.`
    );
    this.name = "ChromeCollectorTimeoutError";
  }
}

class ChromeCollectorTransportError extends Error {
  constructor(detail?: string) {
    super(
      `Chrome Collector connection was lost${detail ? `: ${detail}` : "."} The active batch was stopped before untouched dealers were marked failed. Reload Dealer Intel if the extension was reloaded.`
    );
    this.name = "ChromeCollectorTransportError";
  }
}

function isChromeCollectorTransportFailure(message: string): boolean {
  return /extension context invalidated|message channel closed|message port closed|receiving end does not exist|could not establish connection/i.test(
    message
  );
}

export interface ChromeInventoryItem {
  siteId: string;
  siteName: string;
  url: string;
  platform: string | null;
  makeAllowList: string[];
  inventoryPath: string | null;
}

interface ChromeInventoryResponse {
  ok: boolean;
  error?: string;
  protocolVersion?: number;
  version?: string;
  result?: {
    sourceUrl: string;
    detectedPlatform: string;
    totals: { inStock: number; inTransit: number | null; displayValue: string };
    makeSubtotals: { make: string; inStock: number; inTransit: number | null }[];
    models: {
      make: string;
      model: string;
      inStock: number | null;
      inTransit: number | null;
      status: string;
    }[];
    warnings?: string[];
  };
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map((part) => Number(part) || 0);
  const b = right.split(".").map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] || 0) - (b[index] || 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function extensionRequest(
  command: "PING" | "COLLECT_INVENTORY" | "CLOSE_SESSION",
  payload?: unknown,
  timeoutMs = 2_000,
  signal?: AbortSignal
): Promise<ChromeInventoryResponse> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Inventory collection cancelled", "AbortError"));
      return;
    }
    const requestId = crypto.randomUUID();
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(
        command === "PING"
          ? new Error("Chrome Collector extension was not detected. Nothing was started.")
          : command === "COLLECT_INVENTORY"
            ? new ChromeCollectorTimeoutError(timeoutMs)
            : new ChromeCollectorTransportError("the close-session request timed out")
      );
    }, timeoutMs);

    function cleanup() {
      window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      signal?.removeEventListener("abort", onAbort);
    }

    function onAbort() {
      cleanup();
      reject(new DOMException("Inventory collection cancelled", "AbortError"));
    }

    function onMessage(event: MessageEvent) {
      if (
        event.source !== window ||
        event.data?.type !== RESPONSE_TYPE ||
        event.data?.requestId !== requestId
      ) {
        return;
      }
      cleanup();
      resolve(event.data.response as ChromeInventoryResponse);
    }

    window.addEventListener("message", onMessage);
    signal?.addEventListener("abort", onAbort, { once: true });
    window.postMessage(
      { type: REQUEST_TYPE, requestId, command, payload },
      window.location.origin
    );
  });
}

async function responseError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error || `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
}

export async function requireInventoryExtension(): Promise<string> {
  const ping = await extensionRequest("PING");
  if (!ping.ok) throw new Error(ping.error || "Chrome Collector is unavailable");
  if (ping.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(
      `Chrome Collector protocol mismatch (app ${PROTOCOL_VERSION}, extension ${ping.protocolVersion ?? "unknown"}). Reload the unpacked extension.`
    );
  }
  if (!ping.version || compareVersions(ping.version, MIN_EXTENSION_VERSION) < 0) {
    throw new Error(
      `Chrome Collector ${ping.version ?? "unknown"} is outdated. Reload extension ${MIN_EXTENSION_VERSION}.`
    );
  }
  return ping.version;
}

async function postResult(batchId: string, body: unknown) {
  const response = await fetch(`/api/inventory/batch/${batchId}/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await responseError(response));
}

async function fetchJobItems(batchId: string): Promise<ChromeInventoryItem[]> {
  const response = await fetch(`/api/inventory/batch/${batchId}/job`, {
    cache: "no-store",
  });
  if (!response.ok) throw new Error(await responseError(response));
  const job = (await response.json()) as { items: ChromeInventoryItem[] };
  return job.items;
}

/**
 * Drain this batch's queue until nothing is left to do.
 *
 * Re-reading the queue after each dealer is not a refinement — it is the only
 * way a dealer queued mid-run ever gets collected. Pressing Run while a batch
 * is active deliberately appends to the SAME batch rather than starting a
 * second one, and the browser lock guarding that batch id is held right here,
 * so no second driver can ever claim the new dealer. Reading the list once at
 * the top left that dealer sitting at "queued" for good, with the batch still
 * reporting itself active and nothing driving it.
 *
 * `attempted` is what makes the loop terminate: a dealer this drive has
 * already opened is never opened again, so a row that cannot be settled ends
 * the drain instead of spinning on it.
 */
export async function runChromeInventoryJob(
  batchId: string,
  onProgress: (message: string) => void,
  signal?: AbortSignal
): Promise<{ succeeded: number; failed: number }> {
  let succeeded = 0;
  let failed = 0;
  const attempted = new Set<string>();

  try {
    for (;;) {
      signal?.throwIfAborted();
      const queue = (await fetchJobItems(batchId)).filter(
        (candidate) => !attempted.has(candidate.siteId)
      );
      const item = queue[0];
      if (!item) break;
      attempted.add(item.siteId);

      const position = attempted.size;
      const total = position + queue.length - 1;
      onProgress(
        `${position}/${total}: Opening ${item.siteName} and navigating to New Inventory…`
      );
      await postResult(batchId, { action: "running", siteId: item.siteId });
      try {
        // Mirrors `inventoryShared.collectionBudgetMs` in the extension, plus
        // headroom. The extension has to be the one that gives up: it knows
        // which navigation tier or facet read actually ran out of time, and
        // that message is the whole diagnosis. If the app expires first, all
        // the operator sees is "exceeded its N-second limit".
        const makePasses = Math.max(1, item.makeAllowList.length);
        const collectionTimeoutMs = 45_000 + makePasses * 45_000 + 30_000;
        const response = await extensionRequest(
          "COLLECT_INVENTORY",
          item,
          collectionTimeoutMs,
          signal
        );
        if (!response.ok || !response.result) {
          const message = response.error || "Chrome returned no inventory result";
          if (isChromeCollectorTransportFailure(message)) {
            throw new ChromeCollectorTransportError(message);
          }
          throw new Error(message);
        }
        onProgress(`${position}/${total}: Saving ${item.siteName} inventory…`);
        await postResult(batchId, {
          action: "complete",
          siteId: item.siteId,
          result: response.result,
        });
        succeeded += 1;
      } catch (error) {
        if (signal?.aborted) break;
        if (error instanceof ChromeCollectorTransportError) {
          throw error;
        }
        failed += 1;
        await postResult(batchId, {
          action: "failure",
          siteId: item.siteId,
          error: {
            message:
              error instanceof Error
                ? error.message
                : "Visible Chrome inventory collection failed",
            code: "chrome_inventory_failed",
          },
        }).catch(() => undefined);
        if (error instanceof ChromeCollectorTimeoutError) {
          const reset = await extensionRequest(
            "CLOSE_SESSION",
            undefined,
            5_000,
            signal
          ).catch((resetError: unknown) => {
            throw resetError instanceof ChromeCollectorTransportError
              ? resetError
              : new ChromeCollectorTransportError(
                  resetError instanceof Error ? resetError.message : "session reset failed"
                );
          });
          if (!reset.ok) {
            throw new ChromeCollectorTransportError(
              reset.error || "session reset failed"
            );
          }
        }
      }
    }
  } finally {
    await extensionRequest("CLOSE_SESSION", undefined, 5_000).catch(
      () => undefined
    );
  }

  return { succeeded, failed };
}

export async function cancelChromeInventoryCollection(): Promise<void> {
  await extensionRequest("CLOSE_SESSION", undefined, 1_500);
}
