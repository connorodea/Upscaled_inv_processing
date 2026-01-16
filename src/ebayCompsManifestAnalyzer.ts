import fs from 'fs/promises';
import path from 'path';
import inquirer from 'inquirer';
import chalk from 'chalk';
import Table from 'cli-table3';
import boxen from 'boxen';

type ManifestColumnMap = {
  title_or_description: string;
  brand: string;
  model_or_sku: string;
  upc_ean: string;
  msrp: string;
  quantity: string;
  condition_hint?: string;
  category_hint?: string;
};

type ManifestItem = {
  title: string;
  brand: string;
  model: string;
  upc: string;
  msrp: number;
  quantity: number;
  conditionHint?: string;
  categoryHint?: string;
};

type Assumptions = {
  assume_condition: 'open_box' | 'used' | 'for_parts';
  condition_price_multiplier: number;
  sell_through_rate_default: number;
  damage_rate_default: number;
  ebay_fee_rate: number;
  returns_allowance_rate: number;
  outbound_shipping_per_sold_unit: number;
  labor_mode: 'hourly' | 'profit_share' | 'none';
  labor_hourly_rate: number;
  labor_minutes_per_sold_unit: number;
  profit_share_rate: number;
  inbound_shipping_multiplier_on_hammer: number;
  roi_floor_multiple: number;
};

type BidBand = { label: string; pct: number };

type BidContext = {
  msrp_total_override?: number;
  current_hammer_bid?: number;
  target_hammer_bid_pct_bands: BidBand[];
};

type CompSnapshot = {
  soldCount: number;
  prices: number[];
  medianPrice: number;
  medianPriceInclShip: number;
};

type CompResult = {
  matchType: 'upc' | 'model' | 'title';
  query: string;
  soldCount30: number;
  soldCount90: number;
  medianSoldPrice: number;
  medianSoldPriceInclShip: number;
  confidenceScore: number;
  tier: 'A' | 'B' | 'C' | 'D';
  sellableRate: number;
  priceStability: number;
};

type PerSkuResult = {
  item: ManifestItem;
  comps: CompResult;
  estimatedSalePrice: number;
  estimatedGross: number;
  estimatedFees: number;
  estimatedReturnsReserve: number;
  estimatedOutboundShipping: number;
  estimatedLabor: number;
  estimatedNetContribution: number;
};

type CacheEntry = {
  timestamp: number;
  data: CompSnapshot;
};

type CacheFile = Record<string, CacheEntry>;

type EbayToken = {
  accessToken: string;
  expiresAt: number;
};

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_FILE = path.join(process.cwd(), 'data', 'ebay-comps-cache.json');

const COLUMN_SYNONYMS: Record<keyof ManifestColumnMap, string[]> = {
  title_or_description: ['title', 'item', 'description', 'product name', 'product', 'name'],
  brand: ['brand', 'manufacturer', 'make'],
  model_or_sku: ['model', 'sku', 'mpn', 'part number', 'model number'],
  upc_ean: ['upc', 'ean', 'gtin'],
  msrp: ['msrp', 'retail', 'orig retail', 'original retail', 'list price'],
  quantity: ['qty', 'quantity', 'units', 'unit', 'count'],
  condition_hint: ['condition', 'notes'],
  category_hint: ['category', 'department']
};

const TIERS = [
  { tier: 'A' as const, soldCount90Min: 20, sellableRate: 0.85 },
  { tier: 'B' as const, soldCount90Min: 5, sellableRate: 0.7 },
  { tier: 'C' as const, soldCount90Min: 1, sellableRate: 0.5 },
  { tier: 'D' as const, soldCount90Min: 0, sellableRate: 0.25 }
];

const DEFAULT_BANDS: BidBand[] = [
  { label: 'Home Run', pct: 0.03 },
  { label: 'Strong/Scalable', pct: 0.04 },
  { label: 'Acceptable/Faster Turns', pct: 0.05 },
  { label: 'Thin/Edge', pct: 0.06 }
];

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[_\-.]+/g, ' ');
}

function parseCurrency(raw: string): number {
  if (!raw) return 0;
  const cleaned = raw.replace(/[^0-9.\-]/g, '');
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : 0;
}

function parseInteger(raw: string): number {
  const value = Number.parseInt(raw.replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(value) ? value : 0;
}

function coerceNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : fallback;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function dedupeKey(item: ManifestItem): string {
  if (item.upc) return `upc:${item.upc}`;
  if (item.model) return `model:${item.brand}-${item.model}`;
  return `title:${item.brand}-${item.title}`;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function trimmed(values: number[], lowerPct: number, upperPct: number): number[] {
  if (values.length === 0) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const lower = Math.floor(sorted.length * lowerPct);
  const upper = Math.ceil(sorted.length * upperPct);
  return sorted.slice(lower, upper);
}

function coefficientOfVariation(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  if (mean === 0) return 0;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
  return Math.sqrt(variance) / mean;
}

async function loadCache(): Promise<CacheFile> {
  try {
    const data = await fs.readFile(CACHE_FILE, 'utf-8');
    return JSON.parse(data) as CacheFile;
  } catch {
    return {};
  }
}

async function saveCache(cache: CacheFile): Promise<void> {
  await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
  await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));
}

class EbayAuth {
  private token: EbayToken | null = null;

