"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const REQUEST_TYPE = "DEALER_INTEL_EXTENSION_REQUEST";
const RESPONSE_TYPE = "DEALER_INTEL_EXTENSION_RESPONSE";
const PROTOCOL_VERSION = 2;

interface ChromeJobItem {
  siteId: string;
  missionId: string;
  url: string;
  siteName: string;
  missionName: string;
}

interface ExtensionResponse {
  ok: boolean;
  error?: string;
  protocolVersion?: number;
  version?: string;
  capture?: {
    finalUrl: string;
    pageTitle: string;
    html: string;
    screenshotDataUrl: string;
  };
}

function extensionRequest(
  command: "PING" | "COLLECT_ITEM" | "CLOSE_SESSION",
  payload?: unknown,
  timeoutMs = 2_000
): Promise<ExtensionResponse> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timeout = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(
        new Error(
          command === "PING"
            ? "Chrome Collector extension was not detected. Nothing was started."
            : "Chrome Collector stopped responding."
        )
      );
    }, timeoutMs);

    function onMessage(event: MessageEvent) {
      if (
        event.source !== window ||
        event.data?.type !== RESPONSE_TYPE ||
        event.data?.requestId !== requestId
      ) {
        return;
      }
      window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      resolve(event.data.response as ExtensionResponse);
    }

    window.addEventListener("message", onMessage);
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

export function ChromeCollectorControl({
  runId,
  canStart,
  needsRecovery,
  switchToCurrentAction,
}: {
  runId: string;
  canStart: boolean;
  needsRecovery: boolean;
  switchToCurrentAction: () => Promise<void>;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [fallbackAvailable, setFallbackAvailable] = useState(false);
  const autoResumeAttempted = useRef(false);

  async function startChromeCollection() {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    setFallbackAvailable(false);
    setMessage("Checking Chrome Collector…");

    let job:
      | {
          items: ChromeJobItem[];
        }
      | undefined;
    let successCount = 0;
    let failureCount = 0;

    try {
      const ping = await extensionRequest("PING");
      if (!ping.ok) throw new Error(ping.error || "Chrome Collector is unavailable");
      if (ping.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error(
          `Chrome Collector protocol mismatch (app ${PROTOCOL_VERSION}, extension ${ping.protocolVersion ?? "unknown"}). Reload the extension.`
        );
      }

      setMessage(`Chrome Collector ${ping.version ?? ""} detected. Preparing run…`);
      const startResponse = await fetch(`/api/collector/runs/${runId}/start`, {
        method: "POST",
      });
      if (!startResponse.ok) throw new Error(await responseError(startResponse));
      const preparedJob = (await startResponse.json()) as {
        items: ChromeJobItem[];
      };
      job = preparedJob;

      if (preparedJob.items.length === 0) {
        setMessage("Chrome collection is already complete. Refreshing saved results…");
        router.refresh();
        return;
      }

      for (const [index, item] of preparedJob.items.entries()) {
        setMessage(
          `${index + 1}/${preparedJob.items.length}: Opening ${item.siteName} for ${item.missionName} in Chrome…`
        );

        try {
          const extensionResult = await extensionRequest(
            "COLLECT_ITEM",
            item,
            90_000
          );
          if (!extensionResult.ok || !extensionResult.capture) {
            throw new Error(extensionResult.error || "Chrome capture failed");
          }

          const capture = extensionResult.capture;
          const resultForm = new FormData();
          resultForm.set("siteId", item.siteId);
          resultForm.set("missionId", item.missionId);
          resultForm.set("finalUrl", capture.finalUrl);
          resultForm.set("pageTitle", capture.pageTitle || item.siteName);
          resultForm.set("html", capture.html);
          const screenshotResponse = await fetch(capture.screenshotDataUrl);
          resultForm.set(
            "screenshot",
            await screenshotResponse.blob(),
            "chrome-visible.png"
          );

          setMessage(
            `${index + 1}/${preparedJob.items.length}: Uploading ${item.siteName} evidence…`
          );
          const resultResponse = await fetch(
            `/api/collector/runs/${runId}/result`,
            { method: "POST", body: resultForm }
          );
          if (!resultResponse.ok) {
            throw new Error(await responseError(resultResponse));
          }
          successCount += 1;
        } catch (error) {
          failureCount += 1;
          const errorMessage =
            error instanceof Error ? error.message : "Chrome capture failed";
          const failureForm = new FormData();
          failureForm.set("siteId", item.siteId);
          failureForm.set("missionId", item.missionId);
          failureForm.set("error", errorMessage);
          await fetch(`/api/collector/runs/${runId}/result`, {
            method: "POST",
            body: failureForm,
          });
        }
      }

      if (failureCount > 0) {
        setFailed(true);
        setFallbackAvailable(successCount === 0);
        setMessage(
          `Chrome collection finished: ${successCount} succeeded, ${failureCount} failed.`
        );
      } else {
        setMessage(
          `Chrome collection complete: ${successCount} item${successCount === 1 ? "" : "s"} captured. Evidence is ready to analyze.`
        );
      }
      router.refresh();
    } catch (error) {
      setFailed(true);
      setFallbackAvailable(!job || successCount === 0);
      setMessage(error instanceof Error ? error.message : "Chrome collection failed");
      router.refresh();
    } finally {
      if (job) {
        await extensionRequest("CLOSE_SESSION", undefined, 5_000).catch(
          () => undefined
        );
      }
      setBusy(false);
    }
  }

  async function claimChromeRun() {
    await navigator.locks.request(
      `dealer-intel-chrome-run-${runId}`,
      { ifAvailable: true },
      async (lock) => {
        if (!lock) {
          setMessage("Chrome collection is active in another Dealer Intel tab.");
          return;
        }
        await startChromeCollection();
      }
    );
  }

  useEffect(() => {
    if (!needsRecovery || autoResumeAttempted.current) return;
    autoResumeAttempted.current = true;
    void claimChromeRun();
    // Recovery is deliberately a mount-time handoff. The runner holds the
    // browser lock until this collection attempt settles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsRecovery]);

  return (
    <div className="flex max-w-xl flex-col items-end gap-2">
      {canStart && (
        <button
          type="button"
          onClick={claimChromeRun}
          disabled={busy}
          className="rounded-md bg-blue-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy
            ? "Chrome collecting…"
            : needsRecovery
              ? "Resume in Chrome"
              : "Start in Chrome"}
        </button>
      )}
      {message && (
        <p
          className={`rounded-md px-3 py-2 text-left text-xs ${
            failed
              ? "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300"
              : "bg-blue-50 text-blue-800 dark:bg-blue-950 dark:text-blue-200"
          }`}
        >
          {message}
        </p>
      )}
      {fallbackAvailable && (
        <form action={switchToCurrentAction}>
          <button
            type="submit"
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            Use Current Collector
          </button>
        </form>
      )}
    </div>
  );
}
