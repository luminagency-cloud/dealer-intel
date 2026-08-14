# Dealer Intel Working List

_Last updated: August 7, 2026_

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
- For each dealer/site, selected missions run in one visible Chrome window
  driven by the extension, so mission buckets do not become separate browser
  jobs.
- A single dealer+mission can be re-collected on its own from the run page.
- Run progress is exposed through `src/app/api/runs/[id]/status/route.ts`, and
  `src/components/run-live-data.tsx` polls that endpoint instead of refreshing
  the whole run page for status-only updates.

### Analysis

Status: **implemented and configured**

- Rule-based extraction is the primary offer parser.
- Claude is a text-only low-confidence correction pass through
  `src/lib/analysis/ai-enrich.ts`, gated on `ANTHROPIC_API_KEY`. It corrects
  offer fields only — it does not write `offers.confidence`. Its self-reported
  number is kept in `normalized_json.aiConfidence` and shown in the AI chip's
  tooltip.
- `offers.confidence` measures how much of an offer the deterministic extractor
  verified, scored against the fields that offer type can actually carry. It is
  not a probability that the offer is real. See Implementation Notes → Analysis
  → Offer confidence.
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
- A running analysis can be stopped from the run page. The stop is cooperative:
  the loop exits after the page it is on, so a stop can take as long as one
  page's AI and OCR calls. Extracted offers are kept and `analysisCompletedAt`
  is left unset, so the run stays resumable — Resume Analysis continues at the
  first site with no offers, Re-run Analysis starts clean. Stopping is no
  longer a reason to delete a run.

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

- `.env` contains the news API configuration keys.
- News and inventory are wired into the current ops flow.
- Inventory runs through the inventory page/batch flow and appears in report
  views as an Inventory Snapshot section.
- Visible-Chrome inventory now has an adapter for every platform in the dealer
  table: Dealer.com (`ddc`), Dealer Inspire (`dealer_inspire`), DealerOn
  (`dealer_on`), Apollo (`apollo`), Dealer Alchemist (`dealer_alchemist`),
  Dealer Masters (`dealer_masters`), and Sokal (`sokal`). Each adapter owns its
  navigation, filtering, and count reading. Unknown platforms still fail
  closed. The sibling `dealer-inventory-api` fallback and its `INVENTORY_API_*`
  configuration were removed in 3.7.1 — visible Chrome is the only inventory
  collector.
- The Inventory page exposes one Run button plus a Cancel Run control that
  stops the queue and closes the Chrome collection window.
- The Chrome extension is the only collector. Every new run is created as
  `chrome_extension`.
- `AUTO_START_RUN=true` redirects to `/runs/<id>?autostart=1` and the run page
  claims the run on arrival. `AUTO_ANALYZE_AFTER_SCRAPE` is unchanged —
  collection finishes through `finalizeRunIfDone`.

### Reporting

Status: **implemented**

- Publishing creates immutable report snapshots.
- Offer/compliance report content reads from `report_snapshots` and
  `snapshot_offers`.
- Report pages can show snapshot history for a run group.
- Public report sharing uses snapshot share tokens.

## Actually Open

### Analysis Pipeline Redesign

Status: **implemented and verified against a live run (August 14, 2026)**. See
`Docs/Analysis Pipeline Redesign.md` for the checklist.

- `src/lib/analysis/runner.ts` is now pure job queue; the extraction/dedup/
  insert/grade logic lives in one atomic function,
  `runAnalysisForScope()` in `src/lib/analysis/pipeline.ts`, replacing the old
  `processAnalysis` / `startAnalysisForSiteMission` duplication.
- Fixed the live dedup bug: `offerSignature()` is now called from exactly one
  place and always includes `vehicleTrim`, so two offers differing only by
  trim no longer collide.
- Widget extraction (Scene7, Dealer Teamwork/MPOP) split into
  `src/lib/analysis/widgets/`. A `src/lib/analysis/platforms/` dispatcher
  (mirroring `extension/inventory/adapters/`) was also added, keyed off
  `sites.platform` — registry is empty for now (no platform-specific analysis
  logic exists yet), it's the seam for the first one that needs it.
- "Stop Analysis" relabeled "Pause Analysis".

