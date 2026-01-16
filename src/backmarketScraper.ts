import path from 'path';
import { BackMarketDb } from './scrapers/backmarket/db.js';
import { loadProductUrls, isLikelyProductUrl, normalizeBackMarketUrl } from './scrapers/backmarket/sitemap.js';
import { parseBackMarketProduct } from './scrapers/backmarket/parser.js';
import { buildImagePath, downloadImage } from './scrapers/bestbuy/downloader.js';
import type { ImageRecord, ScraperConfig } from './scrapers/backmarket/types.js';
import axios from 'axios';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createThrottle(delayMs: number): () => Promise<void> {
  let last = 0;
  let chain = Promise.resolve();
  return async () => {
    let release: () => void;
    const current = new Promise<void>(resolve => {
      release = resolve;
    });
    const prev = chain;
    chain = chain.then(() => current);
    await prev;

    const now = Date.now();
    const wait = Math.max(0, last + delayMs - now);
    if (wait > 0) {
      await sleep(wait);
    }
    last = Date.now();
    release!();
  };
}

function normalizeUrl(value: string, baseUrl: string): string {
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}

function parseArgs(): Partial<ScraperConfig> {
  const config: Partial<ScraperConfig> = {};
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === '--limit' && next) {
      config.limit = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === '--sitemap' && next) {
      config.sitemapUrl = next;
      i += 1;
    } else if (arg === '--no-download') {
      config.downloadImages = false;
    } else if (arg === '--concurrency' && next) {
      config.concurrency = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === '--delay' && next) {
      config.requestDelayMs = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === '--max-images' && next) {
      config.maxImagesPerProduct = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === '--browser') {
      config.useBrowser = true;
    } else if (arg === '--headful') {
      config.headless = false;
    } else if (arg === '--storage-state' && next) {
      config.storageStatePath = next;
      i += 1;
    }
  }
  return config;
}

function buildConfig(): ScraperConfig {
  const defaults: ScraperConfig = {
    sitemapUrl: process.env.BACKMARKET_SITEMAP_URL || 'https://www.backmarket.com/sitemap.xml',
    concurrency: Number.parseInt(process.env.BACKMARKET_CONCURRENCY || '4', 10),
    requestDelayMs: Number.parseInt(process.env.BACKMARKET_DELAY_MS || '700', 10),
    maxImagesPerProduct: Number.parseInt(process.env.BACKMARKET_MAX_IMAGES || '20', 10),
    downloadImages: process.env.BACKMARKET_DOWNLOAD_IMAGES !== 'false',
    imageDir: process.env.BACKMARKET_IMAGE_DIR || path.join(process.cwd(), 'data', 'backmarket_images'),
    dbPath: process.env.BACKMARKET_DB_PATH || path.join(process.cwd(), 'data', 'backmarket_products.db'),
    userAgent: process.env.BACKMARKET_USER_AGENT
      || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    useBrowser: process.env.BACKMARKET_USE_BROWSER === 'true',
    headless: process.env.BACKMARKET_HEADLESS !== 'false',
    storageStatePath: process.env.BACKMARKET_STORAGE_STATE || undefined,
    limit: undefined
  };

  const overrides = parseArgs();
  return { ...defaults, ...overrides };
}

async function fetchHtml(url: string, userAgent: string): Promise<string> {
  const response = await axios.get(url, {
    headers: { 'User-Agent': userAgent },
    timeout: 30000,
    responseType: 'text'
  });
  return response.data;
}

type HtmlFetcher = (url: string) => Promise<string>;

interface FetcherHandle {
  fetchHtml: HtmlFetcher;
  close: () => Promise<void>;
}

async function createBrowserFetcher(config: ScraperConfig): Promise<FetcherHandle> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: config.headless });
  const context = await browser.newContext({
    userAgent: config.userAgent,
    locale: 'en-US',
    timezoneId: 'America/New_York',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9'
    },
    storageState: config.storageStatePath
  });

  const fetcher: HtmlFetcher = async (url: string) => {
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => undefined);
      await page.waitForFunction(
        () => Boolean(document.querySelector('script#__NEXT_DATA__')),
        { timeout: 20000 }
      ).catch(() => undefined);
      return await page.content();
    } finally {
      await page.close();
    }
  };

  return {
    fetchHtml: fetcher,
    close: async () => {
      await context.close();
      await browser.close();
    }
  };
}

async function createHttpFetcher(config: ScraperConfig): Promise<FetcherHandle> {
  return {
    fetchHtml: async (url: string) => fetchHtml(url, config.userAgent),
    close: async () => undefined
  };
}

async function processUrl(
  url: string,
  config: ScraperConfig,
  db: BackMarketDb,
  throttle: () => Promise<void>,
  fetcher: HtmlFetcher
): Promise<void> {
  const normalizedUrl = normalizeBackMarketUrl(url);
  await throttle();
  let html: string;
  try {
    html = await fetcher(normalizedUrl);
  } catch (error: any) {
    console.warn(`Failed to fetch ${normalizedUrl}: ${error?.message || error}`);
    return;
  }

  const product = parseBackMarketProduct(html, normalizedUrl);
  if (!product) {
    console.warn(`No product data found for ${url}`);
    return;
  }

  const normalizedImages = product.imageUrls
    .map(imageUrl => normalizeUrl(imageUrl, url))
    .filter(Boolean);
  product.imageUrls = normalizedImages;

  db.upsertProduct(product);

  const images: ImageRecord[] = normalizedImages
    .slice(0, config.maxImagesPerProduct)
    .map((imageUrl, index) => ({
      productKey: product.productKey,
      url: imageUrl,
      position: index,
      isPrimary: index === 0
    }));

  if (config.downloadImages) {
    for (const image of images) {
      await throttle();
      const destPath = buildImagePath(config.imageDir, image.productKey, image.url, image.position);
      try {
        const info = await downloadImage(image.url, destPath, config.userAgent);
        image.localPath = destPath;
        image.contentType = info.contentType;
      } catch (error: any) {
        console.warn(`Failed to download ${image.url}: ${error?.message || error}`);
      }
    }
  }

  db.upsertImages(images);
  await db.flush();
  console.log(`Saved ${product.productKey} (${images.length} images)`);
}

async function run(): Promise<void> {
  const config = buildConfig();
  const db = await BackMarketDb.create(config.dbPath);
  const throttle = createThrottle(config.requestDelayMs);
  const fetcherHandle = config.useBrowser
    ? await createBrowserFetcher(config)
    : await createHttpFetcher(config);

  try {
    console.log('Loading Back Market sitemap...');
    const urls = await loadProductUrls(
      config.sitemapUrl,
      config.userAgent,
      isLikelyProductUrl,
      config.limit
    );
    const list = config.limit ? urls.slice(0, config.limit) : urls;
    console.log(`Discovered ${urls.length} product URLs. Processing ${list.length}...`);

    let index = 0;
    const workers = Array.from({ length: config.concurrency }, async () => {
      while (index < list.length) {
        const current = list[index];
        index += 1;
        await processUrl(current, config, db, throttle, fetcherHandle.fetchHtml);
      }
    });

    await Promise.all(workers);
    console.log('Scrape complete.');
  } finally {
    await fetcherHandle.close();
    await db.close();
  }
}

run().catch(error => {
  console.error('Back Market scraper failed:', error);
  process.exitCode = 1;
});
