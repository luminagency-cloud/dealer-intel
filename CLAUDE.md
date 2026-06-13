@AGENTS.md
We are working through the roadmap at Docs\Implementation Roadmap.md

Docs in the ./Docs folder must be understood to move forward. Start with
Docs\Implementation Notes.md — it records what is built (Phases 1-10 complete),
where the key modules live, and the operational model.

Status snapshot (v0.7.x, June 2026):
- Phases 1-10 built; 1-7 verified end-to-end against live dealer sites. Phase 10
  (snapshot publishing) verified end-to-end in the running app, including the
  immutability guarantee (re-analysis leaves a published snapshot untouched).
- Phases 8-10 + analysis shaken out at scale on a real group run (Toyota of
  Dartmouth, 4 platforms: apollo/ddc/dealer_inspire/dealer_alchemist): 15/15
  missions collected, auto-published at 100%, analysis ran across all four. The
  extractor was then hardened (v0.7.3) on that real data — known-models list,
  anchor-local vehicle, cash sanity cap, offer dedup, and disclaimer-modal text
  paired to offers by payment (correcting the vehicle from the disclaimer). Open
  gaps: one-offer-per-page mis-picks on multi-offer lineups (Phase 12 / multi-
  offer segmentation), and dealer_inspire/dealer_alchemist disclaimers aren't
  behind modal buttons our selectors match (no modal text captured there yet).
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

Phase 10 snapshot publishing (src/lib/snapshot.ts): the wall between analysis
and reporting. "Publish Snapshot" on a run freezes its current offers +
compliance grades into report_snapshots + a denormalized snapshot_offers copy.
Snapshots are immutable — re-running analysis/collection never changes a
published one (the analysis runner only touches the live offers/grades tables).
Reporting (Phase 11) reads ONLY snapshots. List/detail at /snapshots.

Next up: live shakeout of Phases 8-9, then Phase 11 (Reporting Engine — pure
reads from snapshot_offers, links to R2 evidence). Phase 12 adds AI-assisted
analysis for the edge cases.
