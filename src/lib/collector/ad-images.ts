import sharp from "sharp";
import { uploadEvidence } from "@/lib/evidence";
import type { MissionType } from "@/lib/db";

/**
 * Ad-graphic capture (collection phase).
 *
 * Image-rendered platforms (DDC/Dealer.com) draw the entire offer — model,
 * payment, due at signing, APR — inside a JPEG, so on those sites the ad
 * graphic IS the evidence. It is collected here, alongside the page's HTML and
 * screenshot, for the same reason those are: it is what the dealer was
 * advertising at this moment, and a report has to be able to show it.
 *
 * This used to live in the analysis runner, which downloaded ad images from the
 * dealer's CDN at analysis time. That broke the layer contract ("passes over a
 * run's stored evidence — no site visits") and made re-analysis non-
 * reproducible: re-running a three-week-old run pulled whatever creative the
 * dealer was serving that day, so the offers no longer described the captured
 * date. Analysis now reads these rows out of R2 and never leaves the building.
 */

/** Below this, an image can't plausibly hold legible offer text — franchise
 *  badges (e.g. "franchise-logos/.../117x80.png") and nav/UI icons are well
 *  under this, real ad cards and coupon graphics are well over it. Shared by
 *  the URL-hint fast path and the post-fetch real-pixel check so both agree on
 *  what counts as "too small". */
const MIN_AD_IMAGE_WIDTH = 150;
const MIN_AD_IMAGE_HEIGHT = 100;
/** Below this many bytes an image is a tracking pixel, spacer, or trivial
 *  icon — not worth decoding just to measure it. */
const MIN_AD_IMAGE_BYTES = 1024;

/** Cap on ad-card images stored per captured page state. */
export const MAX_AD_IMAGES = 15;

/** Map/tile providers. A dealer's embedded "find us" map paints the page with
 *  256x256 tiles that clear the ad-size gate, so they were being fetched and
 *  OCR'd like ad creative — always for nothing. Worse, the tile URLs carry the
 *  DEALER's own Maps API key (published in their page markup): fetching them
 *  spends that dealer's Google quota, and the key then rode into our logs. */
const TILE_HOSTS =
  /(?:^|\.)(?:googleapis\.com|gstatic\.com|google\.com|openstreetmap\.org|mapbox\.com|maptiler\.com|arcgisonline\.com|virtualearth\.net)$/i;