  async getAccessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - 60_000) {
      return this.token.accessToken;
    }

    const clientId = process.env.EBAY_CLIENT_ID || process.env.EBAY_APP_ID;
    const clientSecret = process.env.EBAY_CLIENT_SECRET || process.env.EBAY_CERT_ID;
    const refreshToken = process.env.EBAY_REFRESH_TOKEN;

    const missing: string[] = [];
    if (!clientId) missing.push('EBAY_CLIENT_ID (or EBAY_APP_ID)');
    if (!clientSecret) missing.push('EBAY_CLIENT_SECRET (or EBAY_CERT_ID)');
    if (!refreshToken) missing.push('EBAY_REFRESH_TOKEN');
    if (missing.length > 0) {
      throw new Error(`Missing eBay OAuth env vars: ${missing.join(', ')}.`);
    }

    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken!,
      scope: 'https://api.ebay.com/oauth/api_scope'
    });

    const response = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`eBay auth failed: ${response.status} ${text}`);
    }

    const payload = await response.json() as { access_token: string; expires_in: number };
    this.token = {
      accessToken: payload.access_token,
      expiresAt: Date.now() + payload.expires_in * 1000
    };
    return this.token.accessToken;
  }
}

class EbayBrowseClient {
  private auth = new EbayAuth();
  private cache: CacheFile = {};

  async initialize(): Promise<void> {
    this.cache = await loadCache();
  }

  private async fetchWithRetry(url: string, options: RequestInit, attempts = 4): Promise<Response> {
    let lastError: Error | null = null;
    for (let i = 0; i < attempts; i++) {
      try {
        const response = await fetch(url, options);
        if (response.ok) {
          return response;
        }
        if (response.status === 429 || response.status >= 500) {
          const waitMs = 500 * Math.pow(2, i);
          await sleep(waitMs);
          continue;
        }
        const text = await response.text();
        throw new Error(`eBay API error ${response.status}: ${text}`);
      } catch (error) {
        lastError = error as Error;
        const waitMs = 500 * Math.pow(2, i);
        await sleep(waitMs);
      }
    }
    throw lastError || new Error('eBay API request failed.');
  }

  private buildCacheKey(query: string, days: number): string {
    return `${query.toLowerCase().trim()}|${days}d`;
  }

  private extractPrices(items: any[]): number[] {
    const prices: number[] = [];
    for (const item of items) {
      const itemPrice = coerceNumber(item?.price?.value, 0);
      let shipPrice = 0;
      const shipping = item?.shippingOptions?.[0]?.shippingCost?.value;
      shipPrice = coerceNumber(shipping, 0);
      const total = itemPrice + shipPrice;
      if (total > 0) {
        prices.push(total);
      }
    }
    return prices;
  }

  async searchSoldItems(query: string, days: number): Promise<CompSnapshot> {
    const cacheKey = this.buildCacheKey(query, days);
    const cached = this.cache[cacheKey];
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.data;
    }

    const token = await this.auth.getAccessToken();
    const end = new Date();
    const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
    const params = new URLSearchParams({
      q: query,
      filter: `soldItems,startTime:[${start.toISOString()}..${end.toISOString()}]`,
      limit: '50',
      sort: 'endDate'
    });

