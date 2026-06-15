# Implementation Notes

Living record of what is built, where it lives, and decisions made along the
way. Read alongside `Implementation Roadmap.md` (the plan) and
`architecture-decision.md` (the principles).

## Status: Phases 1–12 built (June 2026)

| Phase | State | Notes |
|---|---|---|
| 1 Foundation | Done | Next.js 16 + TS, Neon Postgres (Drizzle), Cloudflare R2, NextAuth single-operator login |
| 2 Core Data Model | Done | All 7 entities + run_groups/run_group_members/mission_results beyond plan. site_relationships has no UI by design (collection is competition-blind; reporting consumes it in Phase 12) |
| 3 Run Management | Done | Lifecycle pending → running → review → published / failed |
| 4 Evidence Infrastructure | Done | R2 keys in Postgres, presigned GETs via `/api/evidence/[id]/file`, viewer + manual upload on run page |
| 5 Collector Engine | Done | Playwright/Chromium; overlay dismissal, page scroller, full-page screenshot + HTML |
| 6 Mission Framework | Done | Multi-URL missions, URL discovery with learning, carousel/tab/accordion/disclaimer explorers |
| 7 Review Workflow | Done | mission_results per run+mission, background execution, review queue (`/review`) with Retry / Fix URL / Content Removed |
| 8 | Done | Collection Consolidation & Site Learning. Single-visit-per-site, shared capture cache (URL+explore dedup), fresh-session retry of zero-capture missions, sites.last_collected_at freshness + UI, auto-publish on quality threshold. |
| 9 | Done | Evidence Analysis. Rule-based extraction over stored HTML snapshots (classification + normalization → offers), compliance pass behind a `ComplianceGrader` interface (stub now, real endpoint drops in later). Background, re-runnable per run. Multi-offer per page via payment-anchor windowing (v1.0.27). AI deferred to Phase 12 by design; confidence score routes weak cases there. |
| 10 | Done | Snapshot Publishing — the wall between analysis and reporting. Publishing a run **freezes** its current offers + compliance grades into `report_snapshots` + `snapshot_offers` (denormalized, immutable). Re-running analysis or re-collecting never changes a published snapshot. Snapshots list at `/snapshots`; "Publish Snapshot" on the run page. |
| 11 | Live (v2 polish in progress) | Reporting Engine — live in browser, pure reads from published snapshots, links to R2 images. Competitive report per snapshot at `/reports/[id]`: offers grouped by vehicle (primary dealer highlighted, lowest payment flagged), compliance roll-up, group snapshot history, CSV export. Trend deltas (per-metric change vs prior snapshot) deliberately deferred to a v2. v1.0.32 polish: 18px→16px base font (Tailwind rem sizing corrected), `containerClassName` prop on `ReportContent` removes double padding in admin context, cash section bullet suppressed when empty, n/a compliance grades excluded from roll-up display ("n/a" is stub sentinel, not a real grade). |
| 12 | Built (gated; key pending) | AI-Assisted Analysis. Secondary, confidence-routed pass (`src/lib/analysis/ai-enrich.ts`): low-confidence rule-based offers are re-extracted by Claude via structured output; rule-based still handles the routine majority. Behind an `OfferEnricher` interface gated on `ANTHROPIC_API_KEY` (no-op without a key). tsc/lint clean; live model verification pending API key. |

## Architecture: three-phase pipeline (decided June 2026)

The platform is a **collect → analyze → report** pipeline with a hard wall
between each phase:

- **Collection** — visit sites, grab everything promotional, store raw evidence
  in R2. Comprehensive and reliable. A missed collection breaks everything
  downstream. No interpretation happens here.
- **Analysis** — independent passes over stored evidence: classification,
  normalization, compliance (external API call). Passes are re-runnable and
  many-to-many: one piece of evidence can be consumed by multiple passes
  (specials report + compliance check) without re-collecting.
- **Reporting** — pure reads from published analysis snapshots. No site access,
  no computation.

