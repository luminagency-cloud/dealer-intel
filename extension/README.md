# Dealer Intel Chrome Collector

Load-unpacked Chrome extension for visible-browser collection.

## Install For Development

1. Open `chrome://extensions` in desktop Chrome.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this `extension` directory.
5. Pin **Dealer Intel Chrome Collector** to the toolbar.
6. Reload the Dealer Intel page at `http://localhost:3000`.

After changing `manifest.json`, `bridge.js`, or `service-worker.js`, click the
extension's Reload button on `chrome://extensions` and reload the Dealer Intel
page.

## Current Suite Pilot

Chrome mode processes the complete selected run scope sequentially. Missions
for one dealer reuse one visible Chrome window before the extension advances to
the next dealer. Each result is uploaded before collection continues.

The suite pilot captures rendered HTML and one visible-viewport PNG for every
work item. Before and after its lazy-load scroll, it dismisses common privacy
and cookie panels (preferring a deny/reject action when available) so those
panels do not consume the evidence viewport. Full-page screenshots, durable
resume after the Dealer Intel tab is closed, shared-URL capture deduplication,
and exploration parity remain later work.
