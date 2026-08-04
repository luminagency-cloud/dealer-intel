# Implementation Notes

_Last updated: August 3, 2026_

This is the compact map of how the system works. The open work list lives in
`Docs/Implementation Roadmap.md`.

## The Shape Of The System

Dealer Intel is a collect -> analyze -> report pipeline.

Collection creates raw evidence. Analysis reads evidence and creates structured
offers/compliance grades. Reporting reads published snapshots.

Captured disclaimer text is analyzed as one bounded promotion. Lease-payment
and APR alternatives are split inside that disclosure and each term is resolved
against its own anchor, preventing a finance term from leaking into a lease row.

The important boundary: analysis never scrapes, and core offer/compliance
reporting never reads live run data or visits dealer sites.

Reports may show latest inventory as an operational side section. That
inventory context does not create offers, compliance grades, or offer rankings.

## Collection

Collection is dealer/site-scoped.

A run selects:

- sites: all, group, or ad-hoc checkbox selection,
- missions: all active missions or selected missions.

For each site, the run executor groups selected missions together and calls
`collectSite`.

`collectSite` opens one browser session for that site, runs the selected
missions inside it, and shares a capture cache by URL + exploration signature.
If a mission captures zero pages, it gets one fresh-session retry.

Run progress is persisted to `mission_results` and exposed through
`src/app/api/runs/[id]/status/route.ts`. The run page polls that narrow status
endpoint through `src/components/run-live-data.tsx`.

Each run now records a collection backend. `current` uses the existing
server-side collector. `chrome_extension` is the incremental visible-browser
pilot documented in `Docs/Chrome Extension Collector Plan.md`. Both paths must
write the same mission-result and evidence model; analysis has no
collector-specific branch. The Chrome pilot performs extension preflight before
starting and can switch an evidence-free attempt back to the Current collector.
The suite pilot seeds the whole selected scope, processes work sequentially,
and reuses one visible Chrome window for all selected missions on a dealer.
Chrome progress is database-backed: reopening or reloading a running run
automatically resumes only its unfinished items, while a browser lock prevents
two Dealer Intel tabs from driving the same run.

Chrome protocol 4 is stateful. The extension prepares the visible page, expands
mission-selected accordions, captures a true full-page base image through the
Chrome DevTools protocol, then opens and captures selected tabs, carousel
slides, and ad disclaimers. Each state carries a stable id, kind, order, label,
resulting URL, rendered HTML, screenshot, and optional extracted disclaimer
text. The extension sends one state to the authenticated app page and waits for
its upload acknowledgement before changing the UI again. Stable capture keys
make interrupted uploads safe to retry. A partial interaction failure becomes
`needs_review` when any evidence was already stored.

The app currently requires extension 1.2.0 or newer. Collection windows open
maximized for deterministic desktop layouts. Primary-carousel discovery polls
for late widget injection, and traversal retries transient/no-op Next clicks so
an animation-time disabled control does not silently truncate the manifest.
Numbered carousels are selected by ordinal and paused through their page-level
widget API so a disclosure upload cannot let autoplay skip the next slide.

Carousel exploration is state-driven, not count-driven. The extension pauses
autoplay, reads the platform's active slide identity and any ordinal/total (for
example `slide 4 of 12`), captures that state, advances, and stops when the
identity repeats or the advertised final ordinal is reached. A safety ceiling
only prevents a broken widget from looping forever. Disclaimers are opened
while their exact slide remains active and are retained only when the opened
text contains price, APR, monthly-payment, or due-at-signing terms.

Inventory uses the same visible Chrome extension transport while preserving the
existing inventory result and reporting models. Platform behavior is isolated:
`extension/inventory.js` dispatches only to a registered adapter. The current
pass registers Dealer.com (`ddc`) and Dealer Inspire (`dealer_inspire`). Other
platforms fail closed until they get an adapter, and `extension/inventory.js`
sniffs the live page when `sites.platform` (free text) matches no adapter.

**Hard rule: models are only ever read with a single make selected.** An
unfiltered SRP yields a whole-dealership model dump, which is wrong for any
multi-brand store and silently corrupts reporting. On Dealer.com the site
enforces this too — the `model` facet group does not exist in the DOM until a
make is applied. Adapters therefore loop one make at a time, apply it, and only
then read models. Verified live on a CDJR store: `?make=Chrysler&status=1-1`
returns Pacifica 3 + Voyager 4 = 7, matching its "7 Vehicles Matching" exactly.

