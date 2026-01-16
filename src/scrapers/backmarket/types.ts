export interface BackMarketProduct {
  productKey: string;
  productId: string | null;
  name: string | null;
  brand: string | null;
  model: string | null;
  category: string | null;
  condition: string | null;
  price: number | null;
  currency: string | null;
  rating: number | null;
  reviewCount: number | null;
  productUrl: string;
  imageUrls: string[];
  rawJson: unknown;
}

export interface ImageRecord {
  productKey: string;
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
  useBrowser: boolean;
  headless: boolean;
  storageStatePath?: string;
  limit?: number;
}
