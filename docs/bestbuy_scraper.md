# Best Buy Image Scraper

This crawler uses BestBuy's public sitemap to discover product pages, scrapes product metadata + image URLs, downloads images locally, and stores everything in a SQLite database.

## Run

```bash
npm run bestbuy:scrape
```

### CLI flags

- `--limit 1000` limit the number of product pages processed
- `--sitemap https://www.bestbuy.com/sitemap.xml` override sitemap URL
- `--concurrency 6` number of concurrent workers
- `--delay 400` minimum delay (ms) between requests
- `--max-images 12` max images per product
- `--scroll-steps 2` number of scroll steps to trigger lazy loading
- `--scroll-delay 700` delay (ms) between scroll steps
- `--wait-after-load 1500` delay (ms) after initial load
- `--verbose` log each saved product
- `--progress-every 10` update progress every N products
- `--sitemap-timeout 120000` sitemap request timeout (ms)
- `--sitemap-retries 2` retry sitemap downloads
- `--sitemap-retry-delay 5000` delay (ms) between sitemap retries
- `--no-download` skip image downloads (store URLs only)

### Environment variables

- `BESTBUY_SITEMAP_URL`
- `BESTBUY_CONCURRENCY`
- `BESTBUY_DELAY_MS`
- `BESTBUY_MAX_IMAGES`
- `BESTBUY_SCROLL_STEPS`
- `BESTBUY_SCROLL_DELAY_MS`
- `BESTBUY_WAIT_AFTER_LOAD_MS`
- `BESTBUY_VERBOSE`
- `BESTBUY_PROGRESS_EVERY`
- `BESTBUY_SITEMAP_TIMEOUT_MS`
- `BESTBUY_SITEMAP_RETRIES`
- `BESTBUY_SITEMAP_RETRY_DELAY_MS`
- `BESTBUY_DOWNLOAD_IMAGES` (set to `false` to skip downloads)
- `BESTBUY_IMAGE_DIR` (default: `data/bestbuy_images`)
- `BESTBUY_DB_PATH` (default: `data/bestbuy_products.db`)
- `BESTBUY_USER_AGENT`

## Data storage

- SQLite DB (sql.js): `data/bestbuy_products.db`
  - `bestbuy_products` stores metadata + raw JSON-LD
  - `bestbuy_images` stores image URLs + local paths
- Images: `data/bestbuy_images/{sku}/`

## Notes

- The scraper relies on public product sitemaps and JSON-LD data embedded in product pages.
- Use conservative concurrency/delay values to avoid stressing the site.
