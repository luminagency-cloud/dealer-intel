# Autos.Media News Gatherer — Build Spec

## What This App Is

A standalone Next.js application that runs weekly web searches across automotive industry and OEM sources, stores significant news items in a database, and exposes a simple API that downstream apps (dealer-intel, autos.media website, magazine pipeline) query by brand.

The editorial bar is high: **significant items only** — recalls, regulatory changes, new model launches, major incentive program changes, OEM workforce/plant decisions, safety investigations. Not: monthly sales up 1.2%, minor trim changes, dealer event announcements.

---

## Tech Stack

- **Framework**: Next.js (App Router), deployed on Vercel
- **Database**: Neon PostgreSQL + Drizzle ORM (same pattern as dealer-intel)
- **Search**: Google Custom Search API (JSON API, tied to Google account)
- **Cron**: Vercel Cron (Saturday morning, e.g. `0 6 * * 6`)
- **Auth**: API key via `Authorization: Bearer <key>` header — simple shared secret for now
- **Language**: TypeScript throughout

---

## Environment Variables

```
# Google Custom Search
GOOGLE_CSE_KEY=          # API key from Google Cloud Console
GOOGLE_CSE_CX=           # Custom Search Engine ID

# App auth (callers must send this)
NEWS_API_KEY=            # shared secret for /api/news endpoint

# Database
DATABASE_URL=            # Neon connection string

# Feature flags
NEWS_REVIEW_REQUIRED=true   # set false to auto-publish without review
```

---

## Database Schema

### `news_sources`
Manages which sites we search. Admin-editable, checkbox-enabled.

```ts
{
  id: uuid PK,
  url: text,                        // e.g. "nhtsa.gov"
  label: text,                      // e.g. "NHTSA"
  type: enum('industry', 'brand'),  // industry = everyone; brand = OEM-specific
  brand: text nullable,             // e.g. "subaru" — null for industry sources
  enabled: boolean default true,
  created_at: timestamp,
  updated_at: timestamp
}
```

### `news_items`
One row per collected news item.

```ts
{
  id: uuid PK,
  run_id: uuid FK → news_runs,
  headline: text,
  summary: text,               // brief factual condensing, not rewritten
  source_url: text,
  published_at: date,
  category: enum('recall', 'new_model', 'sales', 'regulatory', 'workforce', 'incentives', 'industry'),
  brand: text nullable,        // null = industry-wide; "subaru", "nissan", etc.
  status: enum('pending_review', 'approved', 'rejected') default 'pending_review',
  created_at: timestamp
}
```

### `news_runs`
One row per weekly collection run.

```ts
{
  id: uuid PK,
  started_at: timestamp,
  completed_at: timestamp nullable,
  status: enum('running', 'complete', 'failed'),
  items_found: int default 0,
  items_approved: int default 0,
  week_key: text unique,       // ISO week e.g. "2026-W25" — prevents duplicate runs
  notes: text nullable
}
```

---

## News Sources — Starter Set

### Industry (brand-agnostic)
| Label | Domain | Notes |
|---|---|---|
| NHTSA | nhtsa.gov | Recalls, safety investigations |
| Automotive News | autonews.com | Trade industry bible |
| Ward's Auto | wardsauto.com | Production, sales, industry trends |
| Auto Remarketing | autoremarketing.com | Dealer-focused trade news |
| NADA | nadablog.com | Dealer association news |
| EPA | epa.gov | Emissions/regulatory |
| Federal Register | federalregister.gov | Regulatory filings |

### Brand OEM Press Rooms (enable only brands with active dealers)
| Brand | Domain |
|---|---|
| Subaru | media.subaru.com |
| Nissan | nissannews.com |
| Toyota | pressroom.toyota.com |
| Honda | hondanews.com |
| Ford | media.ford.com |
| Chevrolet / GM | media.gm.com |
| Stellantis (Chrysler/Dodge/Jeep/Ram) | media.stellantis.com |
| Hyundai | hyundainews.com |
| Kia | kianewscenter.com |
| Mazda | mazdausamedia.com |
| BMW | press.bmwgroup.com |
| Mercedes-Benz | media.mercedes-benz.com |
| Volkswagen | media.vw.com |
| Audi | media.audiusa.com |
| Lexus | pressroom.lexus.com |

---

## Collection Logic

### When it runs
Vercel Cron fires Saturday ~6am. Before searching, check `news_runs` for a row with `week_key = currentISOWeek()`. If one exists with status `complete`, skip — already ran this week.

### Search query construction

For each **enabled brand source**, build queries:
```
"{brand} recall {month} {year}" site:{source_domain}
"{brand} new model announcement {year}" site:{source_domain}
"{brand} regulatory {year}" site:{source_domain}
"{brand} incentive program {month} {year}" site:{source_domain}
```

For **industry sources**, build queries:
```
"automotive recall {month} {year}" site:{source_domain}
"automotive regulation {year}" site:{source_domain}
"auto industry workforce {month} {year}" site:{source_domain}
```

If a brand source returns 0 results on first pass, retry once with the brand name only + current year (broader).

### Google CSE call
```ts
GET https://www.googleapis.com/customsearch/v1
  ?key={GOOGLE_CSE_KEY}
  &cx={GOOGLE_CSE_CX}
  &q={query}
  &dateRestrict=w1        // past 7 days
  &num=5                  // top 5 results per query
```

