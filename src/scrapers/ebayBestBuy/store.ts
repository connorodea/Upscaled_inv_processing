import * as cheerio from 'cheerio';

export function buildStorePageUrl(storeUrl: string, page: number, itemsPerPage: number): string {
  const url = new URL(storeUrl);
  url.searchParams.set('_pgn', String(page));
  url.searchParams.set('_ipg', String(itemsPerPage));
  return url.toString();
}

export function normalizeEbayItemUrl(value: string): string | null {
  try {
    const url = new URL(value, 'https://www.ebay.com');
    const match = url.pathname.match(/\/itm\/(?:[^/]+\/)?(\d{8,})/i);
    const itemId = match?.[1] || url.searchParams.get('item') || null;
    if (itemId) {
      return `https://www.ebay.com/itm/${itemId}`;
    }
    const digits = url.href.match(/(\d{8,})/);
    if (digits?.[1]) {
      return `https://www.ebay.com/itm/${digits[1]}`;
    }
  } catch {
    // ignore
  }
  return null;
}

export function extractItemUrls(html: string): string[] {
  const $ = cheerio.load(html);
  const urls = new Set<string>();

  $('a.s-item__link').each((_idx, element) => {
    const href = $(element).attr('href');
    if (!href) return;
    const normalized = normalizeEbayItemUrl(href);
    if (normalized) {
      urls.add(normalized);
    }
  });

  $('a[href*="/itm/"]').each((_idx, element) => {
    const href = $(element).attr('href');
    if (!href) return;
    const normalized = normalizeEbayItemUrl(href);
    if (normalized) {
      urls.add(normalized);
    }
  });

  return [...urls];
}