Navigation and filtering are URL-driven, not click-driven.
`extension/inventory/navigate.js` resolves the SRP in tiers — page already
loaded, stored `sites.inventory_path`, platform default
(`/new-inventory/index.htm`, `/new-vehicles/`), then href-ranked link discovery
— and every failure records what each tier saw. Filters are applied by
navigating: Dealer.com uses `?make=<Make>&status=1-1` (on the lot) and
`status=7-7` (in transit); Dealer Inspire uses LightningVRP's `_dFR[...]`
refinements. These are public URL contracts the dealer's own site links to, so
they outlast the DOM churn that broke the previous menu/facet click paths. Each
adapter verifies the filter actually applied and records zero with a warning
rather than reporting unfiltered counts.

Two DDC DOM traps the reader must keep handling: facet panels render collapsed
and populate `.panel-collapse` only on expand (so a container holding zero
controls is normal, not absent), and the inner `.panel-collapse` div carries an
id containing the facet name — facet containers must be matched by
`data-facet-group` before falling back to `id`, or the reader latches onto the
inner div, which has no expand control and always reads empty.

`extension/inventory/shared.js` is intentionally limited to popup suppression,
timeouts, cancellation, and guaranteed cleanup. It has no
navigation, selector, apply, or count-reading knowledge. Dealer
Inspire normalizes both visible status variants (`On Lot` or `In-Stock`, plus
`In-Transit`) without leaking either implementation into shared code. Each
make/status model sum must reconcile exactly to its subtotal, and an adapter's
visible total may differ from its model sum by at most two vehicles.
The Inventory toolbar exposes a shared Cancel Run control for Chrome and API
batches. Cancellation aborts the page driver, closes the visible collection
window, and persists queued/running rows as cancelled without replacing the
dealer's latest completed inventory snapshot.
The normal Chrome batch budgets 25 seconds of setup plus 25 seconds per
configured make, since URL-driven collection costs about two page loads per
make rather than a chain of click-and-settle waits. Anything that cannot finish
inside that make-scaled ceiling fails fast into a guided exception rerun. Every inventory
request closes its dealer window after success or failure, and the extension
uses the same make-scaled ceiling plus a five-second safety cleanup grace for a
lost app/bridge response. The active window id is also persisted in extension
storage so service-worker restart recovery closes it before another dealer opens.
After a dealer timeout, the app confirms that the extension session was reset
before opening the next dealer. A lost or invalidated extension message channel
stops the driver immediately, cancels unfinished rows, and releases the run
controls instead of cascading the transport error across the remaining sites.
Completed dealer results remain intact and unfinished dealers can be rerun
individually.
Menu links that open a new tab are adopted into the tracked collection tab and
the untracked child is closed before collection continues.
The unchanged `dealer-inventory-api` and `src/lib/local-inventory-process.ts`
remain available during matched-result verification and should be removed only
after platform parity is established.

One matched pair is checked with
`node scripts/compare-inventory-batches.mjs <api-batch> <chrome-batch>`.
When an API fallback reports transit as unknown, the verifier compares its
combined model/make/total counts to Chrome's on-lot-plus-transit counts while
still requiring Chrome's status rows to reconcile internally.

Key files:

- `src/lib/run-executor.ts`
- `src/lib/collector/mission-runner.ts`
- `src/lib/collector/engine.ts`
- `src/lib/collector/mission-knowledge.ts`
- `src/lib/collector/explorers.ts`
- `src/lib/collector/overlays.ts`

## Missions

Missions are collection targets, not business goals.

They answer:

- where should we look on this dealer site?
- how should we explore that page?

The global mission row defines the mission type. The per-dealer
`site_missions` row stores learned/configured URLs.

Homepage offers and promotional banners can remain separate mission types
without double-fetching because the capture cache dedupes shared pages.

## Evidence

Evidence is the canonical raw record.

Stored evidence includes:

- full-page screenshots,
- HTML snapshots,
- failure screenshots,
- disclaimer screenshots,
- captured disclaimer text on `evidence.text_content`.

Stateful Chrome evidence also records `capture_key`, `capture_state_id`,
`capture_state`, `source_url`, and `capture_order`. The base state's HTML uses
`html_snapshot` and remains normal analysis input. Alternate-state HTML uses
`state_html_snapshot`: it is retained for audit and manifest comparison but is
deliberately excluded from offer extraction so one rotating ad is not parsed
again merely because its surrounding page was captured in several UI states.

