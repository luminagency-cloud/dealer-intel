@AGENTS.md
We are working through the roadmap at Docs\Implementation Roadmap.md

Docs in the ./Docs folder must be understood to move forward. Start with
Docs\Implementation Notes.md — it records what is built (Phases 1-7 complete),
where the key modules live, and the operational model.

Status snapshot (v0.4.0, June 2026):
- Phases 1-7 built and verified end-to-end against live dealer sites.
- Architecture: three-phase pipeline — Collect → Analyze → Report. Collection
  is the canonical source; analysis passes run over stored evidence (many-to-
  many: one ad can feed specials report AND compliance check); reports read
  from published snapshots only. See Docs/Implementation Notes.md.
- Missions are GLOBAL collection targeting configs (~4 rows, CRUD at /missions);
  per-dealer URLs/learning live in site_missions, edited on each site's edit page.
  A run = scope (all / group / ad-hoc dealer checkboxes) x mission checkboxes.
- Background run execution with live progress; review workflow at /review.
- Full CRUD with R2-aware deep deletes (src/lib/deep-delete.ts).
- Real data loaded: ~62 sites, 3 global missions, ~142 site-mission URL
  configs, 14 run groups, via `node scripts/import-dealers.mjs` (idempotent).
- The operator is now exercising the app by hand; expect feedback-driven
  tweaks before starting Phase 8.

Next up: operator shakeout, then Phase 8 (Collection Consolidation & Site
Learning — single-visit-per-site, freshness tracking, group-scoped runs).
Phase 9 (Evidence Analysis: classification, normalization, external compliance
API call) follows. Phases 10-11 (snapshots, reporting) complete the pipeline.
