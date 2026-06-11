@AGENTS.md
We are working theough the roadmap at Docs\Implementation Roadmap.md

Docs in the ./Docs folder must be understood to move forward.

Status: Phases 1-6 are built and verified (env vars configured, migrations applied to Neon, R2 working, mission-driven Playwright collector capturing real sites with URL discovery, multi-page missions, and carousel/tab/accordion/disclaimer exploration). Dealer data loads from dealer-competitors-flat.csv via `node scripts/import-dealers.mjs` (idempotent: upserts sites by name, missions, and brand run groups; safe to re-run when the CSV changes — an updated copy with a Platform column is expected). Sites carry brand and state.

Run Groups (beyond-roadmap feature, June 2026): named site subsets (first-order dealer(s) flagged primary + related dealers) that scope which missions a run executes; reporting can later anchor comparisons on a group's primary sites. Site relationships intentionally have no admin UI — collection never knows about competitors; reporting (Phase 12) will consume that table. Next up: Phase 7 (Review Workflow).

