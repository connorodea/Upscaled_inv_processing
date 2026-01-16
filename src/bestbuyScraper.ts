import path from 'path';
import { chromium, Browser, Page } from 'playwright';
import { BestBuyDb } from './scrapers/bestbuy/db.js';
import { loadProductUrls, isLikelyProductUrl, normalizeBestBuyUrl } from './scrapers/bestbuy/sitemap.js';
import { parseBestBuyProduct } from './scrapers/bestbuy/parser.js';
import { buildImagePath, downloadImage } from './scrapers/bestbuy/downloader.js';
import type { ImageRecord, ScraperConfig } from './scrapers/bestbuy/types.js';

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
    } else if (arg === '--scroll-steps' && next) {
      config.scrollSteps = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === '--scroll-delay' && next) {
      config.scrollDelayMs = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === '--wait-after-load' && next) {
      config.waitAfterLoadMs = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === '--verbose') {
      config.verbose = true;
    } else if (arg === '--progress-every' && next) {
      config.progressEvery = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === '--sitemap-timeout' && next) {
      config.sitemapTimeoutMs = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === '--sitemap-retries' && next) {
      config.sitemapRetries = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === '--sitemap-retry-delay' && next) {
      config.sitemapRetryDelayMs = Number.parseInt(next, 10);
      i += 1;
    }
  }
  return config;
}

function buildConfig(): ScraperConfig {
  const defaults: ScraperConfig = {
    sitemapUrl: process.env.BESTBUY_SITEMAP_URL || 'https://www.bestbuy.com/sitemap.xml',
    concurrency: Number.parseInt(process.env.BESTBUY_CONCURRENCY || '6', 10),
    requestDelayMs: Number.parseInt(process.env.BESTBUY_DELAY_MS || '400', 10),
    maxImagesPerProduct: Number.parseInt(process.env.BESTBUY_MAX_IMAGES || '12', 10),
    downloadImages: process.env.BESTBUY_DOWNLOAD_IMAGES !== 'false',
    imageDir: process.env.BESTBUY_IMAGE_DIR || path.join(process.cwd(), 'data', 'bestbuy_images'),
    dbPath: process.env.BESTBUY_DB_PATH || path.join(process.cwd(), 'data', 'bestbuy_products.db'),
    userAgent: process.env.BESTBUY_USER_AGENT || 'UpscaledBestBuyScraper/1.0',
    scrollSteps: Number.parseInt(process.env.BESTBUY_SCROLL_STEPS || '2', 10),
    scrollDelayMs: Number.parseInt(process.env.BESTBUY_SCROLL_DELAY_MS || '700', 10),
    waitAfterLoadMs: Number.parseInt(process.env.BESTBUY_WAIT_AFTER_LOAD_MS || '1500', 10),
    verbose: process.env.BESTBUY_VERBOSE === 'true',
    progressEvery: Number.parseInt(process.env.BESTBUY_PROGRESS_EVERY || '10', 10),
    sitemapTimeoutMs: Number.parseInt(process.env.BESTBUY_SITEMAP_TIMEOUT_MS || '120000', 10),
    sitemapRetries: Number.parseInt(process.env.BESTBUY_SITEMAP_RETRIES || '2', 10),
    sitemapRetryDelayMs: Number.parseInt(process.env.BESTBUY_SITEMAP_RETRY_DELAY_MS || '5000', 10),
    limit: undefined
  };

  const overrides = parseArgs();
  return { ...defaults, ...overrides };
}

async function processUrl(
  url: string,
  config: ScraperConfig,
  db: BestBuyDb,
  throttle: () => Promise<void>,
  page: Page
): Promise<{ ok: boolean }> {
  const normalizedUrl = normalizeBestBuyUrl(url);
  await throttle();
  let html: string;
  try {
    await page.goto(normalizedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (config.waitAfterLoadMs > 0) {
      await page.waitForTimeout(config.waitAfterLoadMs);
    }
    for (let i = 0; i < config.scrollSteps; i += 1) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      if (config.scrollDelayMs > 0) {
        await page.waitForTimeout(config.scrollDelayMs);
      }
    }
    html = await page.content();
  } catch (error: any) {
    console.warn(`Failed to fetch ${normalizedUrl}: ${error?.message || error}`);
    return { ok: false };
  }

  const product = parseBestBuyProduct(html, normalizedUrl);
  if (!product) {
    console.warn(`No product data found for ${url}`);
    return { ok: false };
  }

  const normalizedImages = product.imageUrls
    .map(imageUrl => normalizeUrl(imageUrl, url))
    .filter(Boolean);
  product.imageUrls = normalizedImages;

  db.upsertProduct(product);

  const images: ImageRecord[] = normalizedImages
    .slice(0, config.maxImagesPerProduct)
    .map((imageUrl, index) => ({
      sku: product.sku,
      url: imageUrl,
      position: index,
      isPrimary: index === 0
    }));

  if (config.downloadImages) {
    for (const image of images) {
      await throttle();
      const destPath = buildImagePath(config.imageDir, image.sku, image.url, image.position);
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
  if (config.verbose) {
    console.log(`Saved ${product.sku} (${images.length} images)`);
  }
  return { ok: true };
}

async function run(): Promise<void> {
  const config = buildConfig();
  const db = await BestBuyDb.create(config.dbPath);
  const throttle = createThrottle(config.requestDelayMs);
  let browser: Browser | null = null;

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: config.userAgent
    });

    console.log('Loading Best Buy sitemap...');
    const urls = await loadProductUrls(
      config.sitemapUrl,
      config.userAgent,
      isLikelyProductUrl,
      config.limit,
      config.sitemapTimeoutMs,
      config.sitemapRetries,
      config.sitemapRetryDelayMs
    );
    const list = config.limit ? urls.slice(0, config.limit) : urls;
    console.log(`Discovered ${urls.length} product URLs. Processing ${list.length}...`);

    let index = 0;
    let processed = 0;
    let succeeded = 0;
    let failed = 0;
    const total = list.length;
    const useProgressBar = process.stdout.isTTY && !config.verbose;

    const renderProgress = () => {
      const width = 30;
      const ratio = total === 0 ? 0 : processed / total;
      const filled = Math.round(ratio * width);
      const bar = `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
      const line = `Progress ${processed}/${total} [${bar}] ok ${succeeded} fail ${failed}`;
      process.stdout.write(`\r${line}`);
    };
    const workers = Array.from({ length: config.concurrency }, async () => {
      const page = await context.newPage();
      while (index < list.length) {
        const current = list[index];
        index += 1;
        const result = await processUrl(current, config, db, throttle, page);
        processed += 1;
        if (result.ok) {
          succeeded += 1;
        } else {
          failed += 1;
        }
        if (useProgressBar && processed % config.progressEvery === 0) {
          renderProgress();
        } else if (!useProgressBar && config.progressEvery > 0 && processed % config.progressEvery === 0) {
          console.log(`Progress: ${processed}/${list.length} (ok ${succeeded}, fail ${failed})`);
        }
      }
      await page.close();
    });

    await Promise.all(workers);
    if (useProgressBar) {
      renderProgress();
      process.stdout.write('\n');
    }
    console.log(`Done: ${processed}/${list.length} (ok ${succeeded}, fail ${failed})`);
    console.log('Scrape complete.');
  } finally {
    if (browser) {
      await browser.close();
    }
    await db.close();
  }
}

run().catch(error => {
  console.error('Best Buy scraper failed:', error);
  process.exitCode = 1;
});
