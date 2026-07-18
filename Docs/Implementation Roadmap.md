# Dealer Intel Working List

_Last updated: July 18, 2026_

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
- Local inventory mode can auto-start the sibling `dealer-inventory-api` process
  when configured.

### Reporting

Status: **implemented**

- Publishing creates immutable report snapshots.
- Offer/compliance report content reads from `report_snapshots` and
  `snapshot_offers`.
- Report pages can show snapshot history for a run group.
- Public report sharing uses snapshot share tokens.

## Actually Open

### 1. Dealer Inspire / Dealer Alchemist Disclaimer Capture

Known risk: disclaimer modal selectors may not match these platforms on all
real dealer pages.

Done when:

- Real Dealer Inspire and Dealer Alchemist pages capture ad-specific disclaimer
  text into `evidence.text_content`.
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
