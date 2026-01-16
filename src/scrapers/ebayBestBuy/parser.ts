import * as cheerio from 'cheerio';
import type { EbayStoreItem } from './types.js';

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function normalizeText(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > 0 ? text : null;
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
    if (types.some((entry: string) => entry === 'Product')) {
      return node;
    }
  }
  return null;
}

function extractItemIdFromUrl(url: string): string | null {
  const match = url.match(/\/itm\/(?:[^/]+\/)?(\d{8,})/i);
  if (match?.[1]) {
    return match[1];
  }
  const digits = url.match(/(\d{8,})/);
  return digits?.[1] ?? null;
}

function extractItemIdFromHtml($: cheerio.CheerioAPI, html: string): string | null {
  const inputId = $('input[name="item_id"], input[name="itemId"]').attr('value');
  if (inputId) {
    return inputId;
  }

  const ogUrl = $('meta[property="og:url"]').attr('content');
  if (ogUrl) {
    const fromOg = extractItemIdFromUrl(ogUrl);
    if (fromOg) return fromOg;
  }

  const match = html.match(/"itemId"\s*:\s*"(\d{8,})"/);
  if (match?.[1]) {
    return match[1];
  }

  return null;
}

function parsePrice(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const raw = typeof value === 'number' ? String(value) : value;
  const cleaned = raw.replace(/[^\d.]+/g, '');
  if (!cleaned) {
    return null;
  }
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractSrcsetUrls(value: string): string[] {
  return value
    .split(',')
    .map(part => part.trim().split(' ')[0])
    .filter(Boolean);
}

function extractImages($: cheerio.CheerioAPI, productJson: Record<string, any> | null, html: string): string[] {
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

  $('img').each((_idx, element) => {
    const el = $(element);
    const src = el.attr('src');
    const zoomSrc = el.attr('data-zoom-src');
    const dataSrc = el.attr('data-src');
    const srcset = el.attr('srcset');
    if (src) images.add(src);
    if (zoomSrc) images.add(zoomSrc);
    if (dataSrc) images.add(dataSrc);
    if (srcset) {
      extractSrcsetUrls(srcset).forEach(url => images.add(url));
    }
  });

  const rawMatches = html.match(/https?:[^"'\\s]*i\\.ebayimg\\.com[^"'\\s]*/gi) || [];
  rawMatches.forEach(match => {
    const normalized = match.replace(/\\u002F/g, '/').replace(/\\\//g, '/');
    images.add(normalized);
  });

  return [...images];
}

function extractCategoryPath($: cheerio.CheerioAPI): string | null {
  const breadcrumbs = $('nav[aria-label="Breadcrumb"] a')
    .map((_idx, element) => normalizeText($(element).text()))
    .get()
    .filter(Boolean) as string[];

  if (breadcrumbs.length > 0) {
    return breadcrumbs.join(' > ');
  }

  const legacy = $('#vi-VR-brumb-lnkLst a')
    .map((_idx, element) => normalizeText($(element).text()))
    .get()
    .filter(Boolean) as string[];

  return legacy.length > 0 ? legacy.join(' > ') : null;
}

function extractItemSpecifics($: cheerio.CheerioAPI): Record<string, string> {
  const specifics: Record<string, string> = {};
  const container = $('[data-testid="x-item-specs"]').first();
  const legacy = $('#viTabs_0_is').first();
  const scope = container.length > 0 ? container : legacy.length > 0 ? legacy : $('body');

  scope.find('.ux-labels-values__row').each((_idx, row) => {
    const label = normalizeText($(row).find('.ux-labels-values__labels').first().text());
    const value = normalizeText($(row).find('.ux-labels-values__values').first().text());
    if (label && value && !specifics[label]) {
      specifics[label] = value;
    }
  });

  scope.find('dl').each((_idx, dl) => {
    const labels = $(dl).find('dt');
    const values = $(dl).find('dd');
    labels.each((labelIdx, labelEl) => {
      const label = normalizeText($(labelEl).text());
      const value = normalizeText($(values.get(labelIdx)).text());
      if (label && value && !specifics[label]) {
        specifics[label] = value;
      }
    });
  });

  return specifics;
}

function extractSpecific(specifics: Record<string, string>, keys: string[]): string | null {
  for (const key of keys) {
    if (specifics[key]) {
      return specifics[key];
    }
  }
  return null;
}

function extractDescriptionText(descriptionHtml: string | null): string | null {
  if (!descriptionHtml) {
    return null;
  }
  const $ = cheerio.load(descriptionHtml);
  return normalizeText($.text());
}

export function extractDescriptionUrl(html: string, baseUrl: string): string | null {
  const $ = cheerio.load(html);
  const iframeSrc = $('#desc_ifr').attr('src') || $('iframe#desc_ifr').attr('src');
  if (!iframeSrc) {
    return null;
  }
  try {
    return new URL(iframeSrc, baseUrl).toString();
  } catch {
    return iframeSrc;
  }
}

export function parseEbayItem(
  html: string,
  url: string,
  descriptionHtml: string | null
): EbayStoreItem | null {
  const $ = cheerio.load(html);
  const jsonLd = parseJsonLd(html);
  const nodes = flattenJsonLd(jsonLd);
  const productJson = findProductJson(nodes);
  const itemId =
    extractItemIdFromUrl(url) ||
    extractItemIdFromHtml($, html) ||
    productJson?.sku ||
    productJson?.productID ||
    null;

  if (!itemId) {
    return null;
  }

  const rawTitle =
    $('h1[itemprop="name"]').text() ||
    $('#itemTitle').clone().children().remove().end().text() ||
    $('meta[property="og:title"]').attr('content') ||
    null;
  const title = normalizeText(rawTitle?.replace(/^Details about\s+/i, ''));

  const price =
    parsePrice($('meta[property="product:price:amount"]').attr('content')) ||
    parsePrice($('meta[itemprop="price"]').attr('content')) ||
    parsePrice($('#prcIsum').attr('content')) ||
    parsePrice($('#prcIsum').text()) ||
    parsePrice($('[data-testid="x-price-primary"] span').first().text()) ||
    parsePrice(productJson?.offers?.price) ||
    null;

  const currency =
    $('meta[property="product:price:currency"]').attr('content') ||
    $('meta[itemprop="priceCurrency"]').attr('content') ||
    productJson?.offers?.priceCurrency ||
    null;

  const condition = normalizeText(
    $('[data-testid="x-item-condition-text"]').text() ||
      $('#vi-itm-cond').text() ||
      $('span[itemprop="itemCondition"]').text() ||
      null
  );

  const sellerName = normalizeText(
    $('span.mbg-nw').first().text() ||
      $('[data-testid="x-sellercard-atf"] a[href*="/usr/"]').first().text() ||
      $('a[href*="/usr/"]').first().text() ||
      null
  );

  const storeName = normalizeText(
    $('a[href*="/str/"]').first().text() ||
      $('[data-testid="x-store-information"] a').first().text() ||
      null
  );

  const categoryPath = extractCategoryPath($);
  const itemSpecifics = extractItemSpecifics($);

  const brand =
    productJson?.brand?.name ||
    (typeof productJson?.brand === 'string' ? productJson.brand : null) ||
    extractSpecific(itemSpecifics, ['Brand']);

  const mpn =
    productJson?.mpn ||
    extractSpecific(itemSpecifics, ['MPN', 'Manufacturer Part Number']);

  const model =
    productJson?.model ||
    extractSpecific(itemSpecifics, ['Model']);

  const upc =
    productJson?.gtin13 ||
    productJson?.gtin12 ||
    extractSpecific(itemSpecifics, ['UPC', 'UPC/EAN', 'EAN']);

  const imageUrls = extractImages($, productJson, html);

  return {
    itemId: String(itemId),
    title,
    descriptionHtml,
    descriptionText: extractDescriptionText(descriptionHtml),
    condition,
    price,
    currency: currency ? String(currency) : null,
    categoryPath,
    sellerName,
    storeName,
    brand: brand ? String(brand) : null,
    mpn: mpn ? String(mpn) : null,
    model: model ? String(model) : null,
    upc: upc ? String(upc) : null,
    listingUrl: url,
    imageUrls,
    itemSpecifics,
    rawJson: productJson ?? jsonLd
  };
}
