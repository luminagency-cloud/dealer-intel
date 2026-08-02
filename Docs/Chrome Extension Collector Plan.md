# Chrome Extension Collector Migration Plan

_Created: August 1, 2026_

## Goal

Add a second collection backend that runs inside the operator's installed,
visible Google Chrome browser on Windows or macOS. The extension feeds the
existing run, mission-result, evidence, analysis, snapshot, and reporting
model. It does not connect directly to Postgres and it does not replace the
current collector until it has proven parity.

## Product Boundary

Dealer Intel remains a collect -> analyze -> report platform.

- Collection visits dealer sites and stores raw evidence.
- Analysis reads stored evidence only.
- Reporting reads published snapshots only.

The Chrome extension changes how collection is executed. It does not create a
second analysis or reporting system.

## Run-Level Collector Selection

Every run records one collection mode:

- `current`: the existing server-side collector.
- `chrome_extension`: the installed Chrome extension.

Collector selection is per run, not global. Two equivalent runs can therefore
be created for the same dealer group and cycle to compare collectors without
mixing their evidence.

## Hard Preflight And Fallback

Chrome collection must not change run state until the browser page confirms
that the extension is installed, enabled, responsive, and version-compatible.

If preflight fails:

- no mission result is started,
- no evidence is written,
- the run remains pending,
- the UI shows the specific failure,
- the operator can retry or switch that run to the current collector.

If Chrome collection fails before writing evidence, the same run can be reset
to pending and switched to the current collector. Once Chrome evidence exists,
the safe fallback is a replacement run with the same scope; collector outputs
must not be mixed silently.

## Architecture

```text
Dealer Intel run
       |
       +-- current ----------> existing collector
       |
       +-- chrome_extension -> Chrome extension -> visible dealer tab
                                      |
                                      v
                         authenticated Dealer Intel API
                                      |
                                      v
                           existing Postgres + R2 evidence
                                      |
                                      v
                         existing analysis -> snapshot -> report
```

The extension receives scoped job instructions from the authenticated Dealer
Intel page. It returns rendered HTML, visible screenshots, final URLs, labels,
and errors through application APIs. Storage credentials and database
credentials remain server-side.

## Delivery Phases

### Phase 1: One-Item Proof

- Add per-run collector mode.
- Add extension presence/version preflight.
- Load the extension unpacked in developer mode.
- Support a run containing exactly one dealer and one mission.
- Open a visible Chrome window.
- Capture rendered HTML and a visible screenshot.
- Store both in the existing evidence model.
- Complete the existing mission result and run lifecycle.
- Analyze and report using the existing pipeline.
- Preserve a one-click switch to the current collector before evidence exists.

This phase intentionally does not claim collector parity.

### Phase 2: Site-Scoped Collection

- Process all selected missions for one dealer in one visible Chrome session.
- Process selected dealers sequentially for matched-suite comparisons.
- Upload and settle each mission result before advancing to the next item.
- Share captures by URL and exploration signature.
- Preserve the existing site-scoped session and capture-cache semantics.
- Persist progress so a page reload does not lose the active job.
- Move inventory collection through the same visible-Chrome job mechanism and
  continue writing the existing inventory result model.
- Preserve the inventory page's authoritative totals and current report
  semantics while replacing only how the source pages are collected.
- After inventory parity is verified, retire the local
  `dealer-inventory-api` process dependency and the
  `src/lib/local-inventory-process.ts` health/autostart check.

### Phase 3: Exploration Parity

- Known and learned URL handling.
- Navigation discovery.
- Lazy-load scrolling.
- Cookie and overlay handling.
- Tabs, accordions, carousels, and disclaimers.
- Failure screenshots and review statuses.

### Phase 4: Multi-Dealer Runs

- Harden multi-dealer execution beyond the sequential suite pilot.
- Pause, resume, retry, and reconnect behavior.
- Clear Chrome/device status in the admin UI.
- Windows and macOS verification.

### Phase 5: Operational Cutover

- Compare matched runs across difficult dealer platforms.
- Define evidence-parity and success-rate gates.
- Publish the extension through an unlisted Chrome Web Store listing for
  installation and automatic updates.
- Retire the current collector only after an explicit cutover decision.

## Development Installation

During development the extension is loaded without the Chrome Web Store:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this repository's `extension` directory.
5. Reload the extension after changing its manifest, service worker, or
   content script.

The development artifact is an unpacked extension directory, not an APK.

## Success Criteria For The Proof

- Absence of the extension produces a clear error without starting the run.
- Switching to the current collector works immediately before evidence exists.
- Chrome visibly opens the configured dealer URL.
- The captured HTML and screenshot appear in the existing evidence view.
- The run reaches its normal terminal collection state.
- Existing analysis can process the Chrome-collected evidence without a
  special analysis path.
- The current collector remains unchanged and available.

## Current Matched-Suite Test

The first suite comparison uses Current collector run `f931930e` as the
baseline: Anchor Nissan Suite, five dealers, three missions per dealer, 15
settled collection results/pages, and 72 analyzed offers. The Chrome run must
use that same stored group and mission scope before its collection and analysis
outputs are compared.

Completed comparison:

- Chrome run: `e6562632`; Current baseline: `f931930e`.
- Both collected 15 pages across the same five dealers and three missions.
- Chrome settled 15/15 results as success. Current settled 13 as success and
  two as needs-review while still capturing all 15 pages.
- Chrome analysis produced 78 total / 73 publishable offers. Current produced
  72 total / 67 publishable offers.
- Publishable counts matched exactly for Anchor Nissan, Nucar Nissan, Speedcraft
  Nissan, and Tasca Nissan. The six-offer publishable delta is entirely Balise.
- The saved Balise finance pages contain the same six vehicle offer blocks,
  seven APR phrases, and fourteen customer-cash phrases. Their rendered text is
  materially the same, so the Balise count delta points to extraction/deduping
  variance rather than seven additional dealer advertisements.
- Tasca differs by one non-publishable finance extraction; its publishable
  result is identical.

Conclusion: suite-scale Chrome collection parity passed this test. Analysis
count parity did not; the next comparison work is deterministic offer identity
and deduplication at Balise, not another scraping workaround.

## Explicit Non-Goals For Phase 1

- Replacing the current collector.
- Full mission discovery parity.
- Running multi-group Chrome collections.
- Publishing through the Chrome Web Store.
- Moving the online application to a new host.
- Reworking analysis into a durable cloud workflow.
- Moving inventory collection in phase one. Inventory joins the extension path
  in phase two; the existing inventory process remains available until parity
  is proven.
