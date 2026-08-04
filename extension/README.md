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

## Stateful Evidence Pilot

Chrome mode processes the selected run scope sequentially. Missions
for one dealer reuse one visible Chrome window before the extension advances to
the next dealer.

Protocol 4 / extension 1.2.0 captures a full-page base state and the mission-selected tabs,
carousel slides, accordion-expanded content, and opened ad disclaimers. Every
state is labeled and includes rendered HTML plus a screenshot; disclaimer states
also carry extracted modal text. The extension sends and waits for the app to
store each state before moving to the next interaction. Common consent,
promotional-modal, and chat obstructions are suppressed before capture.
Consent handling allows third-party promotional content before falling back to
a rejection action, because some Dealer Alchemist offer widgets are otherwise
replaced by a content-blocked placeholder.

Carousel traversal pauses autoplay and follows the widget's active-slide state
until that identity repeats. Detection waits for late-injected widgets, and a
temporarily disabled Next button is retried instead of being mistaken for the
end, so a 12-slide hero can produce all 12 labeled states instead of an
arbitrary first five. A disclaimer is opened on its active slide and stored
only when the resulting text contains real offer terms; award and other
brag-slide legal copy is skipped.

Visible inventory collection is being rolled out one platform at a time. The
current pass supports Dealer.com (`ddc`) and Dealer Inspire
(`dealer_inspire`) and fails closed for every other platform. Each adapter owns
its navigation, filter containers, apply/settle behavior, and count reading.
Dealer Inspire follows visible `/new-vehicles/` navigation and LightningVRP
dialogs, normalizing `On Lot` and `In-Stock` as on-lot inventory. Both adapters
select Make before Model on multi-brand sites and exclude build/order statuses.
Every make subtotal must reconcile exactly to its model rows, and the adapter's
visible total must be within two vehicles of those model counts before the
result can be stored.

The shared inventory runtime is deliberately limited to popup suppression,
exclusive option selection, timeouts, cancellation, and guaranteed collection-
window cleanup. Each configured make receives a 60-second budget, so a four-make
CDJR dealer receives up to four minutes while a single-make dealer keeps the
one-minute ceiling. Inventory links that open a child tab are adopted back into
the tracked tab and the child is closed immediately.

Compare one API baseline batch with its matching Chrome batch using:

```powershell
node scripts/compare-inventory-batches.mjs <api-batch> <chrome-batch>
```

The command fails if totals differ by more than two vehicles or make, status,
and model rows do not fully reconcile. If the API fallback cannot split transit,
its combined counts are compared with Chrome's on-lot-plus-transit counts.

Disclosure discovery runs in every accessible frame and recognizes semantic
buttons plus Dealer Inspire/Dealer Alchemist div-based toggles. Expanded inline
panels are captured the same way as modal dialogs.

Full-page capture uses the extension's `debugger` permission solely to call the
Chrome DevTools screenshot command for the active dealer tab. Chrome may show a
debugging notification while that base screenshot is taken. Close DevTools on
the collection tab if Chrome reports that another debugger is already attached.

After updating, reload both the unpacked extension and the Dealer Intel page.
The app deliberately rejects older protocol versions and extension builds older
than 1.2.0 before changing run state.
