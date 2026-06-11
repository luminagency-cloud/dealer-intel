<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Project Rules

- **Version bump:** after completing any set of code changes, bump the patch level of `version` in `package.json` (e.g. 0.1.0 → 0.1.1). Minor/major bumps only when the user asks.
- **Git:** the user handles commits and pushes. Do not commit or push unless explicitly asked.
- **Scope:** work proceeds phase-by-phase per `Docs/Implementation Roadmap.md`. Stop at the end of the agreed phase; do not start the next phase unprompted.
- **Secrets:** live in `.env` at the repo root (not `.env.local`). Never print values; the app and `drizzle.config.ts` both read `.env`.
