# eBay Best Buy Store Scraper

This crawler loads the Official Best Buy eBay store pages to discover listings, scrapes listing metadata + description HTML + image URLs, downloads images locally, and stores everything in a SQLite database and JSONL file.

## Run

```bash
npm run ebay-bestbuy:scrape
```

### CLI flags

- `--limit 1000` limit the number of listings processed
- `--pages 5` limit the number of store pages scanned
- `--store https://www.ebay.com/str/officialbestbuy` override store URL
- `--concurrency 2` number of concurrent listing workers
- `--delay 1200` minimum delay (ms) between requests
- `--max-images 12` max images per listing
- `--items-per-page 240` store page size
- `--no-download` skip image downloads (store URLs only)
- `--no-description` skip fetching the description iframe
- `--json path.jsonl` override JSONL output path
- `--db path.db` override DB path
- `--append-json` append to JSONL instead of truncating
- `--timeout 30000` request timeout (ms)
- `--verbose` print per-item logs
- `--progress-every 20` progress log interval

### Environment variables

- `EBAY_BESTBUY_STORE_URL`
- `EBAY_BESTBUY_CONCURRENCY`
- `EBAY_BESTBUY_DELAY_MS`
- `EBAY_BESTBUY_TIMEOUT_MS`
- `EBAY_BESTBUY_MAX_IMAGES`
- `EBAY_BESTBUY_DOWNLOAD_IMAGES` (set to `false` to skip downloads)
- `EBAY_BESTBUY_IMAGE_DIR` (default: `data/ebay_bestbuy_images`)
- `EBAY_BESTBUY_DB_PATH` (default: `data/ebay_bestbuy_products.db`)
- `EBAY_BESTBUY_JSON_PATH` (default: `data/ebay_bestbuy_products.jsonl`)
- `EBAY_BESTBUY_APPEND_JSON` (set to `true` to append to JSONL)
- `EBAY_BESTBUY_ITEMS_PER_PAGE`
- `EBAY_BESTBUY_MAX_PAGES`
- `EBAY_BESTBUY_FETCH_DESCRIPTION` (set to `false` to skip description iframe)
- `EBAY_BESTBUY_USER_AGENT`
- `EBAY_BESTBUY_VERBOSE`
- `EBAY_BESTBUY_PROGRESS_EVERY`

## Data storage

- SQLite DB (sql.js): `data/ebay_bestbuy_products.db`
  - `ebay_bestbuy_items` stores metadata + description + item specifics + raw JSON-LD
  - `ebay_bestbuy_images` stores image URLs + local paths
- JSONL: `data/ebay_bestbuy_products.jsonl`
- Images: `data/ebay_bestbuy_images/{itemId}/`

## Notes

- The scraper only uses public eBay listing pages (no login).
- Defaults are intentionally conservative (2 workers + 1.2s delay).
- Listing descriptions are loaded from the `desc_ifr` iframe when available.
- JSONL output is line-delimited JSON for easy streaming.
