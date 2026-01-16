import fs from 'fs/promises';
import initSqlJs from 'sql.js';
import type { BestBuyProduct, ImageRecord } from './types.js';

type SqlJsDatabase = ReturnType<typeof initSqlJs>['Database'];

export class BestBuyDb {
  private db: SqlJsDatabase;
  private dbPath: string;
  private pendingWrites = 0;

  private constructor(db: SqlJsDatabase, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
    this.ensureSchema();
  }

  static async create(dbPath: string): Promise<BestBuyDb> {
    const SQL = await initSqlJs();
    let db: SqlJsDatabase;

    try {
      const file = await fs.readFile(dbPath);
      db = new SQL.Database(new Uint8Array(file));
    } catch {
      db = new SQL.Database();
    }

    return new BestBuyDb(db, dbPath);
  }

  async close(): Promise<void> {
    await this.flush(true);
    this.db.close();
  }

  upsertProduct(product: BestBuyProduct): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO bestbuy_products (
        sku,
        name,
        brand,
        model,
        category,
        price,
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
        ?
      )
      ON CONFLICT(sku) DO UPDATE SET
        name = excluded.name,
        brand = excluded.brand,
        model = excluded.model,
        category = excluded.category,
        price = excluded.price,
        product_url = excluded.product_url,
        last_seen = excluded.last_seen,
        data_json = excluded.data_json
    `);

    stmt.run([
      product.sku,
      product.name,
      product.brand,
      product.model,
      product.category,
      product.price,
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
      INSERT INTO bestbuy_images (
        sku,
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
      ON CONFLICT(sku, url) DO UPDATE SET
        position = excluded.position,
        is_primary = excluded.is_primary,
        local_path = COALESCE(excluded.local_path, bestbuy_images.local_path),
        content_type = COALESCE(excluded.content_type, bestbuy_images.content_type),
        width = COALESCE(excluded.width, bestbuy_images.width),
        height = COALESCE(excluded.height, bestbuy_images.height),
        last_seen = excluded.last_seen
    `);

    for (const record of images) {
      stmt.run([
        record.sku,
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
      CREATE TABLE IF NOT EXISTS bestbuy_products (
        sku TEXT PRIMARY KEY,
        name TEXT,
        brand TEXT,
        model TEXT,
        category TEXT,
        price REAL,
        product_url TEXT NOT NULL,
        last_seen TEXT,
        data_json TEXT
      );

      CREATE TABLE IF NOT EXISTS bestbuy_images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sku TEXT NOT NULL,
        url TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        is_primary INTEGER NOT NULL DEFAULT 0,
        local_path TEXT,
        content_type TEXT,
        width INTEGER,
        height INTEGER,
        last_seen TEXT,
        UNIQUE(sku, url)
      );
    `);
  }
}
