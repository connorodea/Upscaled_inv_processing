export interface EbayStoreItem {
  itemId: string;
  title: string | null;
  descriptionHtml: string | null;
  descriptionText: string | null;
  condition: string | null;
  price: number | null;
  currency: string | null;
  categoryPath: string | null;
  sellerName: string | null;
  storeName: string | null;
  brand: string | null;
  mpn: string | null;
  model: string | null;
  upc: string | null;
  listingUrl: string;
  imageUrls: string[];
  itemSpecifics: Record<string, string>;
  rawJson: unknown;
}

export interface ImageRecord {
  itemId: string;
  url: string;
  position: number;
  isPrimary: boolean;
  localPath?: string;
  contentType?: string;
  width?: number;
  height?: number;
}

export interface ScraperConfig {
  storeUrl: string;
  concurrency: number;
  requestDelayMs: number;
  requestTimeoutMs: number;
  maxImagesPerProduct: number;
  downloadImages: boolean;
  imageDir: string;
  dbPath: string;
  jsonPath: string;
  appendJson: boolean;
  userAgent: string;
  itemsPerPage: number;
  maxPages?: number;
  fetchDescription: boolean;
  verbose: boolean;
  progressEvery: number;
  limit?: number;
}
