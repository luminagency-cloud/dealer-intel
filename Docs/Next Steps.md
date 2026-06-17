# Next Steps — Dealer Intel Platform

_Last updated: June 2026_

---

## Immediate: Verify what's built

### Phase 11 — Reporting (browser check needed)
- [ ] Open `http://localhost:3000/r/8911c65d-c921-4250-8035-ca2b85dddd27` and confirm the Elmwood Suite report renders correctly (color-ranked grids, KPI tiles, summary brief, section links)
- [ ] Confirm the admin view at `/reports/<id>` also renders (same ReportContent component, adminControls=true adds snapshot history panel)
- [ ] Confirm "Copy Link" button works
- [ ] Run `npx tsc --noEmit && npm run lint && npm run build` clean

### Phase 12 — AI Analysis (needs API key)
- [ ] Re-run analysis on a run that has low-confidence offers
- [ ] Confirm AI-enriched offers get the "AI" badge in the report

---

## Short-term: Stub → Real

### Compliance section
- Currently shows grade counts + a per-offer table with stub data
- Build out the real ComplianceGrader endpoint connection (external API)
- Customer-facing section in the report; already has a placeholder in ReportContent

---

## Deferred (acknowledged, not forgotten)

| Item | Notes |
|---|---|
| Inventory section | Separate data source; Phase 2 item. May import or link. |
| MTD Sales | Proprietary data source; may come in as a PDF import or external link |
| Brand News | Future version; may live in a separate tool and get linked in |
| Phase 11 v2 trend deltas | Per-metric change vs. prior snapshot in the report |
| Disclaimer modal capture for dealer_inspire / dealer_alchemist | Selectors don't match their modal pattern yet |

---

## Deployment

### Goal
Get a live URL so a dealer client can view a report — no auth, just `/r/[id]`.

### Decision
- Deploy the /viewer to Vercel
- Collections continue to run **locally** — Playwright never fires on the cloud server
- Neon (DB) and R2 (evidence files) are already cloud — the deployed app just reads them
- Dealer hits `/r/<snapshot-id>`, sees the report, no login required

### Steps (when ready)
1. Create Railway account / project
2. Connect GitHub repo
3. Set environment variables (see checklist below)
4. Deploy — Railway auto-detects Next.js and runs `npm run start`
5. Confirm `/r/<snapshot-id>` loads on the Railway domain

### Environment variables needed on Railway
```
DATABASE_URL=
AUTH_SECRET=
NEXTAUTH_URL=          # set to the Railway domain
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=
R2_PUBLIC_URL=
ANTHROPIC_API_KEY=     # optional; omit and AI enrichment is a no-op
```

---

## Architecture discussion (new thread)

**Topic:** Separating the collection/admin layer from the reporting layer through a shared database — and whether there's a better backend direction to explore.

**Current state:** Single Next.js monolith. Neon + R2 are already remote/cloud and act as the shared bus between local collection and cloud reporting. The snapshot wall (Phase 10) already enforces the separation at the data level.

**Open question:** Is there a better architectural direction for the backend? The user has a specific idea to explore — start a new conversation thread on this topic.

Key facts to bring into that conversation:
- Collect → Analyze → Report is already enforced as a data pipeline
- Analysis is re-runnable and many-to-many (one evidence → multiple passes)
- Reporting reads ONLY from `report_snapshots` + `snapshot_offers` (immutable)
- Playwright/Chromium is the only heavyweight dependency; it only runs during collection
- The app needs a persistent Node process (no serverless)
- DB: Neon Postgres (remote). Storage: Cloudflare R2 (remote). Auth: NextAuth.


Special note on news collector reports
## pulled in from external API
see Docs\NewsGather\autos-media-news-spec.md for details

### Report rendering rule
Assume
* news section *
  ** brand section **
  ** Industry section **
* *
- If `fetchNewsForBrand` returns null or empty arrays → brand news section does not render 
- If `fetchNewsForIndustry` returns null or empty arrays → industry news section does not render 
- if both return null or empty, entire news section does not render
- If `fresh === false` → optionally show a subtle "News last updated [date]" note
- Display: brand_items first, then industry_items
- Max display in report: 4 items total (you trim from the API's returned max)
- Each card: category pill + headline (linked to source_url) + summary. No rewriting.

---