Remaining: **collection still has no Pause/Resume control** (a runaway
collection can't be interrupted short of killing the process) — separate
follow-up, not started, not blocking.

### Service Coupon Adjudication

Status: **implemented (3.7.16); not yet seen on a live mismatched coupon**

An image service coupon whose OCR read disagreed with its alt text scored 0.50
(`mismatch`) — under the 0.6 publish floor, with nothing to adjudicate it. It
could not be routed to the AI enricher: the null-model condition is deliberately
guarded off for service (a service offer's model is always null by construction,
so without the guard every coupon would go to the vehicle-shaped enricher, which
would rewrite it into a vehicle offer), and the lowest service score is exactly
0.50 while that gate is `< 0.5`.

- `ClaudeCouponVerifier` in `src/lib/analysis/ai-enrich.ts` is the service-shaped
  sibling of `ClaudeOfferVerifier`: shown both readings, it answers only whether
  the kept OCR read is the offer the coupon advertises. Confirm/drop, no field
  rewriting. Gated on `ANTHROPIC_API_KEY` like every other AI pass; with no key
  the coupon keeps its 0.50 and its manual flag, exactly as before.
- `serviceCouponOffers()` in `runner.ts` calls it at reconciliation time, where
  both readings are still in hand, so every analysis path that produces coupons
  is covered.
- `applyCouponVerdict()` in `extract.ts` applies the ruling: a confirmed coupon
  takes the model's calibrated confidence (so a lukewarm confirm still does not
  publish), a dropped one is forced under the floor. The row is badged ✓/✕ with
  the model's one-line reason on the run page, and no longer reads as "check".
- The on-demand "Verify borderline" action skips coupons already adjudicated —
  its prompt is vehicle-shaped and knows nothing about the two readings.

Done when:

- A live run produces a real mismatched coupon and the verdict is right on it.

### Chrome Extension Collector

Status: **the only collector**. The Playwright collector was deleted in 3.9.0.

- The extension processes a selected suite sequentially, reusing one visible
  Chrome window for each dealer's missions and storing evidence through the
  existing model.
- Chrome runs heartbeat to the server on every result POST
  (`collection_runs.chrome_heartbeat_at`). A fresh heartbeat is what makes a
  run read as executing, which is what starts the run page's status polling —
  without it the mission list sat frozen until the run ended while only the
  collector's own status text moved. A heartbeat older than
  `CHROME_HEARTBEAT_STALE_MS` (3 minutes) means the driving tab is gone.
- Reopening an interrupted run no longer auto-resumes on mount. It shows an
  interrupted notice plus a Resume in Chrome button, which re-queues only the
  unfinished items. A browser lock prevents duplicate collection when the same
  run is open in two Dealer Intel tabs.
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
  offer-bearing disclaimer text. Run `cadbbb7b` matched the old collector's
  base-state evidence on Bristol Toyota's Dealer Alchemist finance page. The
  protocol-3 suite run `f644f98c` also established real DDC disclaimer capture
  and Dealer Inspire carousel/tab/disclaimer capture; Nucar Nissan stored 11
  carousel states and 21 labeled disclaimer states.
- The stateful evidence gate has passed on live DealerOn, DDC, and Dealer
  Inspire pages. Dealer Alchemist has matched base-state evidence; a live page
  exposing an ad-specific alternate disclaimer state was never found for that
  narrower platform check, and retirement went ahead without it. The retired
  collector was blocked by Cloudflare on 16 of 62 dealers, so holding Chrome to
  its evidence bar was holding it to a weaker collector.

Retirement removed, in 3.9.0:

- The run-page collector picker, the per-run "Use Current Collector" fallback,
  and `switchToCurrentCollector`.
- Server-driven collection actions: start-run/start-item, retry, force
  re-collect, pause, and resume. Re-collecting a single dealer+mission is the
  row-level Chrome control on the run page; the review queue links there
  instead of offering its own Retry.
- Bulk "re-collect selected" on the run page. It queued work for the in-process
  drainer, which no longer exists.

Verified for the Chrome collector:

- Missing/disabled extension preflight leaves the run untouched and reports
  why.
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
- Run every dealer on each platform as its own API-baseline batch and Chrome
  batch; accept only totals within two vehicles and complete make/status/model
  reconciliation via `scripts/compare-inventory-batches.mjs`. Dealer.com (38
  dealers) and Dealer Inspire (14) still need their full live matrices after
  the unpacked extension is reloaded. DealerOn (4), Apollo (3), Dealer
  Alchemist (1), Dealer Masters (1), and Sokal (1) have adapters but no matched
  batch yet — see the platform-adapter item below. The sibling inventory
  service comes out only after every platform passes.
- Those matrices now also have to prove per-make attribution, not just totals.
  Stored rows on multi-brand Dealer.com and Dealer Inspire stores had the whole
  store's model facet banked under one make, because the adapters verified the
  make filter by re-reading the query param they had written themselves.
  `inventoryTally.checkMakeScope` replaces that with page evidence and every
  facet-walking adapter routes through it; see Implementation Notes and
  `scripts/verify-inventory-make-scope.mjs`. The eight affected stored results
  need a recollect — they are not repaired in place.

### 1. Matched Batches For The New Inventory Platforms

Adapters exist for DealerOn, Apollo, Dealer Alchemist, Dealer Masters, and
Sokal, and every dealer on those platforms is now selectable on the Inventory
page. What has been proved so far is the data path, not a stored run: the
reader logic was executed against each live dealer site and reconciled to that
site's own advertised total.

- DealerOn: Balise Nissan 67, Paul Masse 356 (Buick 126 / GMC 230), Pride
  Hyundai 153, Station Buick GMC 298 (Buick 41 / GMC 257) — all exact against
  "Showing all N".
- Apollo: Shoreline CDJR 90 on-lot / 17 in-transit, Route 6 Kia 130 / 0, Toyota
  of Dartmouth 61 / 59 — make totals and model totals agree exactly.
- Dealer Alchemist: Bristol Toyota 52 on-lot, 48 in-transit — deduped child
  rows sum exactly to the advertised total for both.
- Dealer Masters: Kia of East Hartford 122 — matches the store's own "122
  vehicles found" and its make facet.

Done when:

- Each of those dealers has run as a real Chrome batch and an API-baseline
  batch, reconciled with `scripts/compare-inventory-batches.mjs`.
- Sokal has run at all. Its DataDome interstitial blocked every attempt to read
  Kia of Old Saybrook during development, so that adapter's model reader is the
  one piece here written from the sibling service's behavior rather than from
  the live page. Expect to correct it on first run.

`sites.brand` is the per-dealer make allow-list and is what every adapter
filters on. It is authoritative; when it disagrees with a live store, suspect
`sites.url` first. Station Buick GMC read as GMC-only on August 4 because its
URL still pointed at the separate GMC site; against its combined site the same
adapter returns Buick 41 and GMC 257, matching the record.

### 2. Dealer Alchemist Disclaimer Capture

Dealer Inspire disclaimer capture passed on live pages. The remaining narrow
risk is Dealer Alchemist: the current Bristol Toyota test page exposes no
ad-specific modal or alternate disclaimer state to capture.

Done when:

- A real Dealer Alchemist page with an ad-specific disclaimer interaction
  captures that text into `evidence.text_content`.
- Captured text is tied to the ad, not footer/legal boilerplate.

### 3. Report Trend Deltas

Snapshot history exists, but true current-vs-prior deltas are still backlog.

Done when:

- Reports compare the current published snapshot with the prior group snapshot.
- Deltas come from published snapshots, not live run data.

### 4. Month-To-Date Sales In Reports

Inventory is already in reports. Month-to-date sales is still unresolved.

Done when:

- Month-to-date sales has a known source.
- The ingestion and report model are defined, if we decide to include it.

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
- Remote operator access, Tailscale/NSSM, or deploying the admin app anywhere.
  Dealer Intel is installed on one local machine for one or two people who sit
  at it. Collection needs the operator's own Chrome and the extension, so there
  is nothing to remote into and nothing to host. The only deployed piece is the
  report viewer already on Vercel, which reads published snapshots.

## Before Calling Code Work Done

For code changes:

- Read the relevant Next.js docs in `node_modules/next/dist/docs/` before
  changing Next.js code.
- Bump `package.json` patch version.
- Run `npx tsc --noEmit`, `npm run lint`, and `npm run build`.
- Verify user-facing features in the running app.

For collector changes:

- Also verify against a real dealer site.