Evidence files live in R2. Database rows store object keys and metadata.

Key files:

- `src/lib/evidence.ts`
- `src/components/evidence-section.tsx`
- `src/app/(admin)/runs/[id]/evidence/[siteId]/page.tsx`

## Analysis

Analysis is re-runnable and does not visit dealer sites.

The runner reads stored evidence, extracts offers, grades compliance, and writes
results back to analysis tables.
Each run keeps its own analysis rows. Re-analyzing one run replaces only that
run's offers and grades; it does not erase analysis from earlier runs that cover
the same dealers.

Rule-based extraction handles the normal path. Claude is a secondary,
text-only pass for low-confidence corrections when `ANTHROPIC_API_KEY` is
configured. Dealer Inspire Scene7 image ads are parsed from their structured
image URL parameters before OCR, because those URLs carry the rendered lease,
finance, vehicle, and disclaimer terms. Other image-only pages (zero DOM-text
offers) are OCR'd with Mistral (`MISTRAL_API_KEY`) and run through the same
deterministic extractor as DOM text — Mistral reads the image, the app
classifies it. OCR text is stored in `ocr_artifacts` (one row per screenshot)
for audit/debug before deterministic extraction. `MISTRAL_API_KEY` is present
locally and the `ocr_artifacts` migration has been applied.

Structured vehicle-special pages are analyzed card-first: fields are bounded to
the repeated DOM card before lease and APR alternatives are separated. A cash
offer means an explicitly advertised vehicle purchase price. Customer cash,
bonus cash, rebates, and discounts do not create cash rows and are not attached
to lease or finance rows.

Full-run analysis jobs are queued in-process and limited by
`ANALYSIS_CONCURRENCY` (default: 1) so auto-analysis after a large collection
does not run many OCR/compliance-heavy passes at once. The runner does not keep
raw screenshot buffers in a run-wide cache; it fetches screenshot bytes only for
the current page/ad operation.
The run page reconstructs its completed page/offer summary from persisted
evidence counts, offers, and analysis timestamps, so reopening a run does not
lose the final analysis summary when the in-memory progress counter is gone.

AdScore compliance is implemented through `AdScoreComplianceGrader` and is used
when all `ADGRADER_*` variables are configured. Otherwise the system falls back
to the deterministic stub grader.

Key files:

- `src/lib/analysis/runner.ts`
- `src/lib/analysis/extract.ts`
- `src/lib/analysis/compliance.ts`
- `src/lib/analysis/ai-enrich.ts`
- `src/lib/analysis/ocr-mistral.ts`
- `src/components/analysis-section.tsx`

## Reporting

Publishing creates an immutable snapshot from the current run analysis.

Core report offer/compliance data reads only:

- `report_snapshots`,
- `snapshot_offers`,
- linked evidence files.

Re-running collection or analysis does not mutate an already-published
snapshot.

Report pages can also load latest inventory rows for the report's dealer group
and render them as an Inventory Snapshot section. Snapshot history is shown for
admin users when a run group has prior snapshots; true current-vs-prior report
deltas are still backlog.

Key files:

- `src/lib/snapshot.ts`
- `src/app/(admin)/reports/`
- `src/components/report/ReportContent.tsx`
- `viewer/`

## Operations

The weekly operator flow is:

1. Create or reuse a group-scoped run.
2. Start collection.
3. Review failures only.
4. Run analysis.
5. Load news and inventory if needed.
6. Publish snapshot.
7. Share report through the viewer.

The admin app needs a persistent Node process because Playwright and background
run execution live in-process. Do not target serverless for the admin app.

The viewer app is separate and can run on Vercel because it only reads
published report data.

## Data And Config

Database schema changes go through Drizzle:

1. edit `src/lib/db/schema.ts`,
2. run `npm run db:generate`,
3. run `npm run db:migrate`.

Do not hand-write migrations.

Configuration convention:

- this workspace uses `.env` for local configuration,
- user-facing setup messages should refer to `.env`,
- `drizzle.config.ts` may load legacy files for compatibility, but `.env` is
  the active convention.

## Keep In Mind

- Collection should be broad and evidence-first.
- Business interpretation belongs in analysis/reporting, not collection.
- Reports should stay deterministic and snapshot-backed.
- A full ungrouped run is slow; group runs are the normal operating unit.
