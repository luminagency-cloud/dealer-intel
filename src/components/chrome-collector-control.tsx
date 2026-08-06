"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const REQUEST_TYPE = "DEALER_INTEL_EXTENSION_REQUEST";
const RESPONSE_TYPE = "DEALER_INTEL_EXTENSION_RESPONSE";
const EVENT_TYPE = "DEALER_INTEL_EXTENSION_EVENT";
const PROTOCOL_VERSION = 4;
const MIN_EXTENSION_VERSION = "0.4.0";

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map((part) => Number(part) || 0);
  const b = right.split(".").map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] || 0) - (b[index] || 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

interface ChromeCaptureState {
  stateId: string;
  stateKind: "base" | "carousel" | "tab" | "disclaimer" | "failure";
  stateOrder: number;
  finalUrl: string;
  pageTitle: string;
  label: string;
  html: string;
  screenshotDataUrl: string;
  textContent?: string;
}

interface ChromeJobItem {
  siteId: string;
  missionId: string;
  url: string;
  siteName: string;
  missionName: string;
  missionType: string;
  explore: {
    carousels: boolean;
    tabs: boolean;
    accordions: boolean;
    disclaimers: boolean;
  };
}

interface ExtensionResponse {
  ok: boolean;
  error?: string;
  protocolVersion?: number;
  version?: string;
  summary?: {
    finalUrl: string;
    pageTitle: string;
    stateCount: number;
  };
}

function extensionRequest(
  command:
    | "PING"
    | "COLLECT_ITEM"
    | "ACK_CAPTURE_STATE"
    | "CLOSE_SESSION",
  payload?: unknown,
  timeoutMs = 2_000,
  onCaptureState?: (state: ChromeCaptureState) => Promise<void>
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
        event.source === window &&
        event.data?.type === EVENT_TYPE &&
        event.data?.requestId === requestId &&
        event.data?.state
      ) {
        const state = event.data.state as ChromeCaptureState;
        const upload = onCaptureState
          ? onCaptureState(state)
          : Promise.reject(new Error("No capture-state uploader is available"));
        void upload
          .then(() =>
            extensionRequest(
              "ACK_CAPTURE_STATE",
              { collectionRequestId: requestId, stateId: state.stateId, ok: true },
              5_000
            )
          )
          .catch((error) =>
            extensionRequest(
              "ACK_CAPTURE_STATE",
              {
                collectionRequestId: requestId,
                stateId: state.stateId,
                ok: false,
                error:
                  error instanceof Error ? error.message : "Evidence upload failed",
              },
              5_000
            ).catch(() => undefined)
          );
        return;
      }
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

async function uploadCaptureState(
  runId: string,
  item: ChromeJobItem,
  state: ChromeCaptureState
): Promise<void> {
  const form = new FormData();
  form.set("action", "state");
  form.set("siteId", item.siteId);
  form.set("missionId", item.missionId);
  form.set("stateId", state.stateId);
  form.set("stateKind", state.stateKind);
  form.set("stateOrder", String(state.stateOrder));
  form.set("finalUrl", state.finalUrl);
  form.set("pageTitle", state.pageTitle || item.siteName);
  form.set("label", state.label);
  form.set("html", state.html);
  if (state.textContent) form.set("textContent", state.textContent);
  const screenshotResponse = await fetch(state.screenshotDataUrl);
  if (!screenshotResponse.ok) {
    throw new Error(`Could not read Chrome screenshot (${screenshotResponse.status})`);
  }
  form.set(
    "screenshot",
    await screenshotResponse.blob(),
    `${state.stateId}.png`
  );

  const response = await fetch(`/api/collector/runs/${runId}/result`, {
    method: "POST",
    body: form,
  });
  if (!response.ok) throw new Error(await responseError(response));
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
  const searchParams = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [fallbackAvailable, setFallbackAvailable] = useState(false);
  const autoStarted = useRef(false);

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
      if (
        !ping.version ||
        compareVersions(ping.version, MIN_EXTENSION_VERSION) < 0
      ) {
        throw new Error(
          `Chrome Collector ${ping.version ?? "unknown"} is outdated. Reload extension ${MIN_EXTENSION_VERSION} before starting this run.`
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
            10 * 60_000,
            async (state) => {
              setMessage(
                `${index + 1}/${preparedJob.items.length}: Uploading ${item.siteName} — ${state.label}…`
              );
              await uploadCaptureState(runId, item, state);
            }
          );
          if (!extensionResult.ok || !extensionResult.summary) {
            throw new Error(extensionResult.error || "Chrome capture failed");
          }

          const summary = extensionResult.summary;
          const resultForm = new FormData();
          resultForm.set("action", "complete");
          resultForm.set("siteId", item.siteId);
          resultForm.set("missionId", item.missionId);
          resultForm.set("finalUrl", summary.finalUrl);
          resultForm.set("stateCount", String(summary.stateCount));

          setMessage(
            `${index + 1}/${preparedJob.items.length}: Finalizing ${summary.stateCount} ${item.siteName} evidence state${summary.stateCount === 1 ? "" : "s"}…`
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
          failureForm.set("action", "failure");
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

  // AUTO_START_RUN: the create-run action redirects here with `autostart=1`
  // when the operator's env asks collection to begin without a second click.
  // An interrupted run is left alone — resuming stays a deliberate choice.
  useEffect(() => {
    if (autoStarted.current) return;
    if (searchParams.get("autostart") !== "1") return;
    if (!canStart || needsRecovery) return;
    autoStarted.current = true;
    void claimChromeRun();
    // Fires once on arrival; claimChromeRun holds a browser lock until done.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex max-w-xl flex-col items-end gap-2">
      {needsRecovery && !busy && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-left text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">
          This Chrome run was interrupted — its browser tab stopped reporting.
          Resume to finish the dealers it never got to.
        </p>
      )}
      {/* `busy` keeps the button mounted on the driving tab: once its own
          heartbeat lands, the run reads as executing and `canStart` goes
          false, which would otherwise yank the progress affordance mid-run. */}
      {(canStart || busy) && (
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
