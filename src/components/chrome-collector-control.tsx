"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { withCollectorLock } from "@/lib/collector-lock";

const REQUEST_TYPE = "DEALER_INTEL_EXTENSION_REQUEST";
const RESPONSE_TYPE = "DEALER_INTEL_EXTENSION_RESPONSE";
const EVENT_TYPE = "DEALER_INTEL_EXTENSION_EVENT";
const PROTOCOL_VERSION = 5;
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
  /** Offer graphics the extension downloaded inside the dealer's page. */
  adImages?: { url: string; dataUrl: string }[];
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
  // Ad graphics the extension already downloaded inside the dealer's page.
  // Appended in pairs so the server can match each file to its source URL.
  for (const image of state.adImages || []) {
    const imageResponse = await fetch(image.dataUrl);
    if (!imageResponse.ok) continue;
    form.append("adImageUrl", image.url);
    form.append("adImage", await imageResponse.blob(), "ad");
  }

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
  isPaused,
  only,
  compact,
}: {
  runId: string;
  canStart: boolean;
  needsRecovery: boolean;
  /** Run is sitting paused (deliberate, not an interrupted tab) — same
   *  "Resume in Chrome" button as recovery, different notice copy. */
  isPaused?: boolean;
  /** Scope the job to one dealer+mission instead of the whole run — the
   *  row-level "Re-collect" after the operator fixed a saved URL. */
  only?: { siteId: string; missionId: string };
  /** Inline button sized for a table row. */
  compact?: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const autoStarted = useRef(false);
  const pauseRequestedRef = useRef(false);
  const [pauseRequested, setPauseRequested] = useState(false);

  async function startChromeCollection() {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    pauseRequestedRef.current = false;
    setPauseRequested(false);
    setMessage("Checking Chrome Collector…");

    let job:
      | {
          items: ChromeJobItem[];
          unresolved?: number;
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
        ...(only
          ? {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(only),
            }
          : {}),
      });
      if (!startResponse.ok) throw new Error(await responseError(startResponse));
      const preparedJob = (await startResponse.json()) as {
        items: ChromeJobItem[];
        unresolved?: number;
      };
      job = preparedJob;
      // Missions the server already failed for want of a URL. They never enter
      // the loop below, so counting only what the loop sees under-reported the
      // run: "53 succeeded, 1 failed" against 10 failures on the run page.
      failureCount = preparedJob.unresolved ?? 0;

      if (preparedJob.items.length === 0) {
        if (failureCount > 0) {
          setFailed(true);
          setMessage(
            `Nothing to collect: ${failureCount} mission${failureCount === 1 ? " has" : "s have"} no URL. Set one on the site's mission config.`
          );
        } else {
          setMessage("Chrome collection is already complete. Refreshing saved results…");
        }
        router.refresh();
        return;
      }

      for (const [index, item] of preparedJob.items.entries()) {
        if (pauseRequestedRef.current) {
          setMessage(
            `Paused after ${index}/${preparedJob.items.length} items. Resume anytime — nothing else was touched.`
          );
          await fetch(`/api/collector/runs/${runId}/pause`, {
            method: "POST",
          }).catch(() => undefined);
          router.refresh();
          return;
        }
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
        // The extension has one browser session. An inventory run already
        // driving it would lose its tab to this run's first dealer.
        await withCollectorLock(startChromeCollection, () =>
          setMessage(
            "An inventory run is using the Chrome Collector session. Inventory runs are short — wait for it to finish, then start this run again."
          )
        );
      }
    );
  }

  // AUTO_START_RUN: the create-run action redirects here with `autostart=1`
  // when the operator's env asks collection to begin without a second click.
  // An interrupted run is left alone — resuming stays a deliberate choice.
  useEffect(() => {
    if (autoStarted.current) return;
    // Row-level buttons never autostart — that flag means "start this run".
    if (only) return;
    if (searchParams.get("autostart") !== "1") return;
    if (!canStart || needsRecovery) return;
    autoStarted.current = true;
    void claimChromeRun();
    // Fires once on arrival; claimChromeRun holds a browser lock until done.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Row-level re-collect: one button, and the failure reason inline if the
  // extension refuses. Shares the run's browser lock, so it can't run beside a
  // whole-run collection.
  if (compact) {
    return (
      <span className="flex items-center gap-2">
        <button
          type="button"
          onClick={claimChromeRun}
          disabled={busy || !canStart}
          className="rounded-md border border-zinc-300 px-2.5 py-1 text-sm text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          {busy ? "Collecting…" : "Re-collect"}
        </button>
        {message && (
          <span
            className={`max-w-xs truncate text-xs ${
              failed ? "text-red-700 dark:text-red-400" : "text-blue-700 dark:text-blue-300"
            }`}
            title={message}
          >
            {message}
          </span>
        )}
      </span>
    );
  }

  return (
    <div className="flex max-w-xl flex-col items-end gap-2">
      {needsRecovery && !busy && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-left text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">
          This Chrome run was interrupted — its browser tab stopped reporting.
          Resume to finish the dealers it never got to.
        </p>
      )}
      {isPaused && !busy && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-left text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">
          Collection is paused. Resume to finish the dealers it never got to.
        </p>
      )}
      <div className="flex items-center gap-2">
        {busy && (
          <button
            type="button"
            onClick={() => {
              pauseRequestedRef.current = true;
              setPauseRequested(true);
              setMessage(
                "Pausing — waiting for the current mission to finish…"
              );
            }}
            disabled={pauseRequested}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Pause
          </button>
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
              : needsRecovery || isPaused
                ? "Resume in Chrome"
                : "Start in Chrome"}
          </button>
        )}
      </div>
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
    </div>
  );
}
