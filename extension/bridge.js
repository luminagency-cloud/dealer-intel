const REQUEST_TYPE = "DEALER_INTEL_EXTENSION_REQUEST";
const RESPONSE_TYPE = "DEALER_INTEL_EXTENSION_RESPONSE";

window.addEventListener("message", (event) => {
  if (
    event.source !== window ||
    event.data?.type !== REQUEST_TYPE ||
    typeof event.data?.requestId !== "string"
  ) {
    return;
  }

  const { requestId, command, payload } = event.data;
  chrome.runtime.sendMessage({ command, payload }, (response) => {
    const runtimeError = chrome.runtime.lastError;
    window.postMessage(
      {
        type: RESPONSE_TYPE,
        requestId,
        response: runtimeError
          ? { ok: false, error: runtimeError.message }
          : response,
      },
      window.location.origin
    );
  });
});

