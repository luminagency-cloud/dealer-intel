# Automotive and Brand News Collector — Business Rules

## What we're collecting
Automotive ndustry and brand news from the past 7 days, scoped to the client dealer's make(s).
Four categories: Recalls & Safety | Product & Manufacturing | Industry & Workforce | Incentives & Campaigns

## Scope
- Past 7 days only. No older items.
- Scoped to the brand(s) the client dealer sells.
  Multi-brand dealers (CDJR, GMA) get news for all their makes.
- Do not include competitor news or general automotive news unless it affects the client's brand.

## Collection method
- Web search per category, e.g.:
  - "Subaru recall 2026 site:nhtsa.gov OR site:media.subaru.com"
  - "Subaru new model announcement May 2026"
  - "automotive industry workforce news May 2026"
  - "Subaru lease incentives May 2026"
- If a category returns nothing, retry with broader search terms once.
- If all four categories are empty after two passes, record zero items and flag in output.
  Do not fabricate news items.

## Per item, capture
- headline (verbatim from source)
- summary (brief, factual — not paraphrased beyond necessary condensing)
- source_url
- published_at date

## Validation
- At least 1 item in at least 2 of the 4 categories before marking complete.
- Items must be dated within the past 7 days. Reject anything older.
- No fabricated statistics in summaries.

# Build path
- identify our canonical news sources in two groups: 
- 1) Industry news, dealer agnostic
- 2) Brand news sources for each covered dealer. Only dealers we have as clients, so we don't need Jaguar, Land Rover, etc. (Though we may add those as our dealer base expands)