import * as cheerio from 'cheerio';
import crypto from 'crypto';
import type { BackMarketProduct } from './types.js';

const IMAGE_URL_RE = /\.(jpe?g|png|webp|gif)(\?|#|$)/i;
const MAX_WALK_NODES = 10000;
const MAX_IMAGE_URLS = 200;

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function parseJsonLd(html: string): unknown[] {
  const $ = cheerio.load(html);
  const scripts = $('script[type="application/ld+json"]');
  const results: unknown[] = [];

  scripts.each((_idx, element) => {
    const content = $(element).text().trim();
    if (!content) return;
    try {
      const parsed = JSON.parse(content);
      results.push(parsed);
    } catch {
      // Ignore invalid JSON-LD blocks.
    }
  });

  return results;
}

function flattenJsonLd(nodes: unknown[]): Record<string, any>[] {
  const flattened: Record<string, any>[] = [];

  const visit = (node: any): void => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node !== 'object') {
      return;
    }
    flattened.push(node);
    if (node['@graph']) {
      visit(node['@graph']);
    }
  };

  nodes.forEach(visit);
  return flattened;
}

function findProductJson(nodes: Record<string, any>[]): Record<string, any> | null {
  for (const node of nodes) {
    const type = node['@type'];
    const types = Array.isArray(type) ? type : [type];
    if (types.some((entry: string) => entry === 'Product' || entry === 'ProductGroup')) {
      return node;
    }
  }
  return null;
}

function parseNextData(html: string): unknown | null {
  const $ = cheerio.load(html);
  const script = $('script#__NEXT_DATA__').first();
  const raw = script.text().trim();
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractMeta($: cheerio.CheerioAPI): Record<string, string> {
  const meta: Record<string, string> = {};
  const names = [
    'description',
    'og:title',
    'og:description',
    'og:image',
    'twitter:title',
    'twitter:description',
    'twitter:image',
    'product:retailer_item_id'
  ];
  for (const name of names) {
    const attr = name.startsWith('og:') || name.startsWith('product:') ? 'property' : 'name';
    const content = $(`meta[${attr}="${name}"]`).attr('content');
    if (content) {
      meta[name] = content;
    }
  }
  return meta;
}

function normalizeCondition(value?: string | null): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith('http')) {
    const parts = trimmed.split('/').filter(Boolean);
    return parts[parts.length - 1] || trimmed;
  }
  return trimmed;
}

function extractOfferData(offers: any): { price: number | null; currency: string | null } {
  const list = asArray(offers);
  for (const offer of list) {
    if (!offer) continue;
    const priceValue = offer.price ?? offer.lowPrice ?? offer.highPrice;
    let price: number | null = null;
    if (typeof priceValue === 'number') {
      price = priceValue;
    } else if (typeof priceValue === 'string') {
      const parsed = Number.parseFloat(priceValue);
      price = Number.isFinite(parsed) ? parsed : null;
    }
    const currency = offer.priceCurrency ? String(offer.priceCurrency) : null;
    if (price !== null || currency) {
      return { price, currency };
    }
  }
  return { price: null, currency: null };
}

function extractImageUrlsFromValue(value: any, urls: Set<string>, depth: number, state: { nodes: number }): void {
  if (!value || urls.size >= MAX_IMAGE_URLS || state.nodes >= MAX_WALK_NODES) {
    return;
  }
  state.nodes += 1;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('http') && (IMAGE_URL_RE.test(trimmed) || trimmed.includes('/images/'))) {
      urls.add(trimmed);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      extractImageUrlsFromValue(entry, urls, depth + 1, state);
      if (urls.size >= MAX_IMAGE_URLS) return;
    }
    return;
  }
  if (typeof value === 'object') {
    if (depth > 8) {
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      if (/image|images|picture|pictures|gallery|photo|media/i.test(key)) {
        extractImageUrlsFromValue(entry, urls, depth + 1, state);
      } else if (typeof entry === 'string') {
        extractImageUrlsFromValue(entry, urls, depth + 1, state);
      } else if (typeof entry === 'object') {
        extractImageUrlsFromValue(entry, urls, depth + 1, state);
      }
      if (urls.size >= MAX_IMAGE_URLS || state.nodes >= MAX_WALK_NODES) {
        return;
      }
    }
  }
}

