# Implementation Notes

Living record of what is built, where it lives, and decisions made along the
way. Read alongside `Implementation Roadmap.md` (the plan) and
`architecture-decision.md` (the principles).

## Status: Phases 1–7 complete (June 2026)

| Phase | State | Notes |
|---|---|---|
| 1 Foundation | Done | Next.js 16 + TS, Neon Postgres (Drizzle), Cloudflare R2, NextAuth single-operator login |
| 2 Core Data Model | Done | All 7 entities + run_groups/run_group_members/mission_results beyond plan. site_relationships has no UI by design (collection is competition-blind; reporting consumes it in Phase 12) |
| 3 Run Management | Done | Lifecycle pending → running → review → published / failed |
| 4 Evidence Infrastructure | Done | R2 keys in Postgres, presigned GETs via `/api/evidence/[id]/file`, viewer + manual upload on run page |
| 5 Collector Engine | Done | Playwright/Chromium; overlay dismissal, page scroller, full-page screenshot + HTML |
| 6 Mission Framework | Done | Multi-URL missions, URL discovery with learning, carousel/tab/accordion/disclaimer explorers |
| 7 Review Workflow | Done | mission_results per run+mission, background execution, review queue (`/review`) with Retry / Fix URL / Content Removed |
| 8 | Not started | Collection Consolidation & Site Learning. Partially anticipated: missions already store last_known_url + last_success_at. Scope now includes single-visit-per-site consolidation. |
| 9 | Not started | Evidence Analysis: classification, normalization, external compliance API call. |
| 10 | Not started | Snapshot Publishing — the wall between analysis and reporting. |
| 11 | Not started | Reporting Engine — pure reads from published snapshots, links to R2 images. |
| 12 | Not started | AI-Assisted Analysis — improves edge-case classification and normalization. |

## Architecture: three-phase pipeline (decided June 2026)

The platform is a **collect → analyze → report** pipeline with a hard wall
between each phase:

- **Collection** — visit sites, grab everything promotional, store raw evidence
  in R2. Comprehensive and reliable. A missed collection breaks everything
  downstream. No interpretation happens here.
- **Analysis** — independent passes over stored evidence: classification,
  normalization, compliance (external API call). Passes are re-runnable and
  many-to-many: one piece of evidence can be consumed by multiple passes
  (specials report + compliance check) without re-collecting.
- **Reporting** — pure reads from published analysis snapshots. No site access,
  no computation.

Collection is **group-scoped** (primary dealer + competitors) and
**time-gated** (~weekly). A site with a fresh collection is ready for analysis.
Failed sites are handled separately; they don't block the group.

## The mission layer (reworked June 2026)

Missions are **collection targeting configs**, not business goals. A mission
answers: where do we look on a site, and how do we explore those pages?
Business goals (specials comparison, compliance audit) are expressed at the
analysis and reporting layers, not here.

Structure:

- `missions` — the global layer (~4 rows): name + mission_type (collection
  strategy) + active. CRUD at `/missions`. mission_type maps to discovery
  paths and exploration flags in `src/lib/collector/mission-knowledge.ts`.
- `site_missions` — per-dealer URL config + collector memory (last_known_url,
  alternate_urls, last_success_at, per-pair active). Edited on the **site's
  edit page**, written to by the collector when it learns a URL.
- A run executes **work items**: scoped sites x selected missions
  (`listWorkItemsForRun`). mission_results are unique per
  (run, site, mission).
- Run creation picks scope (all / group / ad-hoc dealer checkboxes) AND
  missions (checkboxes, default all; subset stored in
  collection_run_missions).

Note: `homepage_offers` and `promotional_banners` are currently identical in
collection behavior (both target homepage, both run carousel + disclaimer
explorers). These should be consolidated when Phase 8 is built.

## Deletes

Full CRUD everywhere; destructive deletes confirm first and clean up R2 via
`src/lib/deep-delete.ts`:
- Delete run → its evidence rows + R2 objects, results, offers, snapshots.
- Delete site → its configs, memberships, results, evidence rows + R2.
- Delete mission → per-site configs and results (captured evidence stays;
  it is keyed by run/site).
- Delete group → memberships only; runs that referenced it become ungrouped.

## Key modules

- `src/lib/collector/engine.ts` — generic browser session: navigation,
  overlay suppression, scrolling, capture. No business meaning (AD-003).
- `src/lib/collector/overlays.ts` / `explorers.ts` — best-effort cookie/
  modal/chat handling; carousel/tab/accordion/disclaimer exploration.
  Disclaimer shots are stored as `disclaimer_screenshot` evidence (AD-005).
- `src/lib/collector/mission-knowledge.ts` — the only place mission types
  influence collection: platform default paths, nav-discovery keywords,
  exploration flags.
- `src/lib/collector/mission-runner.ts` — executes one work item (site x
  mission): the site's configured URLs (all captured) → platform defaults →
  nav discovery; writes learning back to site_missions.
- `src/lib/deep-delete.ts` — R2-aware cascade deletes (see Deletes above).
- `src/lib/run-executor.ts` — background execution. Server actions enqueue
  and return; a non-awaited queue processes missions sequentially in this
  Node process, writing progress to mission_results; auto-finalizes the run
  (running → review, or failed when nothing captured) once the full scope is
  settled. Guarded against double-starts via a module-level set on
  globalThis (survives dev HMR; does NOT survive a server restart — an
  interrupted run's pending/running rows just sit until retried).
- `src/lib/evidence.ts` — R2 upload/retrieval; object keys (not URLs) in
  the evidence table; 15-minute presigned GETs.
- `src/lib/db/repository.ts` — shared queries, incl. `listExecutableMissions`
  (active missions on active sites, optionally scoped to a run group).

## Operational model

- **Run scope**: a run targets all sites, a predefined run group, or an
  ad-hoc dealer selection ("Pick dealers…" checkboxes on New Run — a
  temporary, unsaved group stored in collection_run_sites; one checkbox =
  single-dealer run).
- **Run groups** (`/groups`): named site subsets — a first-order dealer
  (flagged `is_primary`) plus its competitor set. A run created with a group
  only executes that group's missions. Groups came from the user's workflow,
  not the roadmap; reporting should anchor comparisons on primaries.
- **Dealer data** loads from `dealer-competitors-flat.csv` via
  `node scripts/import-dealers.mjs`. The file is block-structured: each
  isDlr=TRUE row starts a group named after that dealer; following FALSE rows
  are its competitors (dealers repeat across blocks; sites dedupe by name).
  Idempotent — re-run freely. CSV is source of truth for service/finance
  mission URLs; homepage missions keep their learned URLs.
- **Weekly flow** (roadmap target <15 min operator time): create run per
  group → Start Run → watch live progress (page auto-refreshes) → triage
  `/review` (Retry / Fix URL / Content Removed) → move run to Published.

## Constraints & gotchas

- Playwright requires a persistent Node server (no serverless). Chromium is
  installed via `npx playwright install chromium`.
- Server-action body limit raised to 20mb (next.config.ts) for evidence
  uploads.
- Background work runs in-process: one execution per run at a time;
  concurrent runs are possible but each is sequential internally. A server
  restart mid-run abandons in-flight missions (rows stay pending/running);
  Retry from the run page or review queue re-queues them.
- ~61 sites / ~187 missions imported. A full ungrouped run is hours of
  collection; group runs (~15-18 missions) are the intended unit.
