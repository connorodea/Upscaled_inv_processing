import fs from 'fs/promises';
import initSqlJs from 'sql.js';
import type { EbayStoreItem, ImageRecord } from './types.js';

type SqlJsDatabase = ReturnType<typeof initSqlJs>['Database'];

export class EbayBestBuyDb {
  private db: SqlJsDatabase;
  private dbPath: string;
  private pendingWrites = 0;

  private constructor(db: SqlJsDatabase, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
    this.ensureSchema();
  }

  static async create(dbPath: string): Promise<EbayBestBuyDb> {
    const SQL = await initSqlJs();
    let db: SqlJsDatabase;

    try {
      const file = await fs.readFile(dbPath);
      db = new SQL.Database(new Uint8Array(file));
    } catch {
      db = new SQL.Database();
    }

    return new EbayBestBuyDb(db, dbPath);
  }

  async close(): Promise<void> {
    await this.flush(true);
    this.db.close();
  }

  upsertItem(item: EbayStoreItem): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO ebay_bestbuy_items (
        item_id,
        title,
        description_html,
        description_text,
        condition,
        price,
        currency,
        category_path,
        seller_name,
        store_name,
        brand,
        mpn,
        model,
        upc,
        listing_url,
        item_specifics_json,
        last_seen,
        data_json
      ) VALUES (
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?
      )
      ON CONFLICT(item_id) DO UPDATE SET
        title = excluded.title,
        description_html = excluded.description_html,
        description_text = excluded.description_text,
        condition = excluded.condition,
        price = excluded.price,
        currency = excluded.currency,
        category_path = excluded.category_path,
        seller_name = excluded.seller_name,
        store_name = excluded.store_name,
        brand = excluded.brand,
        mpn = excluded.mpn,
        model = excluded.model,
        upc = excluded.upc,
        listing_url = excluded.listing_url,
        item_specifics_json = excluded.item_specifics_json,
        last_seen = excluded.last_seen,
        data_json = excluded.data_json
    `);

    stmt.run([
      item.itemId,
      item.title,
      item.descriptionHtml,
      item.descriptionText,
      item.condition,
      item.price,
      item.currency,
      item.categoryPath,
      item.sellerName,
      item.storeName,
      item.brand,
      item.mpn,
      item.model,
      item.upc,
      item.listingUrl,
      JSON.stringify(item.itemSpecifics ?? {}),
      now,
      JSON.stringify(item.rawJson ?? null)
    ]);
    stmt.free();
    this.pendingWrites += 1;
  }

  upsertImages(images: ImageRecord[]): void {
    if (images.length === 0) {
      return;
    }

    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO ebay_bestbuy_images (
        item_id,
        url,
        position,
        is_primary,
        local_path,
        content_type,
        width,
        height,
        last_seen
      ) VALUES (
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?
      )
      ON CONFLICT(item_id, url) DO UPDATE SET
        position = excluded.position,
        is_primary = excluded.is_primary,
        local_path = COALESCE(excluded.local_path, ebay_bestbuy_images.local_path),
        content_type = COALESCE(excluded.content_type, ebay_bestbuy_images.content_type),
        width = COALESCE(excluded.width, ebay_bestbuy_images.width),
        height = COALESCE(excluded.height, ebay_bestbuy_images.height),
        last_seen = excluded.last_seen
    `);

    for (const record of images) {
      stmt.run([
        record.itemId,
        record.url,
        record.position,
        record.isPrimary ? 1 : 0,
        record.localPath ?? null,
        record.contentType ?? null,
        record.width ?? null,
        record.height ?? null,
        now
      ]);
    }

    stmt.free();
    this.pendingWrites += images.length;
  }

  async flush(force = false): Promise<void> {
    if (!force && this.pendingWrites < 50) {
      return;
    }

    const data = this.db.export();
    await fs.writeFile(this.dbPath, Buffer.from(data));
    this.pendingWrites = 0;
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ebay_bestbuy_items (
        item_id TEXT PRIMARY KEY,
        title TEXT,
        description_html TEXT,
        description_text TEXT,
        condition TEXT,
        price REAL,
        currency TEXT,
        category_path TEXT,
        seller_name TEXT,
        store_name TEXT,
        brand TEXT,
        mpn TEXT,
        model TEXT,
        upc TEXT,
        listing_url TEXT NOT NULL,
        item_specifics_json TEXT,
        last_seen TEXT,
        data_json TEXT
      );

      CREATE TABLE IF NOT EXISTS ebay_bestbuy_images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id TEXT NOT NULL,
        url TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        is_primary INTEGER NOT NULL DEFAULT 0,
        local_path TEXT,
        content_type TEXT,
        width INTEGER,
        height INTEGER,
        last_seen TEXT,
        UNIQUE(item_id, url)
      );
    `);
  }
}
