# Implementation Notes

_Last updated: July 1, 2026_

This is the compact map of how the system works. The open work list lives in
`Docs/Implementation Roadmap.md`.

## The Shape Of The System

Dealer Intel is a collect -> analyze -> report pipeline.

Collection creates raw evidence. Analysis reads evidence and creates structured
offers/compliance grades. Reporting reads published snapshots.

The important boundary: reports never read live run data and never visit dealer
sites.

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

Evidence files live in R2. Database rows store object keys and metadata.

Key files:

- `src/lib/evidence.ts`
- `src/components/evidence-section.tsx`
- `src/app/(admin)/runs/[id]/evidence/[siteId]/page.tsx`

## Analysis

Analysis is re-runnable and does not visit dealer sites.

The runner reads stored evidence, extracts offers, grades compliance, and writes
results back to analysis tables.

Rule-based extraction handles the normal path. Claude is a secondary pass for
hard cases when `ANTHROPIC_API_KEY` is configured.

AdScore compliance is implemented through `AdScoreComplianceGrader` and is used
when all `ADGRADER_*` variables are configured. Otherwise the system falls back
to the deterministic stub grader.

Key files:

- `src/lib/analysis/runner.ts`
- `src/lib/analysis/extract.ts`
- `src/lib/analysis/compliance.ts`
- `src/lib/analysis/ai-enrich.ts`
- `src/components/analysis-section.tsx`

## Reporting

Publishing creates an immutable snapshot from the current run analysis.

Reports read only:

- `report_snapshots`,
- `snapshot_offers`,
- linked evidence files.

Re-running collection or analysis does not mutate an already-published
snapshot.

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

Configuration currently needs cleanup:

- project rules say secrets belong in `.env`,
- this workspace currently has `.env.local`,
- `drizzle.config.ts` currently loads `.env.local` first and `.env` second.

That mismatch is tracked in `Docs/Implementation Roadmap.md`.

## Keep In Mind

- Collection should be broad and evidence-first.
- Business interpretation belongs in analysis/reporting, not collection.
- Reports should stay deterministic and snapshot-backed.
- A full ungrouped run is slow; group runs are the normal operating unit.
