# Next Steps

_Last updated: July 2026_

This file is the short operational to-do list. Use
`Implementation Roadmap.md` for the broader forward roadmap and
`Implementation Notes.md` for current architecture.

## Highest Priority

### Compliance: Stub -> Real

- Connect the real AdScore endpoint through the existing `ComplianceGrader`
  interface.
- Verify credentials and request/response shape with real data.
- Confirm customer-facing report compliance sections show real grades,
  evidence links, and useful empty/error states.

### Production AI Verification

- Set `ANTHROPIC_API_KEY` in production when available.
- Re-run analysis on low-confidence offers and image-heavy DDC evidence.
- Confirm AI-assisted corrections get the "AI" badge and preserve
  ad-specific disclaimer pairing.

### Disclaimer Modal Coverage

- Add Dealer Inspire and Dealer Alchemist modal selectors to the explorer.
- Verify against real dealer pages.
- Confirm captured `evidence.text_content` is the ad-specific disclosure, not
  footer/legal boilerplate.

## Product Backlog

| Item | Notes |
|---|---|
| Run progress endpoint | Replace broad run-page refresh polling with `GET /api/runs/[id]/progress` and a narrow client poller. |
| Report trend deltas | Compare the current published snapshot with the prior group snapshot. |
| Inventory in reports | Decide whether inventory belongs directly in reports or remains linked from the ops surface. |
| Month-to-date sales | Define the source, ingestion model, and report treatment once the data source is known. |

## Deployment Notes

The viewer is the cloud-facing report surface. Collection and analysis continue
to run on the persistent admin Node process because Playwright/Chromium and
in-memory run execution are not serverless-friendly.

Cloud/shared services:

- Neon Postgres stores app data and published snapshots.
- Cloudflare R2 stores evidence files.
- The viewer app reads published report data and proxies evidence access.

Useful deployment checks:

1. Confirm the viewer can load a known report permalink.
2. Confirm authenticated dealer report routes work.
3. Confirm R2 evidence images load through the viewer proxy.
4. Run `npx tsc --noEmit`, `npm run lint`, and `npm run build` before release.

## News Report Rule

Report news reads from locally stored news items pulled from the external news
service.

- If brand news is empty, hide the brand news subsection.
- If industry news is empty, hide the industry news subsection.
- If both are empty, hide the entire news section.
- If news is stale, optionally show a subtle "News last updated [date]" note.
- Display brand items first, then industry items.
- Show up to 4 items total.
- Each card shows category, linked headline, and summary without rewriting.
