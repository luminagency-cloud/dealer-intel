<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes. APIs, conventions, and file structure may
differ from training data. Before changing Next.js code, read the relevant
guide in `node_modules/next/dist/docs/` and heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Agent Instructions

## Start Here

- `Docs/Implementation Roadmap.md` is the single working list for current
  status and open work.
- `Docs/Implementation Notes.md` is the compact architecture/module map.
- Do not infer open tasks from old build history. If something is not in the
  working list, verify before treating it as open.

## Product Truth

Dealer Intel is a collect -> analyze -> report platform.

- Collection stores raw evidence from dealer sites.
- Analysis reads stored evidence and creates offers/compliance grades.
- Reporting reads published snapshots only.
- Reports do not scrape sites, analyze live pages, or read mutable run data.

Collection is dealer/site-scoped. In a normal run, selected missions for one
dealer run in one browser session with a shared capture cache. Missions are
targeting buckets, not separate browser jobs.

## Current Verified Status

As of July 1, 2026:

- AdScore compliance is implemented, configured, and storing real AdScore
  results.
- AI-assisted analysis is implemented, configured, and producing AI-assisted
  offers.
- News and inventory are implemented and locally configured.
- The workspace uses `.env` for local configuration.

Never print secret values.

## Project Rules

- **Scope:** stay within the item the user asked for. Do not start unrelated
  backlog work unprompted.
- **Git:** the user handles commits and pushes. Do not commit or push unless
  explicitly asked.
- **Version bump:** after code changes, bump at least the patch version in
  `package.json`. Docs-only changes do not need a version bump.
- **Database:** schema changes go through Drizzle. Edit
  `src/lib/db/schema.ts`, then run `npm run db:generate` and
  `npm run db:migrate`. Never hand-write migrations.
- **Runtime:** the admin app requires a persistent Node server. Playwright runs
  in-process, and background run execution lives in server memory. Do not
  target serverless for the admin app.
- **Local dev server:** the app is ALWAYS already running on
  `http://localhost:3000` (the operator keeps it up). Do NOT start your own
  (`npm run dev` / preview) — use the running one. Only start a server if you
  have confirmed none is running. Dev logs: `.next/dev/logs/next-development.log`.
- **Docs:** keep `Docs/Implementation Roadmap.md` and
  `Docs/Implementation Notes.md` readable for humans when major behavior
  changes.

## Verification

Before calling code work done:

- Run `npx tsc --noEmit`.
- Run `npm run lint`.
- Run `npm run build`.
- Verify user-facing features in the running app against localhost.
- For collector changes, also verify against a real dealer site.

If a command needs remote services, network access, credentials, database
access, or Git index/ref writes, request escalation first.
