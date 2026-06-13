@AGENTS.md
We are working through the roadmap at Docs\Implementation Roadmap.md

Docs in the ./Docs folder must be understood to move forward. Start with
Docs\Implementation Notes.md — it records what is built (Phases 1-10 complete),
where the key modules live, and the operational model.

Status snapshot (v0.7.x, June 2026):
- Phases 1-11 built; 1-7 verified end-to-end against live dealer sites. Phase 10
  (snapshot publishing) verified end-to-end in the running app, including the
  immutability guarantee (re-analysis leaves a published snapshot untouched).
  Phase 11 (reporting) is code-complete + tsc/lint clean but NOT yet verified in
  the browser (see below).
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

Phase 11 reporting (src/app/(admin)/reports): pure reads of frozen snapshots —
no collection/analysis/site access, no AI. Competitive report per snapshot at
/reports/[id] (offers grouped by vehicle, primary dealer highlighted, lowest
payment flagged, compliance roll-up, group snapshot history), CSV export, R2
evidence links. BUILT + tsc/lint clean; live browser verification pending (the
operator's overnight fan-out was holding :3000 / the .next build — must verify
in-app before calling it done, and re-confirm the production build).

Next up: live-verify Phase 11 once the environment frees up, then Phase 12
(AI-assisted analysis for low-confidence offer/vehicle/disclaimer cases — the
multi-offer-per-page mis-picks found in the shakeout are a prime target).
