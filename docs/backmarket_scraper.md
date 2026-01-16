# Back Market Product Scraper

This crawler uses Back Market's public sitemaps to discover product pages, scrapes product metadata + image URLs, downloads images locally, and stores everything in a SQLite database.

## Run

```bash
npm run backmarket:scrape
```

### CLI flags

- `--limit 1000` limit the number of product pages processed
- `--sitemap https://www.backmarket.com/sitemap.xml` override sitemap URL
- `--concurrency 4` number of concurrent workers
- `--delay 700` minimum delay (ms) between requests
- `--max-images 20` max images per product
- `--no-download` skip image downloads (store URLs only)
- `--browser` use Playwright to render pages and execute JS
- `--headful` run Playwright in a visible browser window
- `--storage-state path.json` reuse Playwright storage state (cookies/session)

### Environment variables

- `BACKMARKET_SITEMAP_URL`
- `BACKMARKET_CONCURRENCY`
- `BACKMARKET_DELAY_MS`
- `BACKMARKET_MAX_IMAGES`
- `BACKMARKET_DOWNLOAD_IMAGES` (set to `false` to skip downloads)
- `BACKMARKET_IMAGE_DIR` (default: `data/backmarket_images`)
- `BACKMARKET_DB_PATH` (default: `data/backmarket_products.db`)
- `BACKMARKET_USER_AGENT`
- `BACKMARKET_USE_BROWSER` (set to `true` to enable Playwright rendering)
- `BACKMARKET_HEADLESS` (set to `false` for headful mode)
- `BACKMARKET_STORAGE_STATE` (path to Playwright storage state JSON)

## Data storage

- SQLite DB (sql.js): `data/backmarket_products.db`
  - `backmarket_products` stores metadata + raw JSON-LD/Next data
  - `backmarket_images` stores image URLs + local paths
- Images: `data/backmarket_images/{productKey}/`

## Notes

- The scraper relies on public sitemaps and JSON-LD data embedded in product pages.
- The full raw product payload is saved in `data_json` for "all product info".
- Use conservative concurrency/delay values to avoid stressing the site.
- If you hit a "Just a moment..." page, run with `--headful` and save storage state once, then reuse it:
  - `npx playwright codegen --save-storage data/backmarket_storage.json https://www.backmarket.com/en-us/`
  - `npm run backmarket:scrape -- --browser --storage-state data/backmarket_storage.json`
