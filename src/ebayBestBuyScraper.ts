import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';
import { EbayBestBuyDb } from './scrapers/ebayBestBuy/db.js';
import { extractDescriptionUrl, parseEbayItem } from './scrapers/ebayBestBuy/parser.js';
import { buildStorePageUrl, extractItemUrls, normalizeEbayItemUrl } from './scrapers/ebayBestBuy/store.js';
import { buildImagePath, downloadImage } from './scrapers/bestbuy/downloader.js';
import type { ImageRecord, ScraperConfig } from './scrapers/ebayBestBuy/types.js';

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
    } else if (arg === '--pages' && next) {
      config.maxPages = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === '--store' && next) {
      config.storeUrl = next;
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
    } else if (arg === '--items-per-page' && next) {
      config.itemsPerPage = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === '--json' && next) {
      config.jsonPath = next;
      i += 1;
    } else if (arg === '--db' && next) {
      config.dbPath = next;
      i += 1;
    } else if (arg === '--append-json') {
      config.appendJson = true;
    } else if (arg === '--no-description') {
      config.fetchDescription = false;
    } else if (arg === '--timeout' && next) {
      config.requestTimeoutMs = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === '--verbose') {
      config.verbose = true;
    } else if (arg === '--progress-every' && next) {
      config.progressEvery = Number.parseInt(next, 10);
      i += 1;
    }
  }
  return config;
}

function buildConfig(): ScraperConfig {
  const defaults: ScraperConfig = {
    storeUrl: process.env.EBAY_BESTBUY_STORE_URL || 'https://www.ebay.com/str/officialbestbuy',
    concurrency: Number.parseInt(process.env.EBAY_BESTBUY_CONCURRENCY || '2', 10),
    requestDelayMs: Number.parseInt(process.env.EBAY_BESTBUY_DELAY_MS || '1200', 10),
    requestTimeoutMs: Number.parseInt(process.env.EBAY_BESTBUY_TIMEOUT_MS || '30000', 10),
    maxImagesPerProduct: Number.parseInt(process.env.EBAY_BESTBUY_MAX_IMAGES || '12', 10),
    downloadImages: process.env.EBAY_BESTBUY_DOWNLOAD_IMAGES !== 'false',
    imageDir: process.env.EBAY_BESTBUY_IMAGE_DIR || path.join(process.cwd(), 'data', 'ebay_bestbuy_images'),
    dbPath: process.env.EBAY_BESTBUY_DB_PATH || path.join(process.cwd(), 'data', 'ebay_bestbuy_products.db'),
    jsonPath: process.env.EBAY_BESTBUY_JSON_PATH || path.join(process.cwd(), 'data', 'ebay_bestbuy_products.jsonl'),
    appendJson: process.env.EBAY_BESTBUY_APPEND_JSON === 'true',
    userAgent: process.env.EBAY_BESTBUY_USER_AGENT
      || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    itemsPerPage: Number.parseInt(process.env.EBAY_BESTBUY_ITEMS_PER_PAGE || '240', 10),
    maxPages: process.env.EBAY_BESTBUY_MAX_PAGES
      ? Number.parseInt(process.env.EBAY_BESTBUY_MAX_PAGES, 10)
      : undefined,
    fetchDescription: process.env.EBAY_BESTBUY_FETCH_DESCRIPTION !== 'false',
    verbose: process.env.EBAY_BESTBUY_VERBOSE === 'true',
    progressEvery: Number.parseInt(process.env.EBAY_BESTBUY_PROGRESS_EVERY || '20', 10),
    limit: undefined
  };

  const overrides = parseArgs();
  return { ...defaults, ...overrides };
}

async function fetchHtml(url: string, config: ScraperConfig): Promise<string> {
  const response = await axios.get(url, {
    headers: {
      'User-Agent': config.userAgent,
      'Accept-Language': 'en-US,en;q=0.9',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    },
    timeout: config.requestTimeoutMs,
    responseType: 'text'
  });
  return response.data;
}

async function loadStoreItemUrls(
  config: ScraperConfig,
  throttle: () => Promise<void>
): Promise<string[]> {
  const urls = new Set<string>();
  let page = 1;
  let emptyPages = 0;

  while (true) {
    if (config.maxPages && page > config.maxPages) {
      break;
    }

    const pageUrl = buildStorePageUrl(config.storeUrl, page, config.itemsPerPage);
    await throttle();
    let html: string;
    try {
      html = await fetchHtml(pageUrl, config);
    } catch (error: any) {
      console.warn(`Failed to fetch store page ${page}: ${error?.message || error}`);
      break;
    }

    const pageUrls = extractItemUrls(html);
    const before = urls.size;
    pageUrls.forEach(url => urls.add(url));
    const added = urls.size - before;

    if (config.verbose) {
      console.log(`Page ${page}: found ${pageUrls.length} items (${added} new).`);
    }

    if (config.limit && urls.size >= config.limit) {
      break;
    }

    if (pageUrls.length === 0 || added === 0) {
      emptyPages += 1;
    } else {
      emptyPages = 0;
    }

    if (emptyPages >= 2) {
      break;
    }

    page += 1;
  }

  const list = [...urls];
  return config.limit ? list.slice(0, config.limit) : list;
}