function extractImages($: cheerio.CheerioAPI, productJson: Record<string, any> | null, nextData: any): string[] {
  const images = new Set<string>();

  if (productJson?.image) {
    for (const img of asArray(productJson.image)) {
      if (typeof img === 'string') {
        images.add(img);
      } else if (img?.url) {
        images.add(img.url);
      }
    }
  }

  const metaImage = $('meta[property="og:image"]').attr('content');
  if (metaImage) {
    images.add(metaImage);
  }
  const twitterImage = $('meta[name="twitter:image"]').attr('content');
  if (twitterImage) {
    images.add(twitterImage);
  }

  const state = { nodes: 0 };
  extractImageUrlsFromValue(nextData, images, 0, state);

  return [...images];
}

function getNextProduct(nextData: any): any | null {
  if (!nextData || typeof nextData !== 'object') {
    return null;
  }
  const candidates = [
    nextData?.props?.pageProps?.product,
    nextData?.props?.pageProps?.data?.product,
    nextData?.props?.pageProps?.pdp?.product,
    nextData?.props?.pageProps?.props?.product
  ];
  return candidates.find(Boolean) ?? null;
}

function extractProductId(productJson: Record<string, any> | null, nextData: any, meta: Record<string, string>): string | null {
  const id = productJson?.sku || productJson?.productID || productJson?.mpn || null;
  if (id) {
    return String(id);
  }
  const nextProduct = getNextProduct(nextData);
  const nextId = nextProduct?.id || nextProduct?.productId || nextProduct?.uuid || nextProduct?.sku || null;
  if (nextId) {
    return String(nextId);
  }
  if (meta['product:retailer_item_id']) {
    return meta['product:retailer_item_id'];
  }
  return null;
}

function buildProductKey(productId: string | null, url: string): string {
  if (productId) {
    return productId;
  }
  return `bm_${crypto.createHash('sha1').update(url).digest('hex').slice(0, 12)}`;
}

export function parseBackMarketProduct(html: string, url: string): BackMarketProduct | null {
  const $ = cheerio.load(html);
  const jsonLd = parseJsonLd(html);
  const nodes = flattenJsonLd(jsonLd);
  const productJson = findProductJson(nodes);
  const nextData = parseNextData(html);
  const meta = extractMeta($);

  const productId = extractProductId(productJson, nextData, meta);
  const productKey = buildProductKey(productId, url);

  const name = productJson?.name || meta['og:title'] || meta['twitter:title'] || null;
  const brand = typeof productJson?.brand === 'string'
    ? productJson?.brand
    : productJson?.brand?.name ?? null;
  const model = productJson?.model || productJson?.mpn || null;
  const category = productJson?.category?.name || productJson?.category || null;
  const condition = normalizeCondition(productJson?.itemCondition || productJson?.offers?.itemCondition);

  const { price, currency } = extractOfferData(productJson?.offers);
  const ratingValue = productJson?.aggregateRating?.ratingValue ?? null;
  const reviewCountValue = productJson?.aggregateRating?.reviewCount ?? productJson?.aggregateRating?.ratingCount ?? null;
  const rating = typeof ratingValue === 'number' ? ratingValue : ratingValue ? Number.parseFloat(ratingValue) : null;
  const reviewCount = typeof reviewCountValue === 'number'
    ? reviewCountValue
    : reviewCountValue
      ? Number.parseInt(String(reviewCountValue), 10)
      : null;

  const imageUrls = extractImages($, productJson, nextData);

  return {
    productKey,
    productId,
    name: name ? String(name) : null,
    brand: brand ? String(brand) : null,
    model: model ? String(model) : null,
    category: category ? String(category) : null,
    condition,
    price,
    currency,
    rating: Number.isFinite(rating ?? NaN) ? rating : null,
    reviewCount: Number.isFinite(reviewCount ?? NaN) ? reviewCount : null,
    productUrl: url,
    imageUrls,
    rawJson: {
      productJson,
      jsonLd,
      nextData,
      meta
    }
  };
}
