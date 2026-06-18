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

export type NewsFreshness = {
  fresh: boolean;
  week: string;
  collected_at: string;
};

function newsHeaders(): HeadersInit {
  return { Authorization: `Bearer ${process.env.NEWS_API_KEY ?? ""}` };
}

function newsApiUrl(): string | null {
  const u = process.env.NEWS_API_URL;
  const k = process.env.NEWS_API_KEY;
  return u && k ? u : null;
}

export async function fetchNewsForBrand(brand: string | null): Promise<NewsData | null> {
  const base = newsApiUrl();
  if (!base || !brand) return null;

  try {
    const res = await fetch(
      `${base}/api/news?brand=${encodeURIComponent(brand.toLowerCase())}`,
      {
        headers: newsHeaders(),
        next: { revalidate: 3600 },
      }
    );
    if (!res.ok) return null;
    return res.json() as Promise<NewsData>;
  } catch {
    return null;
  }
}

export async function fetchNewsFreshness(): Promise<NewsFreshness | null> {
  const base = newsApiUrl();
  if (!base) return null;

  try {
    const res = await fetch(`${base}/api/news`, {
      headers: newsHeaders(),
      next: { revalidate: 3600 },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as NewsData;
    return { fresh: data.fresh, week: data.week, collected_at: data.collected_at };
  } catch {
    return null;
  }
}

export type NewsOverview = {
  fresh: boolean;
  week: string;
  generalCount: number;
  brandCounts: { brand: string; count: number }[];
};

export async function fetchNewsOverview(): Promise<NewsOverview | null> {
  const base = newsApiUrl();
  if (!base) return null;
  try {
    const res = await fetch(`${base}/api/news`, {
      headers: newsHeaders(),
      next: { revalidate: 3600 },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as NewsData;
    return {
      fresh: data.fresh,
      week: data.week,
      generalCount: data.industry_items?.length ?? 0,
      brandCounts: (data.brand_groups ?? [])
        .filter((bg) => bg.items.length > 0)
        .map((bg) => ({ brand: bg.brand, count: bg.items.length })),
    };
  } catch {
    return null;
  }
}

export const isNewsConfigured = (): boolean =>
  Boolean(process.env.NEWS_API_URL && process.env.NEWS_API_KEY);
