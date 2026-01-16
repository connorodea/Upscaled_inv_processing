import axios from 'axios';
import zlib from 'zlib';
import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  allowBooleanAttributes: true,
  trimValues: true
});

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function parseSitemap(xml: string): { sitemapUrls: string[]; urls: string[] } {
  let parsed: any;
  try {
    parsed = parser.parse(xml);
  } catch (error) {
    const preview = xml.slice(0, 200).replace(/\s+/g, ' ');
    throw new Error(`Failed to parse sitemap XML. Preview: ${preview}`);
  }
  const sitemapUrls = asArray(parsed?.sitemapindex?.sitemap).map((entry: any) => entry?.loc).filter(Boolean);
  const urls = asArray(parsed?.urlset?.url).map((entry: any) => entry?.loc).filter(Boolean);
  return { sitemapUrls, urls };
}

async function fetchXml(
  url: string,
  userAgent: string,
  timeoutMs: number,
  retries: number,
  retryDelayMs: number
): Promise<string> {
  let attempt = 0;
  while (true) {
    try {
      const response = await axios.get(url, {
        headers: { 'User-Agent': userAgent },
        responseType: 'arraybuffer',
        timeout: timeoutMs
      });

      const encoding = String(response.headers['content-encoding'] || '').toLowerCase();
      const contentType = String(response.headers['content-type'] || '').toLowerCase();
      const isGzip = encoding.includes('gzip') || url.endsWith('.gz') || contentType.includes('gzip');

      const buffer = Buffer.from(response.data);
      const xmlBuffer = isGzip ? zlib.gunzipSync(buffer) : buffer;
      return xmlBuffer.toString('utf-8');
    } catch (error) {
      if (attempt >= retries) {
        throw error;
      }
      attempt += 1;
      if (retryDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      }
    }
  }
}

export function isLikelyProductUrl(url: string): boolean {
  if (!/bestbuy\.com\/site\//i.test(url)) {
    return false;
  }
  if (/\/site\/services\//i.test(url)) {
    return false;
  }
  return /skuId=\d+/i.test(url) || /\/\d+\.p(\?|$)/i.test(url);
}

export function normalizeBestBuyUrl(url: string): string {
  if (!url) {
    return url;
  }
  let normalized = url.replace(/^http:\/\//i, 'https://');
  normalized = normalized.replace(/^https?:\/\/bestbuy\.com/i, 'https://www.bestbuy.com');
  return normalized;
}

export async function resolveSitemapUrls(
  rootSitemapUrl: string,
  userAgent: string,
  timeoutMs: number,
  retries: number,
  retryDelayMs: number
): Promise<string[]> {
  const xml = await fetchXml(rootSitemapUrl, userAgent, timeoutMs, retries, retryDelayMs);
  const { sitemapUrls } = parseSitemap(xml);
  if (sitemapUrls.length === 0) {
    return [normalizeBestBuyUrl(rootSitemapUrl)];
  }
  const normalized = sitemapUrls.map(normalizeBestBuyUrl);
  const productSitemaps = normalized.filter(url => /sitemap_product/i.test(url));
  return productSitemaps.length > 0 ? productSitemaps : normalized;
}

export async function loadProductUrls(
  rootSitemapUrl: string,
  userAgent: string,
  urlFilter: (url: string) => boolean = isLikelyProductUrl,
  limit?: number,
  timeoutMs = 30000,
  retries = 0,
  retryDelayMs = 0
): Promise<string[]> {
  const sitemapUrls = await resolveSitemapUrls(
    rootSitemapUrl,
    userAgent,
    timeoutMs,
    retries,
    retryDelayMs
  );
  const seen = new Set<string>();

  for (const sitemapUrl of sitemapUrls) {
    const xml = await fetchXml(sitemapUrl, userAgent, timeoutMs, retries, retryDelayMs);
    const { urls } = parseSitemap(xml);
    for (const url of urls) {
      if (urlFilter(url)) {
        seen.add(normalizeBestBuyUrl(url));
        if (limit && seen.size >= limit) {
          return [...seen];
        }
      }
    }
  }

  return [...seen];
}
