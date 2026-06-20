import { and, count, desc, eq, isNull, max, or } from "drizzle-orm";
import { getDb, newsItems } from "@/lib/db";
import { getISOWeekLabel } from "@/lib/cycle";

// ---------------------------------------------------------------------------
// Shared types (also consumed by ReportContent)
// ---------------------------------------------------------------------------

export type NewsItem = {
  id: string;
  headline: string;
  summary: string;
  source_url: string;
  published_at: string;
  category:
    | "recall"
    | "new_model"
    | "sales"
    | "regulatory"
    | "workforce"
    | "incentives"
    | "industry";
  brand?: string | null;
};

export type NewsData = {
  audience: string;
  brand: string | null;
  week: string;
  collected_at: string;
  fresh: boolean;
  all_items: NewsItem[];
  brand_items: NewsItem[];
  industry_items: NewsItem[];
  brand_groups: { brand: string; items: NewsItem[] }[];
};

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

export const isNewsConfigured = (): boolean =>
  Boolean(process.env.NEWS_API_URL && process.env.NEWS_API_KEY);

function newsApiUrl(): string | null {
  const u = process.env.NEWS_API_URL;
  const k = process.env.NEWS_API_KEY;
  return u && k ? u : null;
}

function newsHeaders(): HeadersInit {
  return { Authorization: `Bearer ${process.env.NEWS_API_KEY ?? ""}` };
}

// ---------------------------------------------------------------------------
// External API fetch (raw, no Next.js cache — used only by pullAndStoreNews)
// ---------------------------------------------------------------------------

async function fetchRaw(brand: string | null): Promise<NewsData | null> {
  const base = newsApiUrl();
  if (!base) return null;
  const url = brand
    ? `${base}/api/news?brand=${encodeURIComponent(brand)}`
    : `${base}/api/news`;
  try {
    const res = await fetch(url, { headers: newsHeaders(), cache: "no-store" });
    console.log(`[news] GET ${url} → ${res.status}`);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[news] non-OK response: ${body.slice(0, 200)}`);
      return null;
    }
    return res.json() as Promise<NewsData>;
  } catch (err) {
    console.error(`[news] fetch error for ${url}:`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pull: fetch from external service and store in local DB
// ---------------------------------------------------------------------------

/** Pull all brand + industry news from the news service and store locally.
 *  Replaces any existing rows for the current ISO week.
 *  Returns the number of items stored. */
export async function pullAndStoreNews(): Promise<number> {
  const base = newsApiUrl();
  if (!base) {
    console.error("[news] pullAndStoreNews: NEWS_API_URL or NEWS_API_KEY not set");
    return 0;
  }

  const weekKey = getISOWeekLabel();
  console.log(`[news] starting pull for ${weekKey} from ${base}`);

  // One call — service returns industry_items + brand_groups for all brands it tracks.
  const data = await fetchRaw(null);
  if (!data) {
    console.error("[news] pull failed — no data returned");
    return 0;
  }

  console.log(`[news] response shape: industry_items=${data.industry_items?.length ?? 0}, brand_groups=${data.brand_groups?.length ?? 0}, brand_items=${data.brand_items?.length ?? 0}`);
  if (data.brand_groups?.length) {
    for (const g of data.brand_groups) {
      console.log(`  brand_group: ${g.brand} → ${g.items?.length ?? 0} items`);
    }
  }

  const collected = new Map<string, { item: NewsItem; brand: string | null }>();

  for (const item of data.industry_items ?? []) {
    collected.set(item.source_url, { item, brand: null });
  }
  for (const group of data.brand_groups ?? []) {
    for (const item of group.items ?? []) {
      if (!collected.has(item.source_url)) {
        collected.set(item.source_url, { item, brand: group.brand.toLowerCase() });
      }
    }
  }

  console.log(`[news] collected ${collected.size} unique items for ${weekKey}`);
  if (collected.size === 0) return 0;

  const now = new Date();
  const rows = Array.from(collected.values()).map(({ item, brand }) => ({
    weekKey,
    headline: item.headline,
    summary: item.summary,
    sourceUrl: item.source_url,
    publishedAt: item.published_at,
    category: item.category,
    brand,
    pulledAt: now,
  }));

  const db = getDb();
  await db.delete(newsItems).where(eq(newsItems.weekKey, weekKey));
  await db.insert(newsItems).values(rows);

  console.log(`[news] stored ${rows.length} items for ${weekKey}`);
  return rows.length;
}

// ---------------------------------------------------------------------------
// Local read: for report rendering
// ---------------------------------------------------------------------------

function rowToNewsItem(row: typeof newsItems.$inferSelect): NewsItem {
  return {
    id: row.id,
    headline: row.headline,
    summary: row.summary,
    source_url: row.sourceUrl,
    published_at: row.publishedAt,
    category: row.category as NewsItem["category"],
    brand: row.brand,
  };
}

/** Read stored news for a report from the local DB.
 *  Returns null if no news has been pulled for the current week. */
export async function getStoredNewsForReport(
  brand: string | null
): Promise<NewsData | null> {
  const weekKey = getISOWeekLabel();
  const db = getDb();
  const brandSlug = brand?.toLowerCase() ?? null;

  const rows = await db
    .select()
    .from(newsItems)
    .where(
      and(
        eq(newsItems.weekKey, weekKey),
        brandSlug
          ? or(isNull(newsItems.brand), eq(newsItems.brand, brandSlug))
          : isNull(newsItems.brand)
      )
    )
    .orderBy(desc(newsItems.publishedAt));

  if (rows.length === 0) return null;

  const brandItems = rows.filter((r) => r.brand !== null).slice(0, 6).map(rowToNewsItem);
  const industryItems = rows.filter((r) => r.brand === null).slice(0, 4).map(rowToNewsItem);
  const pulledAt = rows[0].pulledAt.toISOString();

  return {
    audience: "dealer",
    brand: brandSlug,
    week: weekKey,
    collected_at: pulledAt,
    fresh: true,
    all_items: rows.map(rowToNewsItem),
    brand_items: brandItems,
    industry_items: industryItems,
    brand_groups: [],
  };
}

// ---------------------------------------------------------------------------
// Local read: for home page status
// ---------------------------------------------------------------------------

export type NewsPullStatus = {
  pulledAt: Date;
  itemCount: number;
};

/** Returns the last pull timestamp + item count for the current week, or null
 *  if no pull has happened yet. */
export async function getLocalNewsPullStatus(): Promise<NewsPullStatus | null> {
  const weekKey = getISOWeekLabel();
  const db = getDb();

  const [row] = await db
    .select({ pulledAt: max(newsItems.pulledAt), itemCount: count() })
    .from(newsItems)
    .where(eq(newsItems.weekKey, weekKey));

  if (!row?.pulledAt || row.itemCount === 0) return null;
  return { pulledAt: new Date(row.pulledAt), itemCount: row.itemCount };
}