Collection is **group-scoped** (primary dealer + competitors) and
**time-gated** (~weekly). A site with a fresh collection is ready for analysis.
Failed sites are handled separately; they don't block the group.

## The mission layer (reworked June 2026)

Missions are **collection targeting configs**, not business goals. A mission
answers: where do we look on a site, and how do we explore those pages?
Business goals (specials comparison, compliance audit) are expressed at the
analysis and reporting layers, not here.

Structure:

- `missions` — the global layer (~4 rows): name + mission_type (collection
  strategy) + active. CRUD at `/missions`. mission_type maps to discovery
  paths and exploration flags in `src/lib/collector/mission-knowledge.ts`.
- `site_missions` — per-dealer URL config + collector memory (last_known_url,
  alternate_urls, last_success_at, per-pair active). Edited on the **site's
  edit page**, written to by the collector when it learns a URL.
- A run executes **work items**: scoped sites x selected missions
  (`listWorkItemsForRun`). mission_results are unique per
  (run, site, mission).
- Run creation picks scope (all / group / ad-hoc dealer checkboxes) AND
  missions (checkboxes, default all; subset stored in
  collection_run_missions).

Note: `homepage_offers` and `promotional_banners` remain distinct mission
types but no longer double-fetch. Phase 8's per-site capture cache keys on
URL + exploration signature, so two missions that resolve to the same page
with the same explorers (the homepage, carousels + disclaimers) share one
fetch and each still get their own per-mission evidence + result. A full enum
merge was deliberately not done — the cache makes it unnecessary.

## Deletes

Full CRUD everywhere; destructive deletes confirm first and clean up R2 via
`src/lib/deep-delete.ts`:
- Delete run → its evidence rows + R2 objects, results, offers, snapshots.
- Delete site → its configs, memberships, results, evidence rows + R2.
- Delete mission → per-site configs and results (captured evidence stays;
  it is keyed by run/site).
- Delete group → memberships only; runs that referenced it become ungrouped.

## Key modules

- `src/lib/collector/engine.ts` — generic browser session: navigation,
  overlay suppression, scrolling, capture. No business meaning (AD-003).
- `src/lib/collector/overlays.ts` / `explorers.ts` — best-effort cookie/
  modal/chat handling; carousel/tab/accordion/disclaimer exploration.
  Disclaimer shots are stored as `disclaimer_screenshot` evidence (AD-005).
  EVIDENCE LABELING (v0.7.1): each shot carries a human-readable `label` so
  identically-typed captures are distinguishable in the viewer. Page shots get
  `pageTitle — host/path`; carousel/tab shots get "Carousel slide N"/"Tab N";
  disclaimer shots get the **ad anchor** — the offer line (vehicle + price)
  read from the disclaimer modal that opens on click (`modalAdAnchor`), or the
  ancestor card text for inline offers (`ancestorAdAnchor`). Dealer promos are
  usually image-based (vehicle/price baked into the image), so the modal —
  which renders the offer + disclaimer as DOM text — is the reliable source.
  e.g. "Disclaimer — Lease a 2026 RAM 1500 Hemi V8 big horn $379 /mo Expires
  06/30/2026". This anchor is also the intended join key tying a disclaimer
  screenshot back to its offer for the compliance pass (which pairs ad image +
  disclaimer text in one external call). Labels populate on the NEXT collection
  of a site; legacy evidence rows keep a null label and fall back to the type
  name in the viewer.
  DISCLAIMER TEXT (v0.7.2): `readDisclaimerModal` also returns the modal's FULL
  text (offer + fine print), stored on `evidence.text_content`. This is the real
  disclosure the compliance pass needs, captured directly — no OCR — and it
  isn't lost the way modal-only disclaimers are when the static HTML snapshot is
  taken after the modal closes. Surfaced as an expandable "Disclaimer text" row
  in the evidence viewer. See [[compliance-ad-disclaimer-pairing]].
