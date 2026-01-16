import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import axios from 'axios';
import { fileURLToPath } from 'url';

export interface ManifestSummary {
  row_count?: number;
  msrp_total?: number;
  avg_msrp?: number | null;
  msrp_column?: string | null;
  quantity_column?: string | null;
  description_column?: string | null;
  brand_column?: string | null;
  category_column?: string | null;
  top_brands?: Array<{ name: string; count: number }>;
  top_categories?: Array<{ name: string; count: number }>;
  sample_items?: Array<{ description?: string; msrp?: number | null; quantity?: number }>;
}

export interface WatchlistItem {
  auction_id?: string;
  url?: string;
  title?: string;
  current_bid_value?: number;
  lot_price_value?: number;
  msrp_value?: number;
  retail_value_value?: number;
  items_count_value?: number;
  shipping_cost_value?: number;
  condition?: string;
  warehouse?: string;
  auction_end?: string;
  manifest_url?: string;
  manifest_path?: string | null;
  manifest_summary?: ManifestSummary | null;
}

export interface WatchlistPayload {
  fetched_at: string;
  source_url?: string | null;
  items: WatchlistItem[];
}

export interface BidItem {
  auction_id?: string;
  lot_id?: string;
  url?: string;
  title?: string;
  current_bid_value?: number;
  my_max_bid_value?: number;
  bid_status?: string;
  units?: number;
  closes_in?: string;
  auction_end?: string;
}

export interface BidsPayload {
  fetched_at: string;
  source_url?: string | null;
  items: BidItem[];
}

export type AlertSource = 'watchlist' | 'bids';

export interface WatchlistAlert {
  auctionId: string;
  title?: string;
  url?: string;
  endTime: Date;
  millisRemaining: number;
  currentBid?: number;
  lotPrice?: number;
  sources: AlertSource[];
}

export type Decision = 'PASS' | 'FAIL';

export interface ProfitabilityResult {
  auctionId: string;
  title?: string;
  decision: Decision;
  ruleDecision: Decision;
  aiDecision?: Decision;
  aiConfidence?: string;
  aiSummary?: string;
  estimatedResaleValue?: number;
  estimatedProfit?: number;
  estimatedMargin?: number;
  costBasis?: number;
  msrpTotal?: number;
  inboundShipping?: number;
  outboundShipping?: number;
  marketplaceFees?: number;
  laborCost?: number;
  warehouseCost?: number;
}

interface LlmDecisionPayload {
  decision?: string;
  confidence?: string;
  rationale?: string;
  comps?: string;
  risks?: string;
}

export class TechLiquidatorsIntegration {
  private dataDir = path.join(process.cwd(), 'data', 'techliquidators');
  private watchlistPath = path.join(this.dataDir, 'watchlist.json');
  private bidsPath = path.join(this.dataDir, 'bids.json');
  private analysisPath = path.join(this.dataDir, 'analysis.json');

  constructor() {
    void this.loadDotEnv();
  }

