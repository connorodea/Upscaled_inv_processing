import fs from 'fs/promises';
import initSqlJs from 'sql.js';
import type { BackMarketProduct, ImageRecord } from './types.js';

type SqlJsDatabase = ReturnType<typeof initSqlJs>['Database'];

export class BackMarketDb {
  private db: SqlJsDatabase;
  private dbPath: string;
  private pendingWrites = 0;

  private constructor(db: SqlJsDatabase, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
    this.ensureSchema();
  }

  static async create(dbPath: string): Promise<BackMarketDb> {
    const SQL = await initSqlJs();
    let db: SqlJsDatabase;

    try {
      const file = await fs.readFile(dbPath);
      db = new SQL.Database(new Uint8Array(file));
    } catch {
      db = new SQL.Database();
    }

    return new BackMarketDb(db, dbPath);
  }

  async close(): Promise<void> {
    await this.flush(true);
    this.db.close();
  }

  upsertProduct(product: BackMarketProduct): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO backmarket_products (
        product_key,
        product_id,
        name,
        brand,
        model,
        category,
        condition,
        price,
        currency,
        rating,
        review_count,
        product_url,
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
        ?
      )
      ON CONFLICT(product_key) DO UPDATE SET
        product_id = excluded.product_id,
        name = excluded.name,
        brand = excluded.brand,
        model = excluded.model,
        category = excluded.category,
        condition = excluded.condition,
        price = excluded.price,
        currency = excluded.currency,
        rating = excluded.rating,
        review_count = excluded.review_count,
        product_url = excluded.product_url,
        last_seen = excluded.last_seen,
        data_json = excluded.data_json
    `);

    stmt.run([
      product.productKey,
      product.productId,
      product.name,
      product.brand,
      product.model,
      product.category,
      product.condition,
      product.price,
      product.currency,
      product.rating,
      product.reviewCount,
      product.productUrl,
      now,
      JSON.stringify(product.rawJson ?? null)
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
      INSERT INTO backmarket_images (
        product_key,
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
      ON CONFLICT(product_key, url) DO UPDATE SET
        position = excluded.position,
        is_primary = excluded.is_primary,
        local_path = COALESCE(excluded.local_path, backmarket_images.local_path),
        content_type = COALESCE(excluded.content_type, backmarket_images.content_type),
        width = COALESCE(excluded.width, backmarket_images.width),
        height = COALESCE(excluded.height, backmarket_images.height),
        last_seen = excluded.last_seen
    `);

    for (const record of images) {
      stmt.run([
        record.productKey,
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
      CREATE TABLE IF NOT EXISTS backmarket_products (
        product_key TEXT PRIMARY KEY,
        product_id TEXT,
        name TEXT,
        brand TEXT,
        model TEXT,
        category TEXT,
        condition TEXT,
        price REAL,
        currency TEXT,
        rating REAL,
        review_count INTEGER,
        product_url TEXT NOT NULL,
        last_seen TEXT,
        data_json TEXT
      );

      CREATE TABLE IF NOT EXISTS backmarket_images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_key TEXT NOT NULL,
        url TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        is_primary INTEGER NOT NULL DEFAULT 0,
        local_path TEXT,
        content_type TEXT,
        width INTEGER,
        height INTEGER,
        last_seen TEXT,
        UNIQUE(product_key, url)
      );
    `);
  }
}