Per result, capture: `title` (headline), `snippet` (summary), `link` (source_url), `pagemap.metatags[0].article:published_time` or `pagemap.newsarticle[0].datepublished` (published_at).

### Deduplication
Before inserting, check `source_url` against existing `news_items` from the past 14 days. Skip exact URL duplicates.

### Validation before insert
- `published_at` must be within past 7 days — reject older items
- Headline must be non-empty
- Source URL must be reachable (HEAD request, 200/301/302 acceptable)

### Category inference
Map from query type to category:
- recall query → `recall`
- new model query → `new_model`
- regulatory query → `regulatory`
- incentive query → `incentives`
- industry workforce → `workforce`
- fallback → `industry`

---

## Review Flow (dev/staging mode)

When `NEWS_REVIEW_REQUIRED=true`:
1. Items land in DB with `status = 'pending_review'`
2. Admin UI at `/review` shows pending items — approve or reject each
3. API only returns `status = 'approved'` items

When `NEWS_REVIEW_REQUIRED=false` (production eventually):
1. Items land as `status = 'approved'` immediately
2. No manual step required

---

## Admin UI Pages

### `/` — Dashboard
- Last run: date, items found/approved, week_key
- "Run Now" button (manual trigger, skips week_key check if forced)
- Freshness status: green if ran this week, yellow if not

### `/sources` — News Sources CRUD
- Table of all sources: label, domain, type, brand, enabled toggle
- Add new source form
- Edit/delete per row
- Grouped display: Industry sources / Brand sources

### `/review` — Review Queue
- Only visible when `NEWS_REVIEW_REQUIRED=true`
- Shows pending items grouped by brand
- Per item: headline, summary, source URL (clickable), published date, category pill
- Approve / Reject buttons
- Bulk approve by brand

### `/runs` — Run History
- List of past runs: week_key, started_at, items_found, items_approved, status
- Click into a run to see all items collected

---

## API Endpoint

### `GET /api/news`

**Headers:**
```
Authorization: Bearer {NEWS_API_KEY}
```

**Query params:**
```
brand=subaru          // required; lowercase brand slug
week=2026-W25         // optional; defaults to current ISO week
```

**Response:**
```json
{
  "brand": "subaru",
  "week": "2026-W25",
  "collected_at": "2026-06-21T06:14:00Z",
  "fresh": true,
  "brand_items": [
    {
      "id": "uuid",
      "headline": "Hybrid fuel-cap fire risk — 2026 Crosstrek Hybrid & 2025 Forester Hybrid",
      "summary": "Subaru recalled ~70,000 hybrid SUVs over an insufficient fuel-cap seal...",
      "source_url": "https://nhtsa.gov/...",
      "published_at": "2026-06-18",
      "category": "recall"
    }
  ],
  "industry_items": [
    {
      "id": "uuid",
      "headline": "NHTSA proposes new EV battery fire disclosure rule",
      "summary": "...",
      "source_url": "https://...",
      "published_at": "2026-06-17",
      "category": "regulatory"
    }
  ]
}
```

**`fresh` field**: `true` if `collected_at` is within the current ISO week. Caller can use this to show a staleness warning if `false`.

**Limits**: Returns max 6 `brand_items` + max 4 `industry_items`, ordered by `published_at` desc. Caller decides how many to display.

**Error responses:**
```json
401 { "error": "unauthorized" }
400 { "error": "brand param required" }
200 { "brand": "subaru", "fresh": false, "brand_items": [], "industry_items": [] }
   // 200 with empty arrays when no data — never 404 for missing news
```

---

## What dealer-intel needs (integration side)

### Env vars to add to dealer-intel
```
NEWS_API_URL=https://your-news-app.vercel.app
NEWS_API_KEY=same-shared-secret
```

### Fetch pattern in dealer-intel
```ts
async function fetchNewsForBrand(brand: string) {
  try {
    const res = await fetch(
      `${process.env.NEWS_API_URL}/api/news?brand=${brand}`,
      {
        headers: { Authorization: `Bearer ${process.env.NEWS_API_KEY}` },
        next: { revalidate: 3600 } // cache 1hr — news doesn't change mid-day
      }
    );
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null; // news section silently absent on API failure
  }
}
```

### Report rendering rule
- If `fetchNewsForBrand` returns null or empty arrays → news section does not render (no error, no placeholder)
- If `fresh === false` → optionally show a subtle "News last updated [date]" note
- Display: brand_items first, then industry_items, interleaved or separate (your call on layout)
- Max display in report: 4 items total (you trim from the API's returned max)
- Each card: category pill + headline (linked to source_url) + summary. No rewriting.

---

## Freshness / Staleness Logic

| Condition | Behavior |
|---|---|
| `news_runs` has a `complete` row for current ISO week | Skip run (already done) |
| No complete run for current week | Flag in dashboard; cron will run Saturday |
| Item `published_at` > 7 days old | Excluded from API response automatically (WHERE clause) |
| Item `published_at` > 14 days old | Safe to hard-delete in a cleanup job |

---

## Build Order Suggestion

1. DB schema + Drizzle setup
2. Google CSE integration + single test query
3. Gather logic (search → validate → insert)
4. `/sources` admin CRUD
5. Cron endpoint (`/api/cron/gather`) + Vercel Cron config
6. `/api/news` public endpoint
7. `/review` UI
8. `/runs` history UI
9. `/` dashboard with freshness status
10. Wire dealer-intel stub
