export interface BestBuyProduct {
  sku: string;
  name: string | null;
  brand: string | null;
  model: string | null;
  category: string | null;
  price: number | null;
  productUrl: string;
  imageUrls: string[];
  rawJson: unknown;
}

export interface ImageRecord {
  sku: string;
  url: string;
  position: number;
  isPrimary: boolean;
  localPath?: string;
  contentType?: string;
  width?: number;
  height?: number;
}

export interface ScraperConfig {
  sitemapUrl: string;
  concurrency: number;
  requestDelayMs: number;
  maxImagesPerProduct: number;
  downloadImages: boolean;
  imageDir: string;
  dbPath: string;
  userAgent: string;
  scrollSteps: number;
  scrollDelayMs: number;
  waitAfterLoadMs: number;
  verbose: boolean;
  progressEvery: number;
  sitemapTimeoutMs: number;
  sitemapRetries: number;
  sitemapRetryDelayMs: number;
  limit?: number;
}