  async syncWatchlist(): Promise<WatchlistPayload | null> {
    const root = await this.findProjectRoot(process.cwd());
    if (!root) {
      throw new Error('Project root not found. Run from the UPSCALED workspace.');
    }

    await fs.mkdir(this.dataDir, { recursive: true });

    const scriptPath = path.join(
      root,
      '08_AUTOMATION',
      'CLI_Tools',
      'auction_scraper',
      'sync_techliquidators_watchlist.py'
    );
    try {
      await fs.access(scriptPath);
    } catch {
      throw new Error(`TechLiquidators scraper not found at ${scriptPath}.`);
    }
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';

    const args = [scriptPath, '--out-dir', this.dataDir];
    const cookieFile = process.env.TECHLIQUIDATORS_COOKIE_FILE;
    const cookieHeader = process.env.TECHLIQUIDATORS_COOKIE;
    const watchlistUrl = process.env.TECHLIQUIDATORS_WATCHLIST_URL;
    const maxItems = process.env.TECHLIQUIDATORS_MAX_ITEMS;
    const force = process.env.TECHLIQUIDATORS_FORCE_MANIFESTS;

    if (cookieFile) {
      args.push('--cookie-file', cookieFile);
    }
    if (cookieHeader) {
      args.push('--cookie-header', cookieHeader);
    }
    if (watchlistUrl) {
      args.push('--watchlist-url', watchlistUrl);
    }
    if (maxItems) {
      args.push('--max-items', maxItems);
    }
    if (force && (force === '1' || force.toLowerCase() === 'true')) {
      args.push('--force');
    }

    await new Promise<void>((resolve, reject) => {
      const child = spawn(pythonCmd, args, { stdio: 'inherit' });
      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error('TechLiquidators watchlist sync failed'));
        }
      });
    });

    return this.readWatchlist();
  }

  async syncBids(): Promise<BidsPayload | null> {
    const root = await this.findProjectRoot(process.cwd());
    if (!root) {
      throw new Error('Project root not found. Run from the UPSCALED workspace.');
    }

    await fs.mkdir(this.dataDir, { recursive: true });

    const scriptPath = path.join(
      root,
      '08_AUTOMATION',
      'CLI_Tools',
      'auction_scraper',
      'sync_techliquidators_bids.py'
    );
    try {
      await fs.access(scriptPath);
    } catch {
      throw new Error(`TechLiquidators scraper not found at ${scriptPath}.`);
    }
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';

    const args = [scriptPath, '--out-dir', this.dataDir];
    const cookieFile = process.env.TECHLIQUIDATORS_COOKIE_FILE;
    const cookieHeader = process.env.TECHLIQUIDATORS_COOKIE;
    const bidsUrl = process.env.TECHLIQUIDATORS_BIDS_URL;
    const maxItems = process.env.TECHLIQUIDATORS_MAX_ITEMS;

    if (cookieFile) {
      args.push('--cookie-file', cookieFile);
    }
    if (cookieHeader) {
      args.push('--cookie-header', cookieHeader);
    }
    if (bidsUrl) {
      args.push('--bids-url', bidsUrl);
    }
    if (maxItems) {
      args.push('--max-items', maxItems);
    }

    await new Promise<void>((resolve, reject) => {
      const child = spawn(pythonCmd, args, { stdio: 'inherit' });
      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error('TechLiquidators bids sync failed'));
        }
      });
    });

    return this.readBids();
  }

  async analyzeWatchlist(): Promise<ProfitabilityResult[]> {
    await fs.mkdir(this.dataDir, { recursive: true });
    const payload = await this.readWatchlist();
    if (!payload) {
      return [];
    }

    const results: ProfitabilityResult[] = [];
    for (const item of payload.items) {
      results.push(await this.analyzeItem(item));
    }

    await fs.writeFile(this.analysisPath, JSON.stringify(results, null, 2));
    return results;
  }

  async getWatchlistAlerts(options?: {
    windowHours?: number;
    graceMinutes?: number;
    now?: Date;
  }): Promise<WatchlistAlert[]> {
    const payload = await this.readWatchlist();
    if (!payload) {
      return [];
    }
    return this.getAlertsFromItems(payload.items, 'watchlist', options);
  }

  async getBidAlerts(options?: {
    windowHours?: number;
    graceMinutes?: number;
    now?: Date;
  }): Promise<WatchlistAlert[]> {
    const payload = await this.readBids();
    if (!payload) {
      return [];
    }
    return this.getAlertsFromItems(payload.items, 'bids', options);
  }

  async getCombinedAlerts(options?: {
    windowHours?: number;
    graceMinutes?: number;
    now?: Date;
  }): Promise<WatchlistAlert[]> {
    const [watchlistAlerts, bidAlerts] = await Promise.all([
      this.getWatchlistAlerts(options),
      this.getBidAlerts(options),
    ]);

    const merged = new Map<string, WatchlistAlert>();
    const addAlert = (alert: WatchlistAlert) => {
      const keyBase = alert.auctionId !== 'unknown'
        ? alert.auctionId
        : alert.url || alert.title || String(alert.endTime.getTime());
      const key = keyBase || String(alert.endTime.getTime());
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, { ...alert, sources: [...alert.sources] });
        return;
      }
      const combinedSources = new Set<AlertSource>([...existing.sources, ...alert.sources]);
      merged.set(key, {
        ...existing,
        title: existing.title || alert.title,
        url: existing.url || alert.url,
        endTime: existing.endTime.getTime() <= alert.endTime.getTime() ? existing.endTime : alert.endTime,
        millisRemaining: Math.min(existing.millisRemaining, alert.millisRemaining),
        currentBid: existing.currentBid ?? alert.currentBid,
        lotPrice: existing.lotPrice ?? alert.lotPrice,
        sources: Array.from(combinedSources),
      });
    };

    for (const alert of watchlistAlerts) {
      addAlert(alert);
    }
    for (const alert of bidAlerts) {
      addAlert(alert);
    }

    return Array.from(merged.values()).sort((a, b) => a.endTime.getTime() - b.endTime.getTime());
  }

  getAlertConfig(): { windowHours: number; graceMinutes: number } {
    return {
      windowHours: this.getAlertWindowHours(),
      graceMinutes: this.getAlertGraceMinutes(),
    };
  }

  private async analyzeItem(item: WatchlistItem): Promise<ProfitabilityResult> {
    const auctionId = item.auction_id || 'unknown';
    const msrpTotal = item.manifest_summary?.msrp_total ?? item.msrp_value ?? 0;
    const baseCost = this.getCostBasis(item);
    const inboundShipping = item.shipping_cost_value ?? 0;
    const laborCost = this.getLaborCost(item);
    const warehouseCost = this.getWarehouseCost();
    const estimatedResaleValue = msrpTotal ? msrpTotal * 0.5 : 0;
    const outboundShipping = this.getOutboundShippingCost(estimatedResaleValue);
    const marketplaceFees = this.getMarketplaceFees(estimatedResaleValue);
    const costBasis = (baseCost || 0) + inboundShipping + laborCost + warehouseCost + outboundShipping + marketplaceFees;
    const estimatedProfit = estimatedResaleValue - costBasis;
    const estimatedMargin = costBasis ? estimatedProfit / costBasis : 0;

    const minMargin = this.getMinMargin();
    const ruleDecision: Decision =
      costBasis && estimatedResaleValue > 0 && estimatedMargin >= minMargin ? 'PASS' : 'FAIL';

    let aiDecision: Decision | undefined;
    let aiConfidence: string | undefined;
    let aiSummary: string | undefined;

    const llm = await this.requestLlmDecision(item, {
      costBasis,
      msrpTotal,
      estimatedResaleValue,
      estimatedProfit,
      estimatedMargin,
    });

    if (llm) {
      aiDecision = llm.decision === 'PASS' ? 'PASS' : 'FAIL';
      aiConfidence = llm.confidence;
      aiSummary = [llm.rationale, llm.comps, llm.risks].filter(Boolean).join(' ');
    }

    const decision: Decision = aiDecision || ruleDecision;

    return {
      auctionId,
      title: item.title,
      decision,
      ruleDecision,
      aiDecision,
      aiConfidence,
      aiSummary,
      estimatedResaleValue: this.roundMoney(estimatedResaleValue),
      estimatedProfit: this.roundMoney(estimatedProfit),
      estimatedMargin: this.roundPercent(estimatedMargin),
      costBasis: this.roundMoney(costBasis || 0),
      msrpTotal: this.roundMoney(msrpTotal),
      inboundShipping: this.roundMoney(inboundShipping),
      outboundShipping: this.roundMoney(outboundShipping),
      marketplaceFees: this.roundMoney(marketplaceFees),
      laborCost: this.roundMoney(laborCost),
      warehouseCost: this.roundMoney(warehouseCost),
    };
  }

  private getCostBasis(item: WatchlistItem): number | null {
    if (item.current_bid_value && item.current_bid_value > 0) {
      return item.current_bid_value;
    }
    if (item.lot_price_value && item.lot_price_value > 0) {
      return item.lot_price_value;
    }
    return null;
  }

  private getMinMargin(): number {
    const raw = process.env.TECHLIQUIDATORS_MIN_MARGIN;
    if (!raw) {
      return 0.2;
    }
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) ? value : 0.2;
  }

  private getMarketplaceFees(resaleValue: number): number {
    const raw = process.env.TECHLIQUIDATORS_MARKETPLACE_FEE_RATE;
    const rate = raw ? Number.parseFloat(raw) : 0.13;
    if (!Number.isFinite(rate)) {
      return 0;
    }
    return resaleValue * Math.max(rate, 0);
  }

  private getOutboundShippingCost(resaleValue: number): number {
    const raw = process.env.TECHLIQUIDATORS_OUTBOUND_SHIPPING_RATE;
    const rate = raw ? Number.parseFloat(raw) : 0.08;
    if (!Number.isFinite(rate)) {
      return 0;
    }
    return resaleValue * Math.max(rate, 0);
  }

  private getLaborCost(item: WatchlistItem): number {
    const rateRaw = process.env.TECHLIQUIDATORS_LABOR_RATE;
    const minutesRaw = process.env.TECHLIQUIDATORS_MINUTES_PER_UNIT;
    const rate = rateRaw ? Number.parseFloat(rateRaw) : 20;
    const minutes = minutesRaw ? Number.parseFloat(minutesRaw) : 5;
    const units = item.items_count_value || 0;
    if (!Number.isFinite(rate) || !Number.isFinite(minutes) || units <= 0) {
      return 0;
    }
    return (rate / 60) * minutes * units;
  }

  private getWarehouseCost(): number {
    const raw = process.env.TECHLIQUIDATORS_WAREHOUSE_FEE;
    if (!raw) {
      return 0;
    }
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) ? Math.max(value, 0) : 0;
  }

  private getAlertWindowHours(): number {
    const raw = process.env.TECHLIQUIDATORS_ALERT_WINDOW_HOURS;
    if (!raw) {
      return 6;
    }
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) ? value : 6;
  }

  private getAlertGraceMinutes(): number {
    const raw = process.env.TECHLIQUIDATORS_ALERT_GRACE_MINUTES;
    if (!raw) {
      return 30;
    }
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) ? value : 30;
  }

  private parseAuctionEnd(value: unknown, now: Date): Date | null {
    if (!value) {
      return null;
    }
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || value <= 0) {
        return null;
      }
      const millis = value < 10_000_000_000 ? value * 1000 : value;
      const parsed = new Date(millis);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) {
        return null;
      }
      const numeric = Number.parseFloat(trimmed);
      if (Number.isFinite(numeric) && numeric > 0 && trimmed.replace(/[0-9.]/g, '') === '') {
        const millis = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
        const parsed = new Date(millis);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
      }
      const relativeMs = this.parseRelativeDuration(trimmed);
      if (relativeMs !== null) {
        return new Date(now.getTime() + relativeMs);
      }
      const parsed = new Date(trimmed);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    return null;
  }

  private parseRelativeDuration(value: string): number | null {
    const normalized = value.toLowerCase();
    const matches = normalized.matchAll(
      /(\d+)\s*(d|day|days|h|hr|hrs|hour|hours|m|min|mins|minute|minutes)/g
    );
    let totalMs = 0;
    let matched = false;
    for (const match of matches) {
      matched = true;
      const amount = Number.parseInt(match[1], 10);
      if (!Number.isFinite(amount)) {
        continue;
      }
      const unit = match[2];
      if (unit.startsWith('d')) {
        totalMs += amount * 24 * 60 * 60 * 1000;
      } else if (unit.startsWith('h')) {
        totalMs += amount * 60 * 60 * 1000;
      } else {
        totalMs += amount * 60 * 1000;
      }
    }
    if (matched && totalMs > 0) {
      return totalMs;
    }

    const compact = normalized.replace(/[^0-9dhm]/g, '');
    if (compact && /[dhm]/.test(compact)) {
      const compactMatches = compact.matchAll(/(\d+)([dhm])/g);
      totalMs = 0;
      matched = false;
      for (const match of compactMatches) {
        matched = true;
        const amount = Number.parseInt(match[1], 10);
        if (!Number.isFinite(amount)) {
          continue;
        }
        const unit = match[2];
        if (unit === 'd') {
          totalMs += amount * 24 * 60 * 60 * 1000;
        } else if (unit === 'h') {
          totalMs += amount * 60 * 60 * 1000;
        } else {
          totalMs += amount * 60 * 1000;
        }
      }
      if (matched && totalMs > 0) {
        return totalMs;
      }
    }

    return null;
  }

  private getAlertsFromItems(
    items: Array<{
      auction_id?: string;
      auction_end?: string;
      title?: string;
      url?: string;
      current_bid_value?: number;
      lot_price_value?: number;
    }>,
    source: AlertSource,
    options?: {
      windowHours?: number;
      graceMinutes?: number;
      now?: Date;
    }
  ): WatchlistAlert[] {
    const now = options?.now ?? new Date();
    const windowHours = options?.windowHours ?? this.getAlertWindowHours();
    const graceMinutes = options?.graceMinutes ?? this.getAlertGraceMinutes();
    const windowMs = Math.max(windowHours, 0) * 60 * 60 * 1000;
    const graceMs = Math.max(graceMinutes, 0) * 60 * 1000;

    const alerts: WatchlistAlert[] = [];
    for (const item of items) {
      const endTime = this.parseAuctionEnd(item.auction_end, now);
      if (!endTime) {
        continue;
      }
      const millisRemaining = endTime.getTime() - now.getTime();
      if (millisRemaining <= windowMs && millisRemaining >= -graceMs) {
        alerts.push({
          auctionId: item.auction_id || 'unknown',
          title: item.title,
          url: item.url,
          endTime,
          millisRemaining,
          currentBid: item.current_bid_value,
          lotPrice: item.lot_price_value,
          sources: [source],
        });
      }
    }

    return alerts.sort((a, b) => a.endTime.getTime() - b.endTime.getTime());
  }

  private roundMoney(value: number): number {
    return Math.round(value * 100) / 100;
  }

  private roundPercent(value: number): number {
    return Math.round(value * 1000) / 1000;
  }

  private async requestLlmDecision(
    item: WatchlistItem,
    metrics: {
      costBasis: number | null;
      msrpTotal: number;
      estimatedResaleValue: number;
      estimatedProfit: number;
      estimatedMargin: number;
    }
  ): Promise<LlmDecisionPayload | null> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return null;
    }

    const model = process.env.OPENAI_MODEL || 'gpt-5.2';
    const prompt = [
      'You are a liquidation analyst.',
      'Decide PASS or FAIL based on profitability and resale risk.',
      'Use general market knowledge only; no live browsing.',
      'Base resale value on 50% of MSRP unless data suggests otherwise.',
      'Return JSON with keys: decision, confidence, rationale, comps, risks.',
      '',
      `Listing: ${item.title || ''}`,
      `Auction ID: ${item.auction_id || ''}`,
      `Current Bid: ${metrics.costBasis ?? 'unknown'}`,
      `MSRP Total: ${metrics.msrpTotal || 0}`,
      `Estimated Resale (50% MSRP): ${metrics.estimatedResaleValue || 0}`,
      `Estimated Profit: ${metrics.estimatedProfit || 0}`,
      `Estimated Margin: ${metrics.estimatedMargin || 0}`,
      `Condition: ${item.condition || ''}`,
      `Warehouse: ${item.warehouse || ''}`,
      `Manifest Summary: ${JSON.stringify(item.manifest_summary || {})}`,
    ].join('\n');

    try {
      const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model,
          temperature: 0.2,
          messages: [
            { role: 'system', content: 'Respond with JSON only.' },
            { role: 'user', content: prompt },
          ],
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 20000,
        }
      );

      const content = response.data?.choices?.[0]?.message?.content;
      if (!content) {
        return null;
      }
      return this.extractJson(content);
    } catch {
      return null;
    }
  }

  private extractJson(text: string): LlmDecisionPayload | null {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      return null;
    }
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }

  private async readWatchlist(): Promise<WatchlistPayload | null> {
    try {
      const raw = await fs.readFile(this.watchlistPath, 'utf-8');
      return JSON.parse(raw) as WatchlistPayload;
    } catch {
      return null;
    }
  }

  private async readBids(): Promise<BidsPayload | null> {
    try {
      const raw = await fs.readFile(this.bidsPath, 'utf-8');
      return JSON.parse(raw) as BidsPayload;
    } catch {
      return null;
    }
  }

  private async loadDotEnv(): Promise<void> {
    const envPath = path.join(process.cwd(), '.env');
    try {
      const content = await fs.readFile(envPath, 'utf-8');
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
          continue;
        }
        const idx = trimmed.indexOf('=');
        if (idx <= 0) {
          continue;
        }
        const key = trimmed.slice(0, idx).trim();
        let value = trimmed.slice(idx + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    } catch {
      // no .env file
    }
  }

  private async isProjectRoot(dir: string): Promise<boolean> {
    const markers = [
      path.join(dir, '01_SOURCING'),
      path.join(dir, '08_AUTOMATION', 'CLI_Tools', 'auction_scraper'),
    ];
    for (const candidate of markers) {
      try {
        const stat = await fs.stat(candidate);
        if (stat.isDirectory()) {
          return true;
        }
      } catch {
        // keep checking
      }
    }
    return false;
  }

  private async findProjectRoot(start: string): Promise<string | null> {
    const roots = [path.resolve(start)];
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    if (!roots.includes(moduleDir)) {
      roots.push(moduleDir);
    }

    for (const root of roots) {
      let current = root;
      while (true) {
        if (await this.isProjectRoot(current)) {
          return current;
        }
        const parent = path.dirname(current);
        if (parent === current) {
          break;
        }
        current = parent;
      }
    }
    return null;
  }
}
