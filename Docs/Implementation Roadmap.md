# Dealer Intel Forward Roadmap

This is the forward-looking roadmap. Historical build chronology is no longer the
working model for the product.

For current architecture and module ownership, read `Implementation Notes.md`.
For operator workflow details, read the "Operational model" section there.

## Current Product Truth

Dealer Intel is a dealer offer intelligence platform built around a
collect -> analyze -> report pipeline.

- **Collect** visits dealer sites, captures promotional evidence, and stores raw
  screenshots, HTML snapshots, and disclaimer evidence in R2.
- **Analyze** runs repeatable extraction and compliance passes over stored
  evidence. It never re-visits dealer sites.
- **Report** reads only published snapshots. Reports do not collect, analyze, or
  access live dealer sites.

Collection is dealer/site-scoped. A run selects sites and missions; for each
site, selected missions are collected in one browser session with a shared
capture cache. Missions are targeting buckets, not separate browser jobs.

## Active Priorities

### Compliance Integration

Status: open

- Wire the real AdScore compliance endpoint into the existing
  `ComplianceGrader` interface.
- Keep the stub grader as a local/dev fallback.
- Verify the request/response mapping against real credentials.
- Confirm report compliance sections render real grades and evidence links.

### Production AI Verification

Status: open, blocked on `ANTHROPIC_API_KEY`

- Set the production Anthropic key.
- Re-run analysis on low-confidence and image-heavy offer evidence.
- Confirm AI-assisted offers receive the AI badge and preserve the hard
  disclaimer rule.
- Capture any model-specific prompt or token-limit changes in
  `Implementation Notes.md`.

### Dealer Inspire / Dealer Alchemist Disclaimer Capture

Status: open

- Add or tune disclaimer modal selectors for Dealer Inspire and Dealer
  Alchemist sites.
- Verify capture against real dealer pages.
- Confirm `evidence.text_content` contains the ad-specific disclaimer text, not
  site-wide legal footer copy.

### Run Progress Efficiency

Status: open

- Replace broad `router.refresh()` polling during active runs with a narrow JSON
  progress endpoint.
- Suggested endpoint: `GET /api/runs/[id]/progress`.
- Return only run execution state and work-item statuses.
- Use a client-side polling component so the run page can refresh status badges
  without re-running unrelated queries.

### Report Trend Deltas

Status: backlog

- Compare the current snapshot against the prior group snapshot.
- Surface per-vehicle payment, APR, inventory, and compliance movement where
  data exists.
- Keep reports snapshot-backed; do not compute trends from live run data.

### Inventory And Sales Enrichment

Status: backlog

- Decide whether inventory appears directly in competitive reports or remains a
  linked operational view.
- Define the source and ingestion model for month-to-date sales if/when that
  data becomes available.

## Operating Guardrails

- Do not hand-write migrations. Schema changes go through Drizzle.
- Do not target serverless for the admin app; Playwright and run execution need
  a persistent Node process.
- Keep collection broad and evidence-first. Business interpretation belongs in
  analysis and reporting.
- Keep reports deterministic: published snapshots are the reporting boundary.
- New roadmap items should describe future work only. Completed history belongs
  in `Implementation Notes.md` when it helps future maintainers.
