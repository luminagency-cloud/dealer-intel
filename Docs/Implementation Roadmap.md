# Dealer Intel Working List

_Last updated: August 3, 2026_

This is the current human-readable status and backlog. If something is done, it
should not live here as future work.

## Product Truth

Dealer Intel is a collect -> analyze -> report platform.

1. **Collect** promotional evidence from dealer sites.
2. **Analyze** stored evidence into offers and compliance grades.
3. **Report** from published snapshots.

Collection stores raw evidence first. Analysis reads stored evidence. Core
offer/compliance reporting reads published snapshots, not live run data and not
dealer sites.

Inventory is operational context. Reports can show the latest inventory snapshot
beside the frozen offer snapshot, but inventory does not create offers,
compliance grades, or offer rankings.

## Current Verified Status

Secret values were not printed.

### Collection

Status: **implemented**

- Collection is dealer/site-scoped.
- For each dealer/site, selected missions run in one browser session through
  `collectSite`.
- Missions share a capture cache by URL + exploration signature, so mission
  buckets do not become separate browser jobs.
- A single-mission retry can still open its own fresh session.
- Run progress is exposed through `src/app/api/runs/[id]/status/route.ts`, and
  `src/components/run-live-data.tsx` polls that endpoint instead of refreshing
  the whole run page for status-only updates.

### Analysis

Status: **implemented and configured**

- Rule-based extraction is the primary offer parser.
- Claude is a text-only low-confidence correction pass through
  `src/lib/analysis/ai-enrich.ts`, gated on `ANTHROPIC_API_KEY`.
- Dealer Inspire Scene7 image ads are parsed directly from their structured URL
  parameters before OCR.
- Other image-only evidence is OCR'd through Mistral in
  `src/lib/analysis/ocr-mistral.ts`, gated on `MISTRAL_API_KEY`.
- Mistral OCR text is stored in `ocr_artifacts` for audit/debug and then passed
  through the deterministic extractor. Mistral reads the image; the app
  classifies the offer.
- `MISTRAL_API_KEY` is present in `.env`.
- The `ocr_artifacts` migration has been applied.
- Full-run analyses are queued in-process and run with `ANALYSIS_CONCURRENCY`
  parallel workers, defaulting to 1. This keeps an all-groups collection from
  starting many OCR/compliance-heavy analysis passes at once.
- Analysis rows remain run-scoped: analyzing a newer run no longer deletes the
  saved offers from earlier runs covering the same dealers.
- If Mistral returns 401 Unauthorized, OCR is disabled for that server process
  until the key is fixed and the app is restarted.

### Compliance

Status: **implemented and configured**

- `src/lib/analysis/compliance.ts` contains `AdScoreComplianceGrader`.
- `getComplianceGrader(runId)` selects AdScore when all `ADGRADER_*` variables
  are present.
- `.env` contains the AdScore configuration keys.
- If future grades fall back to stub, inspect server logs for the reason:
  missing screenshot, missing market state, API error, or 422 retry failure.

### News And Inventory

Status: **implemented and locally configured**

- `.env` contains the news and inventory API configuration keys.
- News and inventory are wired into the current ops flow.
- Inventory runs through the inventory page/batch flow and appears in report
  views as an Inventory Snapshot section.
- Inventory collection is moving to visible Chrome one platform at a time. The
  current pass supports Dealer.com (`ddc`) and Dealer Inspire
  (`dealer_inspire`) and fails closed for other platforms. Each adapter owns its
  navigation, filter containers, apply/settle behavior, and count reader. The
  sibling `dealer-inventory-api` remains the matched baseline until every
  dealer on the active platform passes.
- The Inventory page exposes separate API-baseline and Chrome run buttons plus
  a Cancel Run control that stops the queue and closes the Chrome collection
  window.

### Reporting

Status: **implemented**

- Publishing creates immutable report snapshots.
- Offer/compliance report content reads from `report_snapshots` and
  `snapshot_offers`.
- Report pages can show snapshot history for a run group.
- Public report sharing uses snapshot share tokens.

## Actually Open

### Chrome Extension Collector Pilot

Status: **first-order selectable pilot; the Current collector remains the
production fallback**. See `Docs/Chrome Extension Collector Plan.md`.

- Runs can select the Current collector or Chrome extension collector.
- The current collector remains the production fallback.
- The one-item and suite-transport proofs passed. The extension processes a selected suite
  sequentially, reusing one visible Chrome window for each dealer's missions
  and storing evidence through the existing model.
- Reloading or reopening a running Chrome run automatically resumes only the
  unfinished items. A browser lock prevents duplicate collection when the same
  run is open in two Dealer Intel tabs.
- The first matched baseline is Current run `f931930e`: Anchor Nissan Suite,
  five dealers, three missions per dealer, 15 pages, and 72 analyzed offers.
- Matched Chrome run `e6562632` also captured 15 base pages and settled every
  item successfully, but it predated stateful capture. Its similar offer counts
  prove suite transport, not compliance-evidence parity: it did not deliberately
  capture carousel slides, tabs, accordions, or opened disclaimers.
