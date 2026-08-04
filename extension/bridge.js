const REQUEST_TYPE = "DEALER_INTEL_EXTENSION_REQUEST";
const RESPONSE_TYPE = "DEALER_INTEL_EXTENSION_RESPONSE";

function postResponse(requestId, response) {
  window.postMessage(
    { type: RESPONSE_TYPE, requestId, response },
    window.location.origin
  );
}

window.addEventListener("message", (event) => {
  if (
    event.source !== window ||
    event.data?.type !== REQUEST_TYPE ||
    typeof event.data?.requestId !== "string"
  ) {
    return;
  }

  const { requestId, command, payload } = event.data;
  try {
    chrome.runtime.sendMessage(
      { command, payload, collectionRequestId: requestId },
      (response) => {
        try {
          const runtimeError = chrome.runtime.lastError;
          postResponse(
            requestId,
            runtimeError
              ? { ok: false, error: runtimeError.message }
              : response
          );
        } catch (error) {
          postResponse(requestId, {
            ok: false,
            error:
              error instanceof Error
                ? `${error.message} Reload this Dealer Intel page.`
                : "Extension context was invalidated. Reload this Dealer Intel page.",
          });
        }
      }
    );
  } catch (error) {
    postResponse(requestId, {
      ok: false,
      error:
        error instanceof Error
          ? `${error.message} Reload this Dealer Intel page.`
          : "Extension context was invalidated. Reload this Dealer Intel page.",
    });
  }
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
