/**
 * News API client for the autos.media news service.
 * Returns null when the API is not configured or unavailable — callers
 * should render the news section as absent rather than erroring.
 */

export interface NewsItem {
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
}

export interface NewsData {
  brand: string;
  week: string;
  collected_at: string;
  fresh: boolean;
  brand_items: NewsItem[];
  industry_items: NewsItem[];
}

export async function fetchNewsForBrand(
  brand: string | null | undefined
): Promise<NewsData | null> {
  const baseUrl = process.env.NEWS_API_URL;
  const apiKey = process.env.NEWS_API_KEY;

  if (!baseUrl || !apiKey || !brand) return null;

  try {
    const res = await fetch(
      `${baseUrl}/api/news?brand=${encodeURIComponent(brand.toLowerCase())}`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        next: { revalidate: 3600 },
      }
    );
    if (!res.ok) return null;
    return (await res.json()) as NewsData;
  } catch {
    return null;
  }
}
