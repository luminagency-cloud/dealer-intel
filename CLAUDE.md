@AGENTS.md
We are working through the roadmap at Docs\Implementation Roadmap.md

Docs in the ./Docs folder must be understood to move forward. Start with
Docs\Implementation Notes.md — it records what is built (Phases 1-9 complete),
where the key modules live, and the operational model.

Status snapshot (v0.6.x, June 2026):
- Phases 1-9 built; 1-7 verified end-to-end against live dealer sites. Phase 8
  (single-visit, freshness, auto-publish) and Phase 9 (analysis) verified via
  tsc/lint/build + a unit smoke of the extractor; live shakeout pending on
  operator.
- Architecture: three-phase pipeline — Collect → Analyze → Report. Collection
  is the canonical source; analysis passes run over stored evidence (many-to-
  many: one ad can feed specials report AND compliance check); reports read
  from published snapshots only. See Docs/Implementation Notes.md.
- Missions are GLOBAL collection targeting configs (~4 rows, CRUD at /missions);
  per-dealer URLs/learning live in site_missions, edited on each site's edit page.
  A run = scope (all / group / ad-hoc dealer checkboxes) x mission checkboxes.
- Phase 8: single-visit-per-site collection (one browser session per site, all
  its missions, shared URL+explore capture cache), fresh-session "second swing"
  retry of zero-capture missions, sites.last_collected_at freshness (7-day
  window) shown on the sites list, and auto-publish when ≥80% of in-scope sites
  succeed (manual Publish / Mark Failed still override). Start Run is one click
  (pending→running is automatic).
- Background run execution with live progress; review workflow at /review.
- Full CRUD with R2-aware deep deletes (src/lib/deep-delete.ts).
- Real data loaded: ~62 sites, 3 global missions, ~142 site-mission URL
  configs, 14 run groups, via `node scripts/import-dealers.mjs` (idempotent).

Phase 9 analysis (src/lib/analysis): rule-based extraction over stored HTML
snapshots → offers (classification + normalization), compliance pass behind a
ComplianceGrader interface (StubComplianceGrader now; real external endpoint
drops in at getComplianceGrader). Background + re-runnable via "Run Analysis"
on the run page. AI is deferred to Phase 12 by design; the offer confidence
score is the routing seam for low-confidence cases.

Next up: live shakeout of Phases 8-9, then Phase 10 (Snapshot Publishing — the
wall between analysis and reporting) and Phase 11 (Reporting Engine). Phase 12
adds AI-assisted analysis for the edge cases.
