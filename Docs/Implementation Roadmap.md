# Dealer Intel Working List

_Last updated: July 1, 2026_

This is the single human-readable place for current status and open work.
If something is done, it should not live here as a future task.

## Product Truth

Dealer Intel runs as a simple pipeline:

1. **Collect** promotional evidence from dealer sites.
2. **Analyze** stored evidence into offers and compliance grades.
3. **Report** from published snapshots only.

Reports do not scrape sites. Analysis does not scrape sites. Collection stores
raw evidence first, then everything downstream reads that evidence.

## Collection Truth

A run selects sites and missions.

For each dealer/site, the selected missions run in one browser session with a
shared capture cache. Missions are targeting buckets, not separate browser jobs.

That means a normal run should not open one browser for finance, close it, open
another browser for service, and so on. A single-mission retry can still launch
its own session because it is intentionally retrying one row.

## Verified

These are facts checked from the repo/workspace on July 1, 2026. Secret values
were not printed.

### AdScore Compliance

Status: **implemented, configured, and producing real stored grades**

Evidence:

- `src/lib/analysis/compliance.ts` contains `AdScoreComplianceGrader`.
- `getComplianceGrader(runId)` selects AdScore when all `ADGRADER_*` variables
  are present.
- The local `.env.local` contains:
  - `ADGRADER_BASE_URL`
  - `ADGRADER_CLIENT_ID`
  - `ADGRADER_CLIENT_SECRET`
- A read-only database check found 65 compliance grades:
  - 48 real AdScore results,
  - 0 stub results,
  - 17 not-applicable results.

What remains open:

- No known AdScore wiring work.
- If future grades fall back to stub, inspect server logs for the reason:
  missing screenshot, missing market state, API error, or 422 retry failure.

### AI-Assisted Analysis

Status: **implemented, configured, and producing AI-assisted offers**

Evidence:

- `src/lib/analysis/ai-enrich.ts` contains `ClaudeOfferEnricher`.
- `getOfferEnricher()` selects Claude when `ANTHROPIC_API_KEY` is present.
- The local `.env.local` contains `ANTHROPIC_API_KEY`.
- A read-only database check found 146 offers total, with 25 marked
  `normalized_json.aiAssisted=true`.

What remains open:

- No known AI wiring work.
- If the UI does not show the AI badge for AI-assisted rows, that is a UI bug,
  not an integration task.

### News And Inventory

Status: **implemented and locally configured**

Evidence:

- The local `.env.local` contains `NEWS_API_URL`, `NEWS_API_KEY`,
  `INVENTORY_API_URL`, and `INVENTORY_API_KEY`.
- News and inventory modules exist and are wired into the current ops flow.

What remains open:

- No wiring task is currently known from docs alone.
- If the UI says either service is not configured, investigate environment
  loading first.

## Actually Open

### 1. Fix Environment Source Confusion

The project instructions say secrets live in `.env`, but this workspace has
`.env.local` and no `.env`. `drizzle.config.ts` currently loads `.env.local`
first, then `.env`.

Done when one convention is chosen and the repo agrees everywhere:

- project instructions,
- `drizzle.config.ts`,
- user-facing configuration messages,
- deployment docs.

### 2. Dealer Inspire / Dealer Alchemist Disclaimer Capture

Known risk: disclaimer modal selectors may not match these platforms.

Done when:

- Real Dealer Inspire and Dealer Alchemist pages capture ad-specific disclaimer
  text into `evidence.text_content`.
- Captured text is tied to the ad, not footer/legal boilerplate.

### 3. Run Page Progress Polling

Current run-page refresh may be heavier than needed.

Done when:

- A narrow progress endpoint returns run execution state and work-item statuses.
- The run page polls that endpoint instead of refreshing the whole page for
  status-only updates.

### 4. Report Trend Deltas

Backlog item.

Done when:

- Reports can compare the current published snapshot with the prior group
  snapshot.
- Deltas come only from published snapshots, not live run data.

### 5. Inventory And Sales In Reports

Backlog/decision item.

Done when:

- We decide whether inventory belongs directly in the competitive report or
  remains an operational side view.
- Month-to-date sales has a known source and ingestion model, if we decide to
  include it.

## Not Currently Open

These should not be re-added as tasks unless new evidence proves they are
broken:

- Build the collector.
- Build missions.
- Consolidate collection into one browser session per dealer/site.
- Build evidence storage.
- Build analysis.
- Build snapshot publishing.
- Build reports.
- Wire AdScore code from scratch.
- Add an Anthropic key locally.
- Wire news from scratch.
- Wire inventory from scratch.

## Before Calling Work Done

For code changes:

- Read the relevant Next.js docs in `node_modules/next/dist/docs/` before
  changing Next.js code.
- Bump `package.json` patch version.
- Run `npx tsc --noEmit`, `npm run lint`, and `npm run build`.
- Verify user-facing features in the running app.

For collector changes:

- Also verify against a real dealer site.
