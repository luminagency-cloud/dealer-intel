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
