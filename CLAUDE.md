@AGENTS.md
We are working through the roadmap at Docs\Implementation Roadmap.md

Docs in the ./Docs folder must be understood to move forward. Start with
Docs\Implementation Notes.md — it records what is built (Phases 1-10 complete),
where the key modules live, and the operational model.

Status snapshot (v1.0.32, June 2026):
- All 12 phases built. Phase 11 reporting is live; Phase 12 AI analysis is
  built and gated on ANTHROPIC_API_KEY.
- UI rename: /sites → /dealers (same entity/schema; CRUD at /dealers). New
  admin homepage at / (two-CTA: Collect Data / Run Reports + pipeline diagram).
- Extractor hardened (v1.0.27): multi-offer segmentation via payment-anchor
  windowing (each $X/mo on a page yields its own offer, deduped); monthly
  payment pattern now matches "$X monthly"; APR pattern now matches "X%
  financing" / "X% Annual Percentage Rate". These were causing zero-offer
  results on some Nissan dealer platforms.
- DDC platform fix (v1.0.32): DDC/Dealer.com sites render offer prices as
  images — zero DOM price text in HTML snapshot. Fix: a second extraction pass
  in runner.ts runs extractOffers() on disclaimer_screenshot text_content
  (the captured modal text, e.g. "Lease for $419/month. 36 months, 5k miles/year").
  Vehicle model recovered from evidence.label (ad-anchor text) when absent from
  modal body text. Label model recovery applied BEFORE dedup signature so non-DDC
  sites don't get duplicate offers. parseMileage extended to handle "5k miles/year"
  notation from DDC modals. See Docs/Implementation Notes.md runner.ts section.
- Report UI polish (v1.0.32): base font-size 18px → 16px (corrects Tailwind rem
  sizing for data-dense layout); containerClassName prop on ReportContent removes
  double padding in admin context; cash section summary bullet hidden when empty;
  n/a compliance grades excluded from roll-up display (stub sentinel, not a real
  grade).
- Shakeout data: Anchor Nissan suite (5 dealers, 15/15 collected). Open gap:
  dealer_inspire/dealer_alchemist disclaimers aren't behind modal buttons our
  selectors match (no modal text captured — affects disclaimer pairing only, not
  HTML offer extraction). Nucar Nissan has wrong URLs in site_missions for
  finance/service specials — operational fix (edit dealer page), not a code bug.
- Architecture: three-phase pipeline — Collect → Analyze → Report. Collection
  is the canonical source; analysis passes run over stored evidence; reports read
  from published snapshots only. See Docs/Implementation Notes.md.
- Missions are GLOBAL collection targeting configs (~4 rows, CRUD at /missions);
  per-dealer URLs/learning live in site_missions, edited on each dealer's edit
  page. A run = scope (all / group / ad-hoc dealer checkboxes) x mission
  checkboxes.
- Phase 8: single-visit-per-site collection, fresh-session "second swing"
  retry, sites.last_collected_at freshness (7-day window), auto-publish ≥80%.
- Background run execution with live progress; review workflow at /review.
- Full CRUD with R2-aware deep deletes (src/lib/deep-delete.ts).
- Real data loaded: ~62 dealers, 3 global missions, ~142 site-mission URL
  configs, 14 run groups, via `node scripts/import-dealers.mjs` (idempotent).

Phase 9 analysis (src/lib/analysis): rule-based extraction over stored HTML
snapshots + disclaimer modal text → offers (classification + normalization),
compliance pass behind a ComplianceGrader interface (StubComplianceGrader now;
real AdScore endpoint drops in at getComplianceGrader when ADGRADER_* env vars
are set). Multi-offer per page via payment-anchor windowing. Background +
re-runnable via "Run Analysis" on the run page. AI is secondary (Phase 12);
confidence score routes weak cases there.

Phase 10 snapshot publishing (src/lib/snapshot.ts): the wall between analysis
and reporting. "Publish Snapshot" on a run freezes its current offers +
compliance grades into report_snapshots + a denormalized snapshot_offers copy.
Snapshots are immutable — re-running analysis/collection never changes a
published one. Reporting (Phase 11) reads ONLY snapshots. List/detail at
/snapshots.

Phase 11 reporting (src/app/(admin)/reports): LIVE. Pure reads of frozen
snapshots — no collection/analysis/site access, no AI. Competitive report per
snapshot at /reports/[id] (offers grouped by vehicle, primary dealer
highlighted, lowest payment flagged, compliance roll-up, group snapshot
history), CSV export, R2 evidence links. Report UI polished in v1.0.32.
Trend deltas vs prior snapshot deferred to v2.

Phase 12 AI analysis (src/lib/analysis/ai-enrich.ts): secondary pass, two
routing conditions: (1) rule-based confidence < ANALYSIS_AI_CONFIDENCE_THRESHOLD
(default 0.5); (2) vehicleModel === null regardless of confidence (image-only
platforms like DDC bake the model name into the ad graphic — confidence can be
0.8 on price/terms but model is only in pixels). When a screenshot is available
it is passed to Claude as an image content block (vision) so it can read the
model from the graphic. AI-corrected offers show an "AI" badge. Gated on
ANTHROPIC_API_KEY (no-op without it). Model via ANALYSIS_AI_MODEL (default
claude-opus-4-8).

Next up: (1) add ANTHROPIC_API_KEY and live-verify Phase 12 — especially the
vision path for null-model DDC offers; (2) AdScore compliance wiring once
credentials are confirmed; (3) dealer_inspire/dealer_alchemist disclaimer modal
selectors.