export function isThirdPartyTile(url: string): boolean {
  try {
    return TILE_HOSTS.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Removes credentials from a URL before it is logged or persisted. Dealer
 *  pages embed their own API keys in image URLs; those are their secrets and
 *  have no business in our logs, evidence labels, or database rows. */
export function redactUrl(url: string): string {
  return url.replace(
    /([?&](?:key|token|signature|sig|api_?key|access_?token|auth)=)[^&#]+/gi,
    "$1<redacted>"
  );
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&#38;/g, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ");
}

/** True if the URL itself (filename dimensions like "117x80.png", or a
 *  resize query param like "w=100"/"h=64") tells us the image is too small
 *  to be an ad, without having to fetch it. */
function isTooSmallByUrlHints(url: string): boolean {
  const dims = /(\d{2,4})x(\d{2,4})(?=\.\w+(?:\?|#|$))/i.exec(url);
  if (dims) {
    const w = Number(dims[1]);
    const h = Number(dims[2]);
    if (w < MIN_AD_IMAGE_WIDTH || h < MIN_AD_IMAGE_HEIGHT) return true;
  }
  try {
    const params = new URL(url).searchParams;
    const w = Number(params.get("w") ?? params.get("width") ?? "");
    const h = Number(params.get("h") ?? params.get("height") ?? "");
    if (Number.isFinite(w) && w > 0 && w < MIN_AD_IMAGE_WIDTH) return true;
    if (Number.isFinite(h) && h > 0 && h < MIN_AD_IMAGE_HEIGHT) return true;
  } catch {
    // not a resolvable absolute URL — nothing to check here
  }
  return false;
}

/** Strips structural chrome (header/footer/nav) from HTML, then extracts
 *  candidate offer-card image URLs. Checks src and common lazy-load attributes
 *  (data-src, data-lazy-src, data-original). Skips data URIs, SVGs, obvious
 *  icon/logo/badge URLs, third-party map tiles, and images too small (by
 *  filename or query-param dimensions) to hold legible offer text. Returns
 *  absolute URLs only. */
export function extractAdImageUrls(html: string, pageUrl?: string): string[] {
  const stripped = html
    .replace(/<header\b[\s\S]*?<\/header>/gi, "")
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, "")
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, "");

  const imgRe = /<img\b[^>]*>/gi;
  // src first, then common lazy-load attributes in priority order
  const srcPatterns = [
    /\bsrc=["']([^"']+)["']/i,
    /\bdata-src=["']([^"']+)["']/i,
    /\bdata-lazy-src=["']([^"']+)["']/i,
    /\bdata-original=["']([^"']+)["']/i,
    /\bdata-lazy=["']([^"']+)["']/i,
  ];
  const seen = new Set<string>();
  const urls: string[] = [];
  let m: RegExpExecArray | null;

  while ((m = imgRe.exec(stripped)) !== null) {
    const tag = m[0];
    let src: string | undefined;
    for (const re of srcPatterns) {
      const match = re.exec(tag);
      if (match) { src = match[1].trim(); break; }
    }
    if (!src || src.startsWith("data:")) continue;
    if (/\.(svg|ico|gif)(\?|#|$)/i.test(src)) continue;
    // Matches a keyword as a whole path/filename segment (delimited by /, _,
    // -, or .) rather than requiring it to start right after a "/" — the old
    // pattern missed "franchise-logos/.../117x80.png" because "logos" isn't
    // preceded by a slash.
    if (/(?:^|[/_-])(icons?|logos?|sprites?|badges?|avatars?|favicons?|placeholders?|spacers?|swatch(?:es)?|arrow|btn|button|nav|menu|header|footer|social|share|fb|twitter|instagram|linkedin|youtube|track|pixel|beacon)(?:[/_.-]|$)/i.test(src)) continue;

    src = decodeHtmlAttribute(src);

    let resolved = src;
    if (!src.startsWith("http")) {
      if (!pageUrl) continue;
      try { resolved = new URL(src, pageUrl).toString(); } catch { continue; }
    }
    if (isTooSmallByUrlHints(resolved)) continue;
    if (isThirdPartyTile(resolved)) continue;
    if (!seen.has(resolved)) { seen.add(resolved); urls.push(resolved); }
  }
  return urls;
}

/** Real-pixel-dimension gate applied to a fetched image buffer. Catches
 *  everything the URL-hint fast path can't see — icons with no size in the URL,
 *  tracking pixels, and (as a side effect) empty/corrupt fetch bodies. */
export async function isAdSizedImage(buf: Buffer | null): Promise<boolean> {
  if (!buf || buf.length < MIN_AD_IMAGE_BYTES) return false;
  try {
    const { width, height } = await sharp(buf).metadata();
    return Boolean(width && height && width >= MIN_AD_IMAGE_WIDTH && height >= MIN_AD_IMAGE_HEIGHT);
  } catch {
    return false;
  }
}

async function fetchImage(url: string): Promise<Buffer | null> {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) return null;
    return Buffer.from(await resp.arrayBuffer());
  } catch {
    return null;
  }
}

/** Downloads a captured page's offer-card graphics and stores each as its own
 *  evidence row. Never throws: a dealer's slow CDN must not fail a collection
 *  that already captured the page itself. Returns how many were stored.
 *
 *  `captureKey` is per run + image URL, so the same hero graphic appearing on
 *  the homepage, the specials page, and every carousel state of both is stored
 *  (and later OCR'd) exactly once per run. */
export async function captureAdImages(input: {
  collectionRunId: string;
  siteId: string;
  missionType: MissionType;
  html: string;
  pageUrl?: string;
  /** Ties the ad graphics back to the page state they were rendered on. */
  captureStateId?: string | null;
}): Promise<number> {
  try {
    const urls = extractAdImageUrls(input.html, input.pageUrl).slice(0, MAX_AD_IMAGES);
    // Concurrently: this runs inline in both collectors, and on the Chrome path
    // it sits inside the request the driving tab is waiting on. Sequentially,
    // fifteen slow CDN responses would stall every capture state of every
    // mission. The list is already capped, so this is bounded fan-out, not a
    // stampede.
    const results = await Promise.all(
      urls.map(async (url) => {
        const body = await fetchImage(url);
        if (!(await isAdSizedImage(body))) return false;
        try {
          await uploadEvidence({
            collectionRunId: input.collectionRunId,
            siteId: input.siteId,
            missionType: input.missionType,
            evidenceType: "ad_image",
            fileName: new URL(url).pathname.split("/").pop() || "ad.jpg",
            body: body!,
            label: `Ad graphic — ${redactUrl(url)}`,
            sourceUrl: redactUrl(url),
            captureKey: `${input.collectionRunId}:ad-image:${url}`,
            captureStateId: input.captureStateId ?? null,
          });
          return true;
        } catch (err) {
          console.error(`[collector] ad image store failed url=${redactUrl(url)}:`, err);
          return false;
        }
      })
    );
    return results.filter(Boolean).length;
  } catch (err) {
    console.error("[collector] ad image capture failed:", err);
    return 0;
  }
}