class JsonlWriter {
  private buffer: string[] = [];
  private readonly flushSize = 25;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async init(append: boolean): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    if (!append) {
      await fs.writeFile(this.filePath, '');
    }
  }

  async add(record: unknown): Promise<void> {
    this.chain = this.chain.then(async () => {
      this.buffer.push(JSON.stringify(record));
      if (this.buffer.length >= this.flushSize) {
        await this.flushInternal();
      }
    });
    await this.chain;
  }

  async flush(): Promise<void> {
    this.chain = this.chain.then(async () => this.flushInternal());
    await this.chain;
  }

  async close(): Promise<void> {
    await this.flush();
  }

  private async flushInternal(): Promise<void> {
    if (this.buffer.length === 0) {
      return;
    }
    const payload = `${this.buffer.join('\n')}\n`;
    this.buffer = [];
    await fs.appendFile(this.filePath, payload);
  }
}

async function processUrl(
  url: string,
  config: ScraperConfig,
  db: EbayBestBuyDb,
  jsonWriter: JsonlWriter,
  throttle: () => Promise<void>
): Promise<{ ok: boolean }> {
  const normalizedUrl = normalizeEbayItemUrl(url) ?? url;
  await throttle();
  let html: string;
  try {
    html = await fetchHtml(normalizedUrl, config);
  } catch (error: any) {
    console.warn(`Failed to fetch ${normalizedUrl}: ${error?.message || error}`);
    return { ok: false };
  }

  let descriptionHtml: string | null = null;
  if (config.fetchDescription) {
    const descriptionUrl = extractDescriptionUrl(html, normalizedUrl);
    if (descriptionUrl) {
      await throttle();
      try {
        descriptionHtml = await fetchHtml(descriptionUrl, config);
      } catch (error: any) {
        console.warn(`Failed to fetch description for ${normalizedUrl}: ${error?.message || error}`);
      }
    }
  }

  const item = parseEbayItem(html, normalizedUrl, descriptionHtml);
  if (!item) {
    console.warn(`No item data found for ${normalizedUrl}`);
    return { ok: false };
  }

  const normalizedImages = item.imageUrls
    .map(imageUrl => normalizeUrl(imageUrl, normalizedUrl))
    .filter(Boolean);
  item.imageUrls = normalizedImages;

  db.upsertItem(item);

  const images: ImageRecord[] = normalizedImages
    .slice(0, config.maxImagesPerProduct)
    .map((imageUrl, index) => ({
      itemId: item.itemId,
      url: imageUrl,
      position: index,
      isPrimary: index === 0
    }));

  if (config.downloadImages) {
    for (const image of images) {
      await throttle();
      const destPath = buildImagePath(config.imageDir, image.itemId, image.url, image.position);
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
  await jsonWriter.add(item);
  if (config.verbose) {
    console.log(`Saved ${item.itemId} (${images.length} images)`);
  }
  return { ok: true };
}

async function run(): Promise<void> {
  const config = buildConfig();
  const db = await EbayBestBuyDb.create(config.dbPath);
  const jsonWriter = new JsonlWriter(config.jsonPath);
  const throttle = createThrottle(config.requestDelayMs);

  try {
    await jsonWriter.init(config.appendJson);

    console.log('Loading eBay store pages...');
    const urls = await loadStoreItemUrls(config, throttle);
    console.log(`Discovered ${urls.length} item URLs. Processing ${urls.length}...`);

    let index = 0;
    let processed = 0;
    let succeeded = 0;
    let failed = 0;
    const total = urls.length;
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
      while (index < urls.length) {
        const current = urls[index];
        index += 1;
        const result = await processUrl(current, config, db, jsonWriter, throttle);
        processed += 1;
        if (result.ok) {
          succeeded += 1;
        } else {
          failed += 1;
        }
        if (useProgressBar && processed % config.progressEvery === 0) {
          renderProgress();
        } else if (!useProgressBar && config.progressEvery > 0 && processed % config.progressEvery === 0) {
          console.log(`Progress: ${processed}/${total} (ok ${succeeded}, fail ${failed})`);
        }
      }
    });

    await Promise.all(workers);
    if (useProgressBar) {
      renderProgress();
      process.stdout.write('\n');
    }
    console.log(`Done: ${processed}/${total} (ok ${succeeded}, fail ${failed})`);
    console.log('Scrape complete.');
  } finally {
    await jsonWriter.close();
    await db.close();
  }
}

run().catch(error => {
  console.error('eBay Best Buy scraper failed:', error);
  process.exitCode = 1;
});
