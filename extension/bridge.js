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
  chrome.runtime.sendMessage(
    { command, payload, collectionRequestId: requestId },
    (response) => {
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
    }
  );
});

chrome.runtime.onMessage.addListener((message) => {
  if (
    message?.type !== "DEALER_INTEL_CAPTURE_STATE" ||
    typeof message.collectionRequestId !== "string" ||
    !message.state
  ) {
    return false;
  }
  window.postMessage(
    {
      type: "DEALER_INTEL_EXTENSION_EVENT",
      requestId: message.collectionRequestId,
      state: message.state,
    },
    window.location.origin
  );
  return false;
});
