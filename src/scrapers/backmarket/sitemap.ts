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

async function fetchXml(url: string, userAgent: string): Promise<string> {
  const response = await axios.get(url, {
    headers: { 'User-Agent': userAgent },
    responseType: 'arraybuffer',
    timeout: 30000
  });

  const encoding = String(response.headers['content-encoding'] || '').toLowerCase();
  const contentType = String(response.headers['content-type'] || '').toLowerCase();
  const isGzip = encoding.includes('gzip') || url.endsWith('.gz') || contentType.includes('gzip');

  const buffer = Buffer.from(response.data);
  const xmlBuffer = isGzip ? zlib.gunzipSync(buffer) : buffer;
  return xmlBuffer.toString('utf-8');
}

export function normalizeBackMarketUrl(url: string): string {
  if (!url) {
    return url;
  }
  let normalized = url.replace(/^http:\/\//i, 'https://');
  normalized = normalized.replace(/^https?:\/\/backmarket\.com/i, 'https://www.backmarket.com');
  return normalized;
}

export function isLikelyProductUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith('backmarket.com')) {
      return false;
    }
    const path = parsed.pathname.toLowerCase();
    if (!path.includes('/p/')) {
      return false;
    }
    if (path.includes('/sell') || path.includes('/trade') || path.includes('/help')) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function resolveSitemapUrls(rootSitemapUrl: string, userAgent: string): Promise<string[]> {
  const xml = await fetchXml(rootSitemapUrl, userAgent);
  const { sitemapUrls } = parseSitemap(xml);
  if (sitemapUrls.length === 0) {
    return [normalizeBackMarketUrl(rootSitemapUrl)];
  }
  return sitemapUrls.map(normalizeBackMarketUrl);
}

export async function loadProductUrls(
  rootSitemapUrl: string,
  userAgent: string,
  urlFilter: (url: string) => boolean = isLikelyProductUrl,
  limit?: number
): Promise<string[]> {
  const sitemapUrls = await resolveSitemapUrls(rootSitemapUrl, userAgent);
  const seen = new Set<string>();

  for (const sitemapUrl of sitemapUrls) {
    const xml = await fetchXml(sitemapUrl, userAgent);
    const { urls } = parseSitemap(xml);
    for (const url of urls) {
      if (urlFilter(url)) {
        seen.add(normalizeBackMarketUrl(url));
        if (limit && seen.size >= limit) {
          return [...seen];
        }
      }
    }
  }

  return [...seen];
}
