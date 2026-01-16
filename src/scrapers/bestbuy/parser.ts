import * as cheerio from 'cheerio';
import type { BestBuyProduct } from './types.js';

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function extractSkuFromUrl(url: string): string | null {
  const skuParam = url.match(/skuId=(\d+)/i);
  if (skuParam?.[1]) {
    return skuParam[1];
  }
  const pathMatch = url.match(/\/(\d+)\.p/i);
  return pathMatch?.[1] ?? null;
}

function parseAnalyticsMetadata($: cheerio.CheerioAPI): Record<string, any> | null {
  const raw = $('meta[name="analytics-metadata"]').attr('content');
  if (!raw) {
    return null;
  }

  const normalized = raw
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&amp;/g, '&');

  try {
    return JSON.parse(normalized);
  } catch {
    return null;
  }
}

function extractImagesFromHtml(html: string): string[] {
  const matches = html.match(/https?:\/\/[^\s"']*pisces\.bbystatic\.com[^\s"']+/gi) || [];
  const images = new Set(matches.map(item => item.replace(/\\u0026/g, '&')));
  return [...images];
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

function extractImages($: cheerio.CheerioAPI, productJson: Record<string, any> | null): string[] {
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

  const ogImage = $('meta[property="og:image"]').attr('content');
  if (ogImage) {
    images.add(ogImage);
  }
  const twitterImage = $('meta[name="twitter:image"]').attr('content');
  if (twitterImage) {
    images.add(twitterImage);
  }

  return [...images];
}

export function parseBestBuyProduct(html: string, url: string): BestBuyProduct | null {
  const $ = cheerio.load(html);
  const jsonLd = parseJsonLd(html);
  const nodes = flattenJsonLd(jsonLd);
  const productJson = findProductJson(nodes);
  const analytics = parseAnalyticsMetadata($);
  const analyticsProduct = analytics?.product ?? {};

  const sku =
    productJson?.sku ||
    productJson?.productID ||
    productJson?.skuId ||
    analyticsProduct?.skuId ||
    extractSkuFromUrl(url);

  if (!sku) {
    return null;
  }

  const brand = typeof productJson?.brand === 'string'
    ? productJson?.brand
    : productJson?.brand?.name ?? analyticsProduct?.brand ?? null;

  const model = productJson?.model || productJson?.mpn || analyticsProduct?.model || null;
  const analyticsCategory = [analyticsProduct?.dept, analyticsProduct?.class, analyticsProduct?.subclass]
    .filter(Boolean)
    .join('/');
  const category = productJson?.category || analyticsCategory || null;
  const name =
    productJson?.name ||
    $('meta[property="og:title"]').attr('content') ||
    $('meta[name="title"]').attr('content') ||
    null;

  let price: number | null = null;
  const offerPrice = productJson?.offers?.price;
  if (typeof offerPrice === 'number') {
    price = offerPrice;
  } else if (typeof offerPrice === 'string') {
    const parsed = Number.parseFloat(offerPrice);
    price = Number.isFinite(parsed) ? parsed : null;
  } else if (analyticsProduct?.price) {
    const parsed = Number.parseFloat(String(analyticsProduct.price));
    price = Number.isFinite(parsed) ? parsed : null;
  }

  const imageUrls = [
    ...extractImages($, productJson),
    ...extractImagesFromHtml(html)
  ];

  return {
    sku: String(sku),
    name: name ? String(name) : null,
    brand: brand ? String(brand) : null,
    model: model ? String(model) : null,
    category: category ? String(category) : null,
    price,
    productUrl: url,
    imageUrls,
    rawJson: productJson ?? jsonLd
  };
}