    const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?${params.toString()}`;
    const response = await this.fetchWithRetry(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    const payload = await response.json() as { itemSummaries?: any[]; total?: number };
    const items = payload.itemSummaries ?? [];
    const prices = this.extractPrices(items);
    const trimmedPrices = trimmed(prices, 0.1, 0.9);
    const medianPrice = median(trimmedPrices);
    const snapshot: CompSnapshot = {
      soldCount: payload.total ?? items.length,
      prices,
      medianPrice,
      medianPriceInclShip: medianPrice
    };

    this.cache[cacheKey] = { timestamp: Date.now(), data: snapshot };
    await saveCache(this.cache);
    await sleep(300);
    return snapshot;
  }
}

export class EbayCompsManifestAnalyzer {
  private client = new EbayBrowseClient();

  private formatNumber(value: number, digits = 2): string {
    if (!Number.isFinite(value)) return '--';
    return value.toFixed(digits);
  }

  private async listManifestCandidates(): Promise<Array<{ label: string; value: string }>> {
    const exts = new Set(['.csv', '.tsv', '.xlsx', '.xls']);
    const candidates: Array<{ path: string; mtime: number }> = [];
    const searchDirs = [
      path.join(process.cwd(), 'data', 'techliquidators', 'manifests'),
    ];

    for (const dir of searchDirs) {
      let entries: Array<{ name: string; isFile: () => boolean }>;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (!exts.has(ext)) continue;
        const fullPath = path.join(dir, entry.name);
        try {
          const stat = await fs.stat(fullPath);
          candidates.push({ path: fullPath, mtime: stat.mtimeMs });
        } catch {
          // skip unreadable files
        }
      }
    }

    candidates.sort((a, b) => b.mtime - a.mtime);
    return candidates.map(item => {
      const relative = path.relative(process.cwd(), item.path);
      return {
        label: `${path.basename(item.path)} ${chalk.dim(`(${relative})`)}`,
        value: item.path
      };
    });
  }

  private async pickManifestPath(): Promise<string | null> {
    const candidates = await this.listManifestCandidates();
    if (candidates.length > 0) {
      const { selected } = await inquirer.prompt([
        {
          type: 'list',
          name: 'selected',
          message: chalk.bold('Select a manifest file:'),
          choices: [
            ...candidates.map(candidate => ({
              name: candidate.label,
              value: candidate.value
            })),
            { name: 'Enter a custom path...', value: '__manual__' }
          ],
          prefix: '📄'
        }
      ]);

      if (selected && selected !== '__manual__') {
        return selected;
      }
    }

    const { filePath } = await inquirer.prompt([
      {
        type: 'input',
        name: 'filePath',
        message: chalk.bold('Select a manifest file (path):'),
        prefix: '📄',
        filter: (input: string) => input.trim()
      }
    ]);

    if (!filePath) return null;
    const resolved = path.resolve(filePath);
    try {
      const stat = await fs.stat(resolved);
      if (!stat.isFile()) {
        console.log(chalk.yellow(`Manifest file is not a file: ${resolved}\n`));
        return null;
      }
    } catch {
      console.log(chalk.yellow(`Manifest file not found: ${resolved}\n`));
      return null;
    }
    return resolved;
  }

  private async readManifestFile(filePath: string): Promise<{ headers: string[]; rows: string[][] }> {
    const ext = path.extname(filePath).toLowerCase();
    if (['.csv', '.tsv'].includes(ext)) {
      const raw = await fs.readFile(filePath, 'utf-8');
      const delimiter = ext === '.tsv' ? '\t' : ',';
      return this.parseDelimited(raw, delimiter);
    }

    if (['.xlsx', '.xls'].includes(ext)) {
      const xlsxModule = await import('xlsx');
      const xlsx = xlsxModule.default ?? xlsxModule;
      const workbook = xlsx.readFile(filePath);
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const rows = xlsx.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false });
      const headers = (rows[0] || []).map(value => String(value));
      const dataRows = rows.slice(1).map(row => row.map(value => String(value ?? '')));
      return { headers, rows: dataRows };
    }

    throw new Error('Unsupported manifest file type. Use CSV, TSV, XLSX, or XLS.');
  }

  private parseDelimited(raw: string, delimiter: string): { headers: string[]; rows: string[][] } {
    const lines = raw.split(/\r?\n/).filter(line => line.trim() !== '');
    if (lines.length === 0) {
      return { headers: [], rows: [] };
    }
    const headers = this.parseDelimitedLine(lines[0], delimiter);
    const rows = lines.slice(1).map(line => this.parseDelimitedLine(line, delimiter));
    return { headers, rows };
  }

  private parseDelimitedLine(line: string, delimiter: string): string[] {
    const values: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }

      if (char === delimiter && !inQuotes) {
        values.push(current.trim());
        current = '';
        continue;
      }

      current += char;
    }
    values.push(current.trim());
    return values;
  }

  private suggestColumn(headers: string[], target: keyof ManifestColumnMap): string | null {
    const normalizedHeaders = headers.map(header => normalizeHeader(header));
    const synonyms = COLUMN_SYNONYMS[target] || [];
    for (const synonym of synonyms) {
      const index = normalizedHeaders.findIndex(header => header === synonym);
      if (index !== -1) return headers[index];
    }
    for (const synonym of synonyms) {
      const index = normalizedHeaders.findIndex(header => header.includes(synonym));
      if (index !== -1) return headers[index];
    }
    return null;
  }

  private async mapColumns(headers: string[]): Promise<ManifestColumnMap> {
    const headerChoices = headers.map(header => ({ name: header, value: header }));
    const requiredKeys: Array<keyof ManifestColumnMap> = [
      'title_or_description',
      'brand',
      'model_or_sku',
      'upc_ean',
      'msrp',
      'quantity'
    ];
    const optionalKeys: Array<keyof ManifestColumnMap> = ['condition_hint', 'category_hint'];

    const mapping: Partial<ManifestColumnMap> = {};
    for (const key of requiredKeys) {
      const suggested = this.suggestColumn(headers, key);
      const { selected } = await inquirer.prompt([
        {
          type: 'list',
          name: 'selected',
          message: chalk.bold(`Map column for ${key.replace(/_/g, ' ')}:`),
          choices: headerChoices,
          default: suggested || undefined,
          prefix: '🔗'
        }
      ]);
      mapping[key] = selected;
    }

    for (const key of optionalKeys) {
      const suggested = this.suggestColumn(headers, key);
      const { selected } = await inquirer.prompt([
        {
          type: 'list',
          name: 'selected',
          message: chalk.bold(`Map column for ${key.replace(/_/g, ' ')} (optional):`),
          choices: [{ name: 'Skip', value: '' }, ...headerChoices],
          default: suggested || '',
          prefix: '🧩'
        }
      ]);
      if (selected) {
        mapping[key] = selected;
      }
    }

    return mapping as ManifestColumnMap;
  }

  private normalizeRows(headers: string[], rows: string[][], mapping: ManifestColumnMap): ManifestItem[] {
    const headerIndex = new Map<string, number>();
    headers.forEach((header, index) => {
      headerIndex.set(header, index);
    });

    const items: ManifestItem[] = [];
    for (const row of rows) {
      const get = (key: keyof ManifestColumnMap) => {
        const header = mapping[key];
        if (!header) return '';
        const index = headerIndex.get(header);
        if (index === undefined) return '';
        return row[index] ?? '';
      };

      const title = String(get('title_or_description')).trim();
      const brandRaw = String(get('brand')).trim();
      const modelRaw = String(get('model_or_sku')).trim();
      const upcRaw = String(get('upc_ean')).trim();
      const msrpRaw = String(get('msrp')).trim();
      const qtyRaw = String(get('quantity')).trim();
      const conditionHint = String(get('condition_hint') || '').trim();
      const categoryHint = String(get('category_hint') || '').trim();

      if (!title && !modelRaw && !upcRaw) {
        continue;
      }

      items.push({
        title,
        brand: brandRaw.toUpperCase(),
        model: modelRaw,
        upc: upcRaw,
        msrp: parseCurrency(msrpRaw),
        quantity: Math.max(parseInteger(qtyRaw), 1),
        conditionHint: conditionHint || undefined,
        categoryHint: categoryHint || undefined
      });
    }

    const deduped = new Map<string, ManifestItem>();
    for (const item of items) {
      const key = dedupeKey(item);
      const existing = deduped.get(key);
      if (existing) {
        existing.quantity += item.quantity;
        existing.msrp = Math.max(existing.msrp, item.msrp);
      } else {
        deduped.set(key, { ...item });
      }
    }

    return Array.from(deduped.values());
  }

  private buildQuery(item: ManifestItem): { matchType: 'upc' | 'model' | 'title'; query: string } {
    if (item.upc) {
      return { matchType: 'upc', query: item.upc };
    }
    if (item.model) {
      return { matchType: 'model', query: `${item.brand} ${item.model}`.trim() };
    }
    const shortTitle = item.title.split(/\s+/).slice(0, 6).join(' ');
    return { matchType: 'title', query: `${item.brand} ${shortTitle}`.trim() };
  }

  private scoreConfidence(matchType: 'upc' | 'model' | 'title', soldCount90: number, priceStability: number): number {
    const matchQuality = matchType === 'upc' ? 0.9 : matchType === 'model' ? 0.75 : 0.6;
    const soldScore = Math.min(soldCount90 / 20, 1);
    const stabilityScore = Math.max(0, Math.min(priceStability, 1));
    return Math.round((matchQuality * 0.4 + soldScore * 0.4 + stabilityScore * 0.2) * 100);
  }

  private assignTier(soldCount90: number): { tier: CompResult['tier']; sellableRate: number } {
    for (const tier of TIERS) {
      if (soldCount90 >= tier.soldCount90Min) {
        return { tier: tier.tier, sellableRate: tier.sellableRate };
      }
    }
    return { tier: 'D', sellableRate: 0.25 };
  }

  private computeBreakevenSalePct(
    netBeforeAcquisition: number,
    msrpTotal: number,
    platformFeeRate: number,
    returnsAllowanceRate: number
  ): number {
    const denominator = msrpTotal * (1 - platformFeeRate - returnsAllowanceRate);
    if (denominator <= 0) return 0;
    return netBeforeAcquisition / denominator;
  }

  private async promptAssumptions(): Promise<Assumptions> {
    const answers = await inquirer.prompt<{
      assume_condition: 'open_box' | 'used' | 'for_parts';
      condition_price_multiplier: string;
      sell_through_rate_default: string;
      damage_rate_default: string;
      ebay_fee_rate: string;
      returns_allowance_rate: string;
      outbound_shipping_per_sold_unit: string;
      labor_mode: 'hourly' | 'profit_share' | 'none';
      labor_hourly_rate?: string;
      labor_minutes_per_sold_unit?: string;
      profit_share_rate?: string;
      inbound_shipping_multiplier_on_hammer: string;
      roi_floor_multiple: string;
    }>([
      {
        type: 'list',
        name: 'assume_condition',
        message: chalk.bold('Assumed condition for comps adjustment:'),
        choices: [
          { name: 'Open box', value: 'open_box' },
          { name: 'Used', value: 'used' },
          { name: 'For parts', value: 'for_parts' }
        ],
        default: 'open_box',
        prefix: '📦'
      },
      {
        type: 'input',
        name: 'condition_price_multiplier',
        message: chalk.bold('Condition multiplier applied to sold price:'),
        default: '0.85',
        prefix: '🎛️',
        filter: (input: string) => input.trim()
      },
      {
        type: 'input',
        name: 'sell_through_rate_default',
        message: chalk.bold('Default sell-through rate for unknown items (0-1):'),
        default: '0.7',
        prefix: '📈',
        filter: (input: string) => input.trim()
      },
      {
        type: 'input',
        name: 'damage_rate_default',
        message: chalk.bold('Default damage/dead rate for unknown items (0-1):'),
        default: '0.3',
        prefix: '⚠️',
        filter: (input: string) => input.trim()
      },
      {
        type: 'input',
        name: 'ebay_fee_rate',
        message: chalk.bold('Blended eBay fee rate (0-1):'),
        default: '0.145',
        prefix: '🧾',
        filter: (input: string) => input.trim()
      },
      {
        type: 'input',
        name: 'returns_allowance_rate',
        message: chalk.bold('Returns allowance rate (0-1):'),
        default: '0.02',
        prefix: '↩️',
        filter: (input: string) => input.trim()
      },
      {
        type: 'input',
        name: 'outbound_shipping_per_sold_unit',
        message: chalk.bold('Outbound shipping + materials per sold unit (USD):'),
        default: '15',
        prefix: '🚚',
        filter: (input: string) => input.trim()
      },
      {
        type: 'list',
        name: 'labor_mode',
        message: chalk.bold('Labor model:'),
        choices: [
          { name: 'Hourly', value: 'hourly' },
          { name: 'Profit share', value: 'profit_share' },
          { name: 'None', value: 'none' }
        ],
        default: 'hourly',
        prefix: '👷'
      },
      {
        type: 'input',
        name: 'labor_hourly_rate',
        message: chalk.bold('Labor hourly rate (USD):'),
        default: '20',
        prefix: '💵',
        filter: (input: string) => input.trim(),
        when: (answers: { labor_mode: string }) => answers.labor_mode === 'hourly'
      },
      {
        type: 'input',
        name: 'labor_minutes_per_sold_unit',
        message: chalk.bold('Labor minutes per sold unit:'),
        default: '10',
        prefix: '⏱️',
        filter: (input: string) => input.trim(),
        when: (answers: { labor_mode: string }) => answers.labor_mode === 'hourly'
      },
      {
        type: 'input',
        name: 'profit_share_rate',
        message: chalk.bold('Profit-share rate (0-1):'),
        default: '0.3',
        prefix: '🤝',
        filter: (input: string) => input.trim(),
        when: (answers: { labor_mode: string }) => answers.labor_mode === 'profit_share'
      },
      {
        type: 'input',
        name: 'inbound_shipping_multiplier_on_hammer',
        message: chalk.bold('Inbound shipping multiplier on hammer:'),
        default: '2.0',
        prefix: '🚛',
        filter: (input: string) => input.trim()
      },
      {
        type: 'input',
        name: 'roi_floor_multiple',
        message: chalk.bold('Minimum acceptable ROI multiple:'),
        default: '2.0',
        prefix: '🎯',
        filter: (input: string) => input.trim()
      }
    ]);

    return {
      assume_condition: answers.assume_condition,
      condition_price_multiplier: Number.parseFloat(answers.condition_price_multiplier),
      sell_through_rate_default: Number.parseFloat(answers.sell_through_rate_default),
      damage_rate_default: Number.parseFloat(answers.damage_rate_default),
      ebay_fee_rate: Number.parseFloat(answers.ebay_fee_rate),
      returns_allowance_rate: Number.parseFloat(answers.returns_allowance_rate),
      outbound_shipping_per_sold_unit: Number.parseFloat(answers.outbound_shipping_per_sold_unit),
      labor_mode: answers.labor_mode,
      labor_hourly_rate: Number.parseFloat(answers.labor_hourly_rate ?? '0'),
      labor_minutes_per_sold_unit: Number.parseFloat(answers.labor_minutes_per_sold_unit ?? '0'),
      profit_share_rate: Number.parseFloat(answers.profit_share_rate ?? '0'),
      inbound_shipping_multiplier_on_hammer: Number.parseFloat(answers.inbound_shipping_multiplier_on_hammer),
      roi_floor_multiple: Number.parseFloat(answers.roi_floor_multiple)
    };
  }

  private async promptBidContext(): Promise<BidContext> {
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'msrp_total_override',
        message: chalk.bold('Override MSRP total (USD) (blank to compute):'),
        prefix: '🧮',
        filter: (input: string) => input.trim()
      },
      {
        type: 'input',
        name: 'current_hammer_bid',
        message: chalk.bold('Current hammer bid (USD) (optional):'),
        prefix: '🔨',
        filter: (input: string) => input.trim()
      },
      {
        type: 'confirm',
        name: 'use_default_bands',
        message: chalk.bold('Use default hammer bid % bands (3,4,5,6%)?'),
        default: true,
        prefix: '📊'
      }
    ]);

    let bands = DEFAULT_BANDS;
    if (!answers.use_default_bands) {
      const bandAnswers = await inquirer.prompt(
        DEFAULT_BANDS.flatMap((band, idx) => [
          {
            type: 'input',
            name: `bandLabel${idx}`,
            message: chalk.bold(`Band ${idx + 1} label:`),
            prefix: '🏷️',
            filter: (input: string) => input.trim(),
            default: band.label
          },
          {
            type: 'input',
            name: `bandPct${idx}`,
            message: chalk.bold(`Band ${idx + 1} hammer bid % (0-1):`),
            prefix: '📈',
            filter: (input: string) => input.trim(),
            default: band.pct.toString()
          }
        ])
      );
      bands = DEFAULT_BANDS.map((band, idx) => ({
        label: String(bandAnswers[`bandLabel${idx}`] || band.label),
        pct: coerceNumber(bandAnswers[`bandPct${idx}`], band.pct)
      }));
    }

    return {
      msrp_total_override: answers.msrp_total_override ? Number.parseFloat(answers.msrp_total_override) : undefined,
      current_hammer_bid: answers.current_hammer_bid ? Number.parseFloat(answers.current_hammer_bid) : undefined,
      target_hammer_bid_pct_bands: bands
    };
  }

  private validateAssumptions(assumptions: Assumptions): string[] {
    const errors: string[] = [];
    if (assumptions.sell_through_rate_default < 0 || assumptions.sell_through_rate_default > 1) {
      errors.push('Sell-through rate must be between 0 and 1.');
    }
    if (assumptions.damage_rate_default < 0 || assumptions.damage_rate_default > 1) {
      errors.push('Damage rate must be between 0 and 1.');
    }
    if (assumptions.ebay_fee_rate < 0 || assumptions.ebay_fee_rate > 0.3) {
      errors.push('eBay fee rate must be between 0 and 0.3.');
    }
    if (assumptions.returns_allowance_rate < 0 || assumptions.returns_allowance_rate > 0.2) {
      errors.push('Returns allowance rate must be between 0 and 0.2.');
    }
    if (assumptions.outbound_shipping_per_sold_unit < 0) {
      errors.push('Outbound shipping per unit must be >= 0.');
    }
    if (assumptions.inbound_shipping_multiplier_on_hammer < 1) {
      errors.push('Inbound shipping multiplier must be >= 1.');
    }
    if (assumptions.labor_mode === 'hourly') {
      if (assumptions.labor_hourly_rate < 0) errors.push('Hourly rate must be >= 0.');
      if (assumptions.labor_minutes_per_sold_unit < 0) errors.push('Minutes per unit must be >= 0.');
    }
    if (assumptions.labor_mode === 'profit_share') {
      if (assumptions.profit_share_rate < 0 || assumptions.profit_share_rate > 1) {
        errors.push('Profit share rate must be between 0 and 1.');
      }
    }
    return errors;
  }

  private summarizeComps(item: ManifestItem, comps90: CompSnapshot, comps30: CompSnapshot): CompResult {
    const pricesTrimmed = trimmed(comps90.prices, 0.1, 0.9);
    const stability = 1 - Math.min(coefficientOfVariation(pricesTrimmed), 1);
    const { tier, sellableRate } = this.assignTier(comps90.soldCount);
    const queryInfo = this.buildQuery(item);
    const confidenceScore = this.scoreConfidence(queryInfo.matchType, comps90.soldCount, stability);
    return {
      matchType: queryInfo.matchType,
      query: queryInfo.query,
      soldCount30: comps30.soldCount,
      soldCount90: comps90.soldCount,
      medianSoldPrice: comps90.medianPrice,
      medianSoldPriceInclShip: comps90.medianPriceInclShip,
      confidenceScore,
      tier,
      sellableRate,
      priceStability: stability
    };
  }

  private buildPerSkuResults(items: ManifestItem[], comps: CompResult[], assumptions: Assumptions): PerSkuResult[] {
    return items.map((item, index) => {
      const comp = comps[index];
      const salePrice = comp.medianSoldPriceInclShip > 0
        ? comp.medianSoldPriceInclShip * assumptions.condition_price_multiplier
        : item.msrp * 0.25;
      const sellableRate = comp.soldCount90 > 0 ? comp.sellableRate : assumptions.sell_through_rate_default;
      const estimatedGross = salePrice * item.quantity * sellableRate;
      const estimatedFees = estimatedGross * assumptions.ebay_fee_rate;
      const estimatedReturnsReserve = estimatedGross * assumptions.returns_allowance_rate;
      const estimatedOutboundShipping = item.quantity * sellableRate * assumptions.outbound_shipping_per_sold_unit;
      const estimatedLabor = assumptions.labor_mode === 'hourly'
        ? item.quantity * sellableRate * (assumptions.labor_minutes_per_sold_unit / 60) * assumptions.labor_hourly_rate
        : 0;
      const estimatedNetContribution = estimatedGross - estimatedFees - estimatedReturnsReserve - estimatedOutboundShipping - estimatedLabor;

      return {
        item,
        comps: comp,
        estimatedSalePrice: salePrice,
        estimatedGross,
        estimatedFees,
        estimatedReturnsReserve,
        estimatedOutboundShipping,
        estimatedLabor,
        estimatedNetContribution
      };
    });
  }

  private async exportResults(
    summary: any,
    perSku: PerSkuResult[],
    outputDir = path.join(process.cwd(), 'output')
  ): Promise<void> {
    await fs.mkdir(outputDir, { recursive: true });
    const jsonPath = path.join(outputDir, 'manifest_analysis.json');
    const csvPath = path.join(outputDir, 'per_sku_analysis.csv');

    const csvHeaders = [
      'brand',
      'model_or_sku',
      'upc_ean',
      'quantity',
      'msrp',
      'match_type',
      'sold_count_30d',
      'sold_count_90d',
      'median_sold_price_incl_ship',
      'estimated_sale_price',
      'tier',
      'sellable_rate',
      'estimated_net_contribution'
    ];

    const csvRows = perSku.map(result => ([
      result.item.brand,
      result.item.model,
      result.item.upc,
      result.item.quantity.toString(),
      this.formatNumber(result.item.msrp, 2),
      result.comps.matchType,
      result.comps.soldCount30.toString(),
      result.comps.soldCount90.toString(),
      this.formatNumber(result.comps.medianSoldPriceInclShip, 2),
      this.formatNumber(result.estimatedSalePrice, 2),
      result.comps.tier,
      this.formatNumber(result.comps.sellableRate, 2),
      this.formatNumber(result.estimatedNetContribution, 2)
    ]));

    const csvContents = [csvHeaders.join(','), ...csvRows.map(row => row.join(','))].join('\n');
    await fs.writeFile(jsonPath, JSON.stringify(summary, null, 2));
    await fs.writeFile(csvPath, csvContents);

    console.log(chalk.green(`Exported JSON: ${jsonPath}`));
    console.log(chalk.green(`Exported CSV: ${csvPath}`));
  }

  async run(): Promise<void> {
    console.log(chalk.bold.cyan('\n━━━━━━━━ EBAY COMPS + MANIFEST ANALYZER ━━━━━━━━\n'));

    await this.client.initialize();

    const manifestPath = await this.pickManifestPath();
    if (!manifestPath) {
      console.log(chalk.yellow('No manifest selected.\n'));
      return;
    }

    const { headers, rows } = await this.readManifestFile(manifestPath);
    if (headers.length === 0 || rows.length === 0) {
      console.log(chalk.yellow('Manifest file is empty.\n'));
      return;
    }

    const mapping = await this.mapColumns(headers);
    const items = this.normalizeRows(headers, rows, mapping);
    if (items.length === 0) {
      console.log(chalk.yellow('No usable items found after normalization.\n'));
      return;
    }

    const assumptions = await this.promptAssumptions();
    const validationErrors = this.validateAssumptions(assumptions);
    if (validationErrors.length > 0) {
      validationErrors.forEach(err => console.log(chalk.yellow(err)));
      console.log('');
      return;
    }

    const bidContext = await this.promptBidContext();

    console.log(chalk.cyan('Fetching sold comps from eBay...'));
    const comps: CompResult[] = [];
    for (const item of items) {
      const query = this.buildQuery(item);
      const comps30 = await this.client.searchSoldItems(query.query, 30);
      const comps90 = await this.client.searchSoldItems(query.query, 90);
      comps.push(this.summarizeComps(item, comps90, comps30));
    }

    const perSku = this.buildPerSkuResults(items, comps, assumptions);
    const unitsTotal = items.reduce((sum, item) => sum + item.quantity, 0);
    const msrpTotalFromManifest = items.reduce((sum, item) => sum + item.msrp * item.quantity, 0);
    const msrpTotal = bidContext.msrp_total_override ?? msrpTotalFromManifest;

    const grossRevenue = perSku.reduce((sum, row) => sum + row.estimatedGross, 0);
    const fees = perSku.reduce((sum, row) => sum + row.estimatedFees, 0);
    const returnsReserve = perSku.reduce((sum, row) => sum + row.estimatedReturnsReserve, 0);
    const outboundShipping = perSku.reduce((sum, row) => sum + row.estimatedOutboundShipping, 0);
    const laborCost = perSku.reduce((sum, row) => sum + row.estimatedLabor, 0);
    const netBeforeAcquisition = grossRevenue - fees - returnsReserve - outboundShipping - laborCost;

    const soldUnits = perSku.reduce((sum, row) => sum + row.item.quantity * row.comps.sellableRate, 0);
    const blendedAspAllUnits = unitsTotal > 0 ? grossRevenue / unitsTotal : 0;
    const blendedAspSoldUnits = soldUnits > 0 ? grossRevenue / soldUnits : 0;

    const compsCoverageUnits = perSku
      .filter(row => row.comps.soldCount90 > 0)
      .reduce((sum, row) => sum + row.item.quantity, 0) / unitsTotal;
    const compsCoverageMsrp = msrpTotalFromManifest > 0
      ? perSku.filter(row => row.comps.soldCount90 > 0).reduce((sum, row) => sum + row.item.msrp * row.item.quantity, 0) / msrpTotalFromManifest
      : 0;

    const tierCounts = perSku.reduce(
      (acc, row) => {
        acc[row.comps.tier] += row.item.quantity;
        return acc;
      },
      { A: 0, B: 0, C: 0, D: 0 }
    );

    const tierPct = {
      A: unitsTotal ? tierCounts.A / unitsTotal : 0,
      B: unitsTotal ? tierCounts.B / unitsTotal : 0,
      C: unitsTotal ? tierCounts.C / unitsTotal : 0,
      D: unitsTotal ? tierCounts.D / unitsTotal : 0
    };

    const redFlags: string[] = [];
    if (compsCoverageUnits < 0.4) {
      redFlags.push('Low comps coverage (<40% of units). Consider lower bids or manual review.');
    }
    if (tierPct.D > 0.5) {
      redFlags.push('>50% D-tier by units (no comps / junk). Auto-reject unless manual override.');
    }

    const bands = bidContext.target_hammer_bid_pct_bands
      .map(band => {
        const hammerBid = msrpTotal * band.pct;
        const allInCost = hammerBid * assumptions.inbound_shipping_multiplier_on_hammer;
        const netProfitPrePartner = netBeforeAcquisition - allInCost;
        const partnerCut = assumptions.labor_mode === 'profit_share'
          ? Math.max(0, netProfitPrePartner) * assumptions.profit_share_rate
          : 0;
        const netProfitToYou = netProfitPrePartner - partnerCut;
        const roiMultiple = allInCost > 0 ? netProfitToYou / allInCost : 0;
        return {
          ...band,
          hammerBid,
          allInCost,
          netProfitToYou,
          roiMultiple
        };
      })
      .sort((a, b) => a.pct - b.pct);

    const viableBands = bands.filter(
      band => band.netProfitToYou > 0 && band.roiMultiple >= assumptions.roi_floor_multiple
    );
    const recommended = viableBands.length ? viableBands[viableBands.length - 1] : null;

    const currentBidRoi = bidContext.current_hammer_bid
      ? (() => {
        const allIn = bidContext.current_hammer_bid! * assumptions.inbound_shipping_multiplier_on_hammer;
        const netProfitToYou = netBeforeAcquisition - allIn;
        const roi = allIn > 0 ? netProfitToYou / allIn : 0;
        return { allIn, netProfitToYou, roi };
      })()
      : null;

    const summary = {
      lot_summary: {
        msrp_total: msrpTotal,
        units_total: unitsTotal,
        comps_coverage_by_units: compsCoverageUnits,
        gross_revenue: grossRevenue,
        net_before_acquisition: netBeforeAcquisition,
        blended_asp_all_units: blendedAspAllUnits,
        blended_asp_sold_units: blendedAspSoldUnits
      },
      comps_coverage: {
        coverage_by_units: compsCoverageUnits,
        coverage_by_msrp: compsCoverageMsrp
      },
      tier_breakdown: {
        tier_A_units_pct: tierPct.A,
        tier_B_units_pct: tierPct.B,
        tier_C_units_pct: tierPct.C,
        tier_D_units_pct: tierPct.D
      },
      economics_summary: {
        fees,
        returns_reserve: returnsReserve,
        outbound_shipping: outboundShipping,
        labor_cost: laborCost
      },
      max_bid_recommendation: recommended
        ? {
          recommended_band_label: recommended.label,
          recommended_hammer_bid_usd: recommended.hammerBid,
          recommended_all_in_cost_usd: recommended.allInCost,
          expected_net_profit_to_you: recommended.netProfitToYou,
          expected_roi_multiple_to_you: recommended.roiMultiple
        }
        : null,
      current_bid_context: currentBidRoi
        ? {
          current_hammer_bid_usd: bidContext.current_hammer_bid,
          current_all_in_cost_usd: currentBidRoi.allIn,
          current_net_profit_to_you: currentBidRoi.netProfitToYou,
          current_roi_multiple_to_you: currentBidRoi.roi
        }
        : null,
      red_flags: redFlags
    };

    console.log(chalk.bold('Lot Summary'));
    const summaryTable = new Table({
      style: { head: ['cyan'], border: ['grey'] },
      colWidths: [26, 22]
    });
    summaryTable.push(
      ['MSRP total', `$${this.formatNumber(msrpTotal)}`],
      ['Units total', unitsTotal.toString()],
      ['Comps coverage (units)', `${this.formatNumber(compsCoverageUnits * 100, 1)}%`],
      ['Gross revenue', `$${this.formatNumber(grossRevenue)}`],
      ['Net before acquisition', `$${this.formatNumber(netBeforeAcquisition)}`],
      ['Blended ASP (all units)', `$${this.formatNumber(blendedAspAllUnits)}`],
      ['Blended ASP (sold units)', `$${this.formatNumber(blendedAspSoldUnits)}`]
    );
    console.log(summaryTable.toString());
    console.log('');

    console.log(chalk.bold('Tier Breakdown'));
    const tierTable = new Table({
      style: { head: ['cyan'], border: ['grey'] },
      colWidths: [14, 18]
    });
    tierTable.push(
      ['Tier A', `${this.formatNumber(tierPct.A * 100, 1)}%`],
      ['Tier B', `${this.formatNumber(tierPct.B * 100, 1)}%`],
      ['Tier C', `${this.formatNumber(tierPct.C * 100, 1)}%`],
      ['Tier D', `${this.formatNumber(tierPct.D * 100, 1)}%`]
    );
    console.log(tierTable.toString());
    console.log('');

    console.log(chalk.bold('Economics Summary'));
    const econTable = new Table({
      style: { head: ['cyan'], border: ['grey'] },
      colWidths: [26, 22]
    });
    econTable.push(
      ['Fees', `$${this.formatNumber(fees)}`],
      ['Returns reserve', `$${this.formatNumber(returnsReserve)}`],
      ['Outbound shipping', `$${this.formatNumber(outboundShipping)}`],
      ['Labor cost', `$${this.formatNumber(laborCost)}`]
    );
    console.log(econTable.toString());
    console.log('');

    console.log(chalk.bold('Bid Bands'));
    const bandTable = new Table({
      style: { head: ['cyan'], border: ['grey'] },
      colWidths: [20, 10, 16, 16, 16, 10]
    });
    bandTable.push(['Band', '% MSRP', 'Hammer bid', 'All-in cost', 'Net profit', 'ROI']);
    for (const band of bands) {
      bandTable.push([
        band.label,
        `${this.formatNumber(band.pct * 100, 1)}%`,
        `$${this.formatNumber(band.hammerBid)}`,
        `$${this.formatNumber(band.allInCost)}`,
        `$${this.formatNumber(band.netProfitToYou)}`,
        `${this.formatNumber(band.roiMultiple, 2)}x`
      ]);
    }
    console.log(bandTable.toString());
    console.log('');

    console.log(chalk.bold('Recommendation'));
    if (recommended) {
      const recommendationBox = boxen(
        `${chalk.bold('Recommended band')}: ${chalk.cyan(recommended.label)}\n` +
          `${chalk.bold('Hammer bid cap')}: ${chalk.cyan(`$${this.formatNumber(recommended.hammerBid)}`)}\n` +
          `${chalk.bold('All-in cost')}: ${chalk.cyan(`$${this.formatNumber(recommended.allInCost)}`)}\n` +
          `${chalk.bold('ROI')}: ${chalk.cyan(`${this.formatNumber(recommended.roiMultiple, 2)}x`)}`,
        {
          padding: 1,
          borderStyle: 'round',
          borderColor: 'green'
        }
      );
      console.log(recommendationBox);
    } else {
      console.log(chalk.red('NO BID - no band meets ROI floor or positive profit.'));
    }
    console.log('');

    if (currentBidRoi) {
      const currentBox = boxen(
        `${chalk.bold('Current hammer bid')}: ${chalk.cyan(`$${this.formatNumber(bidContext.current_hammer_bid || 0)}`)}\n` +
          `${chalk.bold('All-in cost')}: ${chalk.cyan(`$${this.formatNumber(currentBidRoi.allIn)}`)}\n` +
          `${chalk.bold('ROI')}: ${chalk.cyan(`${this.formatNumber(currentBidRoi.roi, 2)}x`)}`,
        {
          padding: 1,
          borderStyle: 'round',
          borderColor: 'cyan'
        }
      );
      console.log(chalk.bold('Current Bid Context'));
      console.log(currentBox);
      console.log('');
    }

    const perSkuTable = new Table({
      style: { head: ['cyan'], border: ['grey'] },
      colWidths: [12, 12, 12, 7, 10, 8, 8, 10, 12, 10, 6, 10, 12]
    });
    perSkuTable.push([
      'Brand',
      'Model/SKU',
      'UPC/EAN',
      'Qty',
      'MSRP',
      'Match',
      '90d',
      'Median',
      'Est. price',
      'Tier',
      'Sell%',
      'Conf',
      'Net'
    ]);

    for (const row of perSku) {
      perSkuTable.push([
        row.item.brand || '-',
        row.item.model || '-',
        row.item.upc || '-',
        row.item.quantity.toString(),
        `$${this.formatNumber(row.item.msrp)}`,
        row.comps.matchType,
        row.comps.soldCount90.toString(),
        `$${this.formatNumber(row.comps.medianSoldPriceInclShip)}`,
        `$${this.formatNumber(row.estimatedSalePrice)}`,
        row.comps.tier,
        `${this.formatNumber(row.comps.sellableRate * 100, 0)}%`,
        `${row.comps.confidenceScore}`,
        `$${this.formatNumber(row.estimatedNetContribution)}`
      ]);
    }

    console.log(chalk.bold('Per-SKU Table'));
    console.log(perSkuTable.toString());
    console.log('');

    if (redFlags.length) {
      console.log(chalk.bold('Red Flags'));
      redFlags.forEach(flag => console.log(chalk.yellow(`- ${flag}`)));
      console.log('');
    }

    const { exportResults } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'exportResults',
        message: chalk.bold('Export results to JSON/CSV?'),
        default: true,
        prefix: '📤'
      }
    ]);

    if (exportResults) {
      await this.exportResults(
        {
          ...summary,
          per_sku: perSku.map(row => ({
            brand: row.item.brand,
            model_or_sku: row.item.model,
            upc_ean: row.item.upc,
            quantity: row.item.quantity,
            msrp: row.item.msrp,
            match_type: row.comps.matchType,
            sold_count_30d: row.comps.soldCount30,
            sold_count_90d: row.comps.soldCount90,
            median_sold_price_incl_ship: row.comps.medianSoldPriceInclShip,
            estimated_sale_price: row.estimatedSalePrice,
            tier: row.comps.tier,
            sellable_rate: row.comps.sellableRate,
            estimated_net_contribution: row.estimatedNetContribution
          }))
        },
        perSku
      );
    }
  }
}
