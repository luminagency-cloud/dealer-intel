<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Project Rules

- **Version bump:** after completing any set of code changes, bump at least the patch level of `version` in `package.json` (e.g. 0.1.0 → 0.1.1). Minor/major bumps only when the user asks or minor on a clear big checkin.
- **Git:** the user handles commits and pushes. Do not commit or push unless explicitly asked.
- **Scope:** work proceeds phase-by-phase per `Docs/Implementation Roadmap.md`. Stop at the end of the agreed phase; do not start the next phase unprompted.
- **Secrets:** live in `.env` at the repo root (not `.env.local`). Never print values; the app and `drizzle.config.ts` both read `.env`.
- **Database:** schema changes go through Drizzle — edit `src/lib/db/schema.ts`, then `npm run db:generate && npm run db:migrate` (Neon, remote). Never hand-write migrations.
- **Runtime:** the app needs a persistent Node server — the collector runs Playwright/Chromium in-process and background run execution lives in server memory (`src/lib/run-executor.ts`). Do not target serverless.
- **Verification:** features are verified in the running app (preview browser against localhost:3000) plus `npx tsc --noEmit && npm run lint && npm run build` before calling work done. Collector changes get verified against a real dealer site.
- **Status:** current build state and module map live in `Docs/Implementation Notes.md`; keep it and CLAUDE.md's status snapshot updated when a phase or major feature lands.