- `src/lib/collector/mission-knowledge.ts` — the only place mission types
  influence collection: platform default paths, nav-discovery keywords,
  exploration flags.
- `src/lib/collector/mission-runner.ts` — URL resolution + capture for one
  mission (configured URLs → platform defaults → nav discovery; writes
  learning back to site_missions). `runMissionInSession` runs inside a
  caller-provided session + shared capture cache; `collectSite` is the Phase 8
  single-visit-per-site orchestrator: all of a site's missions in one browser
  session, then one fresh-session retry of any mission that captured zero
  pages (the "second swing" for a crashed/blocked/memory-starved browser).
  `runMission` remains as a one-session wrapper for the ad-hoc collect path.
  URL FALLBACK: `configuredUrls` falls a homepage mission (homepage_offers /
  promotional_banners) back to `sites.url` when its URL is blank — these never
  hit discovery. Only finance/service missions discover (platform paths → nav
  keywords) when blank. The site edit page makes this explicit: the homepage
  mission URL field is an OPTIONAL override (placeholder "Blank → uses site
  URL"), not a required field.
- `src/lib/deep-delete.ts` — R2-aware cascade deletes (see Deletes above).
- `src/lib/run-executor.ts` — background execution. Server actions enqueue
  and return; a non-awaited queue groups the run's work items by site and
  processes one site at a time via `collectSite` (single visit per site),
  writing progress to mission_results. On any site success it stamps
  `sites.last_collected_at`. Auto-finalizes the run once the full scope is
  settled: `failed` if no site captured anything, `published` if ≥
  `AUTO_PUBLISH_MIN_SITE_SUCCESS` (default 0.8, env-overridable) of in-scope
  sites succeeded, else `review`. Set the env var above 1 to disable
  auto-publish so every run lands in review — used for a full fan-out where the
  operator wants to triage all per-mission failures (the `/review` queue hides
  published runs, so an auto-published run's wrong-URL failures would otherwise
  be invisible). The manual Publish / Mark Failed controls on the run page
  always override. Guarded against double-starts via a module-level set on globalThis
  (survives dev HMR; not a server restart — an interrupted run's
  pending/running rows sit until retried).
  RETRY QUEUE (v0.7.7): `retryMissionResult` no longer collects synchronously
  (the old path dropped a second retry while one was running). It sets the row
  back to `pending` (queued) and calls `ensureDrainer(runId)`, which starts a
  per-run drainer (`drainRun`) that re-queries pending rows each pass and
  processes them via the shared `processSites` helper — so clicking Retry on
  6–10 sites queues them all and they drain in one pass. One drainer per run
  (the `activeRuns` guard); a `rescuePending` re-check in both `processQueue` and
  `drainRun` finallys closes the click-at-shutdown race. The `/review` page shows
  a "Re-collecting N queued items…" banner with auto-refresh while any
  pending/running rows exist on open runs; retried items leave the queue (they go
  pending) and reappear only if they fail again.
  STALLED-RUN RECOVERY (v0.7.8): the run page now bases "executing" on
  `isRunExecuting` (the in-memory truth) ONLY — not on the presence of
  pending/running rows. Rows left pending/running by an interrupted executor
  (server restart mid-run) are "stalled", not "executing", so they no longer
  freeze the whole UI behind disabled buttons. The run page detects this and the
  mission panel shows a **Resume** button (`resumeRun` → `requeueStalledRun`,
  which re-queues only the orphaned rows and drains them — never re-seeds the
  whole scope like Start Run would). Panel button fixes: queued/running rows show
  no action button (just "—"); Retry is enabled even mid-run (it queues);
  `mission_result.pending` is now labeled "Queued". The old stale-row-driven
  `executing` made interrupted runs permanently un-actionable — that deadlock is
  the bug this fixes.
- `src/lib/freshness.ts` — 7-day freshness window over
  `sites.last_collected_at` (fresh / stale / never); rendered by
  `components/freshness-badge.tsx` on the sites list.
- `src/lib/analysis/` — Phase 9 evidence analysis (no site visits, reads
  stored evidence):
  - `extract.ts` — deterministic rule-based extraction over HTML-snapshot
    text. Classifies offer type (lease/finance/cash/service/promotional) +
    vehicle (known-make list, brand prior from the site), normalizes monthly
    payment / APR / term / due-at-signing / cash, plus a service-special
    price/discount path; emits a 0..1 confidence.
    MULTI-OFFER SEGMENTATION (v1.0.27): `paymentAnchorPositions` finds every
    `$X/mo` match in the page text; `extractOffers` cuts a bounded window
    (350 chars before, 650 after each anchor) and runs the full extraction
    pipeline on each window independently. Deduped by
    (offerType, model, payment, apr, term, dueAtSigning, cash). APR-only and
    cash-only pages (no payment anchor) fall through to a single full-page
    pass. Service specials are always full-page (one URL = one service item).
    PATTERN FIXES (v1.0.27): monthly payment now matches `$X monthly` in
    addition to `/mo`, `per month`, `a month`; APR now matches `X% financing`
    and `X% Annual Percentage Rate` in addition to the APR-keyword forms.
    HARDENING (v0.7.3, after the Toyota of Dartmouth cross-platform shakeout):
    vehicle model is matched against a curated `KNOWN_MODELS` list (a null
    model beats junk like "Dealer"/"Safety Sense" pulled from page chrome) and
    searched in the offer-anchor context (the copy around the price) before the
    whole page, so the make isn't grabbed from a "Toyota Dealership" nav link.
    Cash incentive is clamped to a plausible band (`CASH_MIN`..`CASH_MAX`,
    250..25k) to reject service-coupon noise and MSRP/price misreads.
    `findKnownModel` is exported for the runner's disclaimer-based correction.
    DISCLAIMER RULE (operator, hard): a disclaimer is tied to a SPECIFIC ad and
    sits with it (just below, or text within the ad image). It is never the
    site-wide footer legalese (Terms of Use / Privacy / © / "do not sell").
    `extractDisclaimerNear` enforces this — it only searches the text right
    after the offer anchor, requires offer-specific fine-print wording, and
    cuts at any site-wide/footer marker; no ad anchor ⇒ null. Carry this rule
    into Phase 12 AI extraction.
  - `compliance.ts` — `ComplianceGrader` interface + `StubComplianceGrader`
    (deterministic: a priced offer needs a disclaimer) + `getComplianceGrader`
    factory. The real external service replaces the stub here; the platform
    only sends/stores (AD: compliance logic is external).
  - `runner.ts` — background, re-runnable analysis per run. Loads the run's
    html_snapshot evidence (joined to site brand), extracts offers → `offers`
    rows (with `source_evidence_id`), grades each ad → `compliance_grades`
    (upsert, one per evidence). Idempotent: clears the run's prior offers +
    grades first. Guarded by a globalThis active set like the collector;
    `isAnalysisRunning(runId)` drives the run page's live refresh.
    HARDENING (v0.7.3): dedups offers per site by signature (same offer recurs
    across a site's pages — one offer per evidence × many pages). Backfills an
    offer's disclaimer from the captured disclaimer-modal text
    (`evidence.text_content`) when the HTML pass found none — paired by the
    monthly payment ONLY (`matchCapturedDisclaimer`), a high-precision token;
    cash/model needles were dropped (a "$15" coupon hits "$15,000", a bare model
    hits a multi-vehicle modal). The payment-matched disclaimer describes
    exactly that offer, so its model corrects the page-level vehicle guess
    (e.g. a $475 Tundra lease mislabeled "Corolla" → Tundra). See
    [[compliance-ad-disclaimer-pairing]].
    DDC PLATFORM FIX (v1.0.32): DDC/Dealer.com platforms render offer prices
    as images — the HTML snapshot has no DOM price text, so the HTML pass
    extracts zero offers. Fix: a second extraction pass runs directly on
    `disclaimer_screenshot` evidence rows whose `text_content` is non-null
    (`loadDisclaimerEvidence`). The captured modal text (e.g. "Lease for $419
    /month. $419 due at signing. Lease are 36 months, 5k miles per year.") is
    plain text; `extractOffers` and the payment-anchor windowing work on it
    without modification. The shared `seen` Set (same dedup signature used in
    the HTML loop) prevents cross-source duplicates: a site with both DOM price
    text AND a modal won't insert the same offer twice. LABEL MODEL RECOVERY:
    when the disclaimer body text lacks a vehicle model name (common on DDC),
    `findKnownModel` is applied to `evidence.label` (the ad-anchor text, e.g.
    "2025 Nissan Rogue · $379/mo") and the recovered model is merged into
    `effective` BEFORE computing the dedup signature — so a label-recovered
    "Rogue" matches an HTML-extracted "Rogue" and prevents duplicates on
    non-DDC sites. Screenshot for compliance comes from the disclaimer
    screenshot row itself (the ad image), fetched via the shared
    `screenshotCache`. `parseMileage` extended to handle "5k miles/year"
    notation (common in DDC modal text). See [[compliance-ad-disclaimer-pairing]].
  Triggered by the **Run Analysis** button on the run page
  (`components/analysis-section.tsx`), which shows the extracted offers
  (type, vehicle, terms, confidence) and compliance grades.
- `src/lib/snapshot.ts` — Phase 10 snapshot publishing (the analysis↔reporting
  wall). `createSnapshotFromRun(runId, approvedBy, label?)` reads the run's live
  offers (joined to site identity, source-evidence mission type, and the
  per-evidence compliance grade) and **freezes** them into a new
  `report_snapshots` row + denormalized `snapshot_offers` copies. Immutable:
  the analysis runner only ever touches `offers`/`compliance_grades`, so a
  published snapshot is unaffected by re-analysis or re-collection. Returns null
  when the run has no offers yet (analysis must run first). Group scope is
  frozen too (`run_group_id` + `run_group_name`) so reporting can anchor on the
  primary dealer even after a group rename/delete. Reporting (Phase 11) reads
  ONLY `report_snapshots` + `snapshot_offers`. Snapshots list/detail at
  `/snapshots` (`components/snapshot-offers-table.tsx`); published from the run
  page's `components/snapshot-section.tsx` ("Publish Snapshot", which advances a
  review-state run to published). Deleting a snapshot removes only its frozen
  rows (it owns no R2 objects — it links back to the run's evidence); deleting
  the run cascades its snapshots.
- `src/app/(admin)/reports/` — Phase 11 Reporting Engine. Pure reads of frozen
  snapshot data (no collection/analysis/site access, no AI). `/reports` lists
  published snapshots as reports; `/reports/[id]` is the competitive report for
  one snapshot — offers grouped by vehicle with the primary dealer(s)
  highlighted (primaries read live from `run_group_members`, a reporting input
  per AD-002) and the lowest monthly payment per vehicle flagged, a compliance
  roll-up, and the group's snapshot history for over-time comparison.
  `/reports/[id]/export` streams the frozen offers as CSV. Every offer row links
  to its R2 evidence via `/api/evidence/[sourceEvidenceId]/file`. Repository
  helpers: `listSnapshotsForGroup`, `getPrimarySiteIds`. v2 idea: per-metric
  trend deltas vs the prior snapshot (payment up/down by site+vehicle).
- `src/lib/analysis/ai-enrich.ts` — Phase 12 AI-assisted analysis. An
  `OfferEnricher` interface (mirrors `ComplianceGrader`): `NoopOfferEnricher`
  (default) + `ClaudeOfferEnricher` (Anthropic SDK, structured output via
  `messages.parse` + a zod schema) + `getOfferEnricher()` gated on
  `ANTHROPIC_API_KEY`. The runner routes offers to AI in two cases (either):
  (1) rule-based confidence below `aiConfidenceThreshold()` (env
  `ANALYSIS_AI_CONFIDENCE_THRESHOLD`, default 0.5); (2) `vehicleModel === null`
  regardless of confidence — high-confidence offers on image-only platforms
  (DDC) can have all price fields correct but the model name only in the ad
  graphic. AI is SECONDARY; rule-based handles the routine majority (AD).
  VISION (v1.0.33): when `screenshotBuffer` is provided in `EnrichInput` and
  under 4 MB, it is included as an image content block in the API call so
  Claude can read model names baked into ad card graphics. The system prompt
  instructs Claude to look for the vehicle in the image when one is provided.
  AI corrections override the rule fields. AI-corrected offers carry
  `normalized_json.aiAssisted=true` and show an "AI" badge in the analysis
  view. Env knobs: `ANALYSIS_AI_MODEL` (default `claude-opus-4-8`),
  `ANALYSIS_AI_MAX_PAGE_CHARS` (default 8000). The hard disclaimer rule is
  carried into the prompt. Gated on ANTHROPIC_API_KEY. See
  [[compliance-ad-disclaimer-pairing]].
- `src/app/(admin)/page.tsx` — admin homepage. Two-CTA landing page (Collect
  Data → /runs, Run Reports → /reports) with live counts (dealers, runs,
  snapshots) and a three-step pipeline diagram.
- `src/app/(admin)/dealers/` — Dealer CRUD (renamed from `/sites`). Same
  entity, same schema; the UI rename better reflects real-world usage.
  `/dealers/new` and `/dealers/[id]/edit` cover full site-field editing
  including site_mission URL configs.
- `src/lib/evidence.ts` — R2 upload/retrieval; object keys (not URLs) in
  the evidence table; 15-minute presigned GETs.
- `src/lib/db/repository.ts` — shared queries, incl. `listExecutableMissions`
  (active missions on active sites, optionally scoped to a run group).

## Operational model

- **Run scope**: a run targets all sites, a predefined run group, or an
  ad-hoc dealer selection ("Pick dealers…" checkboxes on New Run — a
  temporary, unsaved group stored in collection_run_sites; one checkbox =
  single-dealer run).
- **Run groups** (`/groups`): named site subsets — a first-order dealer
  (flagged `is_primary`) plus its competitor set. A run created with a group
  only executes that group's missions. Groups came from the user's workflow,
  not the roadmap; reporting should anchor comparisons on primaries.
- **Dealer data** loads from `dealer-competitors-flat.csv` via
  `node scripts/import-dealers.mjs`. The file is block-structured: each
  isDlr=TRUE row starts a group named after that dealer; following FALSE rows
  are its competitors (dealers repeat across blocks; sites dedupe by name).
  Idempotent — re-run freely. CSV is source of truth for service/finance
  mission URLs; homepage missions keep their learned URLs.
- **Weekly flow** (roadmap target <15 min operator time): create run per
  group → Start Run (one click; pending→running is automatic, no separate
  "Move to Running" step) → watch live progress (page auto-refreshes). A
  clean run (≥80% of sites captured) auto-publishes; otherwise it lands in
  `review` for triage (Retry / Fix URL / Content Removed) and a manual
  Publish. Exception-based: the operator only touches runs that fall short.

## Constraints & gotchas

- Playwright requires a persistent Node server (no serverless). Chromium is
  installed via `npx playwright install chromium`.
- Server-action body limit raised to 20mb (next.config.ts) for evidence
  uploads.
- Background work runs in-process: one execution per run at a time;
  concurrent runs are possible but each is sequential internally. A server
  restart mid-run abandons in-flight missions (rows stay pending/running);
  Retry from the run page or review queue re-queues them.
- ~61 sites / ~187 missions imported. A full ungrouped run is hours of
  collection; group runs (~15-18 missions) are the intended unit.
