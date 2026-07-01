@AGENTS.md

Docs in the ./Docs folder must be understood to move forward. Start with
Docs\Implementation Notes.md — it records the current architecture, key module
ownership, and operational model. Docs\Implementation Roadmap.md is
forward-looking only; do not treat completed build history as the product model.

## Current state (July 2026)

The core platform is live. News, Inventory, and Viewer are part of the current
product surface. See Docs/Implementation Notes.md for the full module map.

**Architecture: Collect → Analyze → Report pipeline.**
Collection is the canonical source; analysis passes run over stored evidence;
reports read from published snapshots only. The admin app runs on a persistent
Node server (Playwright in-process). The Viewer app is a separate thin-client
deployed to Vercel.

**Weekly operator workflow** (target < 15 min):
1. Collect data (group-scoped run)
2. Analyze offers (Run Analysis on the run page)
3. Pull news (home page → Load news step; gated on NEWS_API_URL/KEY)
4. Run inventory (home page → Run inventory step; gated on INVENTORY_API_URL/KEY)
5. Publish snapshots → reports go live in viewer

The home page shows the current week's progress as a step checklist and nags
on steps 3 and 4 if not done.

**Key facts:**
- ~62 dealers, 3 global missions, ~142 site-mission URL configs, 14 run groups.
  Loaded via `node scripts/import-dealers.mjs` (idempotent).
- Missions are GLOBAL configs (~4 rows, CRUD at /missions); per-dealer
  URLs/learning live in site_missions, edited on each dealer's edit page.
- A run = scope (all / group / ad-hoc dealer checkboxes) × mission checkboxes.
- Single-visit-per-site collection, fresh-session "second swing" retry,
  auto-publish ≥80% success, manual controls always override.
- DDC/Dealer.com platforms: offer prices are image-only — extraction runs on
  disclaimer modal text_content as a second pass. Vehicle model recovered from
  evidence.label when absent from modal body.
- AI-assisted analysis is gated on ANTHROPIC_API_KEY; routes low-confidence
  offers and null-model offers to Claude (vision path reads model from ad image).
  Model: ANALYSIS_AI_MODEL (default claude-opus-4-8).
- Compliance grader gated on ADGRADER_* env vars (StubComplianceGrader until set).

**Open gaps:**
- dealer_inspire/dealer_alchemist disclaimer modal selectors don't match our
  explorers — no modal text captured (affects disclaimer pairing only, not HTML
  offer extraction).
- ANTHROPIC_API_KEY not yet set in prod — AI-assisted analysis is built but
  unverified live.
- AdScore compliance credentials pending.