- Protocol 3 / extension 0.3.4 streams labeled UI states one at a time and waits
  for each authenticated upload before continuing. It captures a full-page base
  state plus mission-selected carousel, tab, accordion-expanded, and disclaimer
  states. HTML for alternate states is stored for audit but excluded from the
  normal HTML analysis input; disclaimer text remains first-class evidence.
- Extension 0.3.4 makes the desktop layout deterministic, waits for
  late-injected carousels, and retries transition-time no-op Next clicks. The
  extension pauses page-level carousel APIs and selects numbered slides by
  ordinal so uploads cannot race autoplay. The app rejects older extension
  patches before it changes run state.
- Live extension-0.3.4 run `8cd61846` completed Balise's current nine-slide
  DealerOn hero with a 9/9 ordered carousel manifest and stored its
  offer-bearing disclaimer text. Run `cadbbb7b` matched the Current collector's
  base-state evidence on Bristol Toyota's Dealer Alchemist finance page. The
  protocol-3 suite run `f644f98c` also established real DDC disclaimer capture
  and Dealer Inspire carousel/tab/disclaimer capture; Nucar Nissan stored 11
  carousel states and 21 labeled disclaimer states.
- The stateful evidence gate has passed on live DealerOn, DDC, and Dealer
  Inspire pages. Dealer Alchemist has matched base-state evidence, but a live
  page exposing an ad-specific alternate disclaimer state is still needed for
  that narrower platform check.

Verified for the selectable pilot:

- Missing/disabled extension preflight leaves the run untouched and presents a
  clear switch to the Current collector.
- A Chrome proof run stores evidence in the existing model and reaches the
  normal ready-to-analyze state.
- Balise pauses its advertised homepage carousel, captures every unique active
  slide, and stores disclosures only for slides whose opened text contains real
  price/APR/payment terms. The original regression exposed 12 slides; the
  current live proof exposed and captured all 9. Award/brag-slide boilerplate
  is not offer-disclaimer evidence.
- DealerOn, Dealer Inspire, and DDC proof runs establish live platform coverage
  for carousel, tab/accordion, and ad-specific disclaimer states. Dealer
  Alchemist currently has live base-state parity.
- `node scripts/compare-evidence-manifests.mjs <current> <chrome> [site]`
  reports manifest parity by dealer, mission, and state kind.

Remaining before making Chrome the default or retiring Current:

- Verify a Dealer Alchemist page that actually exposes an ad-specific
  disclaimer state; the current Bristol Toyota page exposes only the base state
  to both collectors.
- Exercise interrupted-run recovery and the same evidence checks on macOS.
- Visible-Chrome inventory now has separate Dealer.com and Dealer Inspire
  adapters. Run every dealer on each platform as its own API-baseline batch and
  Chrome batch; accept only totals within two vehicles and complete
  make/status/model reconciliation via `scripts/compare-inventory-batches.mjs`.
  Dealer.com still needs its full live matrix after the unpacked extension is
  reloaded. Dealer Inspire needs the same 14-dealer matrix. After both pass,
  build and verify separate DealerOn, Apollo, and remaining-platform adapters
  before removing the sibling inventory service.

### 1. Dealer Alchemist Disclaimer Capture

Dealer Inspire disclaimer capture passed on live pages. The remaining narrow
risk is Dealer Alchemist: the current Bristol Toyota test page exposes no
ad-specific modal or alternate disclaimer state to either collector.

Done when:

- A real Dealer Alchemist page with an ad-specific disclaimer interaction
  captures that text into `evidence.text_content`.
- Captured text is tied to the ad, not footer/legal boilerplate.

### 2. Report Trend Deltas

Snapshot history exists, but true current-vs-prior deltas are still backlog.

Done when:

- Reports compare the current published snapshot with the prior group snapshot.
- Deltas come from published snapshots, not live run data.

### 3. Month-To-Date Sales In Reports

Inventory is already in reports. Month-to-date sales is still unresolved.

Done when:

- Month-to-date sales has a known source.
- The ingestion and report model are defined, if we decide to include it.

### 4. Remote Operator Access

Status: **planned, not yet implemented**. See
`Docs/-future/Remote Operator Setup Plan.md`.

Done when:

- Tailscale + NSSM are set up so a second, non-technical operator can drive
  collection from the operator's own persistent machine without installing
  Node/Git/Playwright or touching `.env`.
- The sibling `dealer-inventory-api` local start requirements are verified.

## Not Currently Open

Do not re-add these as tasks unless new evidence proves they are broken:

- Build the collector.
- Build missions.
- Consolidate collection into one browser session per dealer/site.
- Build evidence storage.
- Build analysis.
- Build snapshot publishing.
- Build reports.
- Wire AdScore code from scratch.
- Add an Anthropic key locally.
- Add a Mistral key locally.
- Apply the OCR artifacts migration.
- Build run-page progress polling.
- Decide whether inventory belongs in reports.
- Wire news from scratch.
- Wire inventory from scratch.

## Before Calling Code Work Done

For code changes:

- Read the relevant Next.js docs in `node_modules/next/dist/docs/` before
  changing Next.js code.
- Bump `package.json` patch version.
- Run `npx tsc --noEmit`, `npm run lint`, and `npm run build`.
- Verify user-facing features in the running app.

For collector changes:

- Also verify against a real dealer site.
