# Dealer Intel

Dealer Offer Intelligence Platform — collects dealership offers, preserves evidence, normalizes offers into structured data, and generates competitive intelligence reports.

Design docs live in [./Docs](./Docs). Current status: **Phase 1 (Platform Foundation) complete** — see [Docs/Implementation Roadmap.md](./Docs/Implementation%20Roadmap.md).

## Stack

- Next.js (App Router) + TypeScript + Tailwind
- Neon Postgres via Drizzle ORM
- Cloudflare R2 (S3-compatible) for evidence storage — client wired, used from Phase 4
- Auth.js credentials login (single operator)

## Setup

1. Install dependencies:

   ```
   npm install
   ```

2. Create `.env` from the template and fill it in:

   ```
   copy .env.example .env
   ```

   | Variable | Where it comes from |
   | --- | --- |
   | `DATABASE_URL` | Neon dashboard → pooled connection string |
   | `AUTH_SECRET` | `npx auth secret` (or any long random string) |
   | `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Your choice — the operator login |
   | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | Cloudflare dashboard → R2 → API tokens (optional until Phase 4) |

3. Apply the database schema to Neon:

   ```
   npm run db:migrate
   ```

4. Run:

   ```
   npm run dev
   ```

The app boots without any env vars — pages show a setup notice describing what's missing instead of crashing.

## Database scripts

| Script | Purpose |
| --- | --- |
| `npm run db:generate` | Generate SQL migrations from `src/lib/db/schema.ts` |
| `npm run db:migrate` | Apply migrations to the database |
| `npm run db:push` | Push schema directly (dev convenience) |
| `npm run db:studio` | Browse data in Drizzle Studio |

## Layout

```
src/
  auth.ts                  Auth.js config (credentials provider)
  lib/
    env.ts                 zod-validated environment access
    db/schema.ts           Drizzle schema (sites, missions)
    db/index.ts            lazy Neon + Drizzle client
    r2.ts                  lazy Cloudflare R2 client
    session.ts             requireSession() guard
  app/
    login/                 operator login
    (admin)/sites/         site management (list, create, edit, enable/disable)
    (admin)/missions/      mission management (list, create, edit, enable/disable)
drizzle/                   generated SQL migrations
Docs/                      architecture and roadmap
```
