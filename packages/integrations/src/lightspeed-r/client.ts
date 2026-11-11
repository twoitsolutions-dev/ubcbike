/**
 * Lightspeed Retail **R-Series** (formerly Lightspeed Retail / MerchantOS) client.
 * NOT X-Series (Vend) — different API, auth and data model.
 *
 * Read-only by design in this phase. OAuth endpoints and base URL are
 * configurable because public sources disagree on the token URL; confirm
 * them in the official R-Series developer docs during app registration:
 *   LIGHTSPEED_R_TOKEN_URL  (default https://cloud.lightspeedapp.com/auth/oauth/token)
 *   LIGHTSPEED_R_API_BASE   (default https://api.lightspeedapp.com/API/V3)
 * Account ID is resolved from GET /Account.json after the token exchange.
 */
import { NotConfiguredError, RetryableError, WritesDisabledError, type ConnectorHealth } from '../types.js';

export interface LightspeedRConfig {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  accountId?: string;
  tokenUrl?: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
}

export const LS_DEFAULTS = {
  tokenUrl: 'https://cloud.lightspeedapp.com/auth/oauth/token',
  apiBase: 'https://api.lightspeedapp.com/API/V3',
};

export interface LsItem {
  itemID: string;
  description: string;
  upc?: string;
  ean?: string;
  customSku?: string;
  manufacturerSku?: string;
  defaultCost?: string;
  avgCost?: string;
  itemMatrixID?: string;
  manufacturerID?: string;
  categoryID?: string;
  timeStamp?: string;
  Prices?: { ItemPrice: { amount: string; useType: string } | { amount: string; useType: string }[] };
  ItemShops?: { ItemShop: { shopID: string; qoh: string; reorderPoint?: string } | { shopID: string; qoh: string }[] };
}

export class LightspeedRClient {
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;
  private readonly fetchImpl: typeof fetch;
  private readonly tokenUrl: string;
  private readonly apiBase: string;

  constructor(private readonly cfg: LightspeedRConfig) {
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.tokenUrl = cfg.tokenUrl || LS_DEFAULTS.tokenUrl;
    this.apiBase = cfg.apiBase || LS_DEFAULTS.apiBase;
  }

  missing(): string[] {
    const m: string[] = [];
    if (!this.cfg.clientId) m.push('LIGHTSPEED_R_CLIENT_ID');
    if (!this.cfg.clientSecret) m.push('LIGHTSPEED_R_CLIENT_SECRET');
    if (!this.cfg.refreshToken) m.push('LIGHTSPEED_R_REFRESH_TOKEN (from the OAuth authorisation by UBC)');
    if (!this.cfg.accountId) m.push('LIGHTSPEED_R_ACCOUNT_ID');
    return m;
  }

  async health(): Promise<ConnectorHealth> {
    const missing = this.missing();
    const base = { system: 'lightspeed_r' as const, checkedAt: new Date().toISOString(), writesEnabled: false };
    if (missing.length) return { ...base, status: 'not_connected', detail: 'Lightspeed R-Series app not authorised yet', missing };
    try {
      await this.get('/Account.json');
      return { ...base, status: 'connected', detail: `Authenticated (account ${this.cfg.accountId}, read-only)`, missing: [] };
    } catch (e) {
      return { ...base, status: 'error', detail: (e as Error).message, missing: [] };
    }
  }

  private async token(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) return this.accessToken;
    const missing = this.missing();
    if (missing.length) throw new NotConfiguredError('Lightspeed R-Series', missing);
    const res = await this.fetchImpl(this.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.cfg.refreshToken!,
        client_id: this.cfg.clientId!,
        client_secret: this.cfg.clientSecret!,
      }).toString(),
    });
    if (!res.ok) throw new Error(`Lightspeed token refresh failed: HTTP ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.accessToken = body.access_token;
    this.tokenExpiresAt = Date.now() + body.expires_in * 1000;
    return this.accessToken;
  }

  /** GET relative to /Account/{id} (or absolute "next" URLs from pagination). */
  async get<T = unknown>(pathOrUrl: string, attempt = 0): Promise<T> {
    const url = pathOrUrl.startsWith('http')
      ? pathOrUrl
      : pathOrUrl === '/Account.json'
        ? `${this.apiBase}/Account.json`
        : `${this.apiBase}/Account/${this.cfg.accountId}${pathOrUrl}`;
    const res = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${await this.token()}`, Accept: 'application/json' } });
    // Leaky-bucket rate limiting: back off on 429 and when the bucket is nearly full.
    if (res.status === 429 || res.status === 503) {
      const retry = Number(res.headers.get('Retry-After') ?? '2') * 1000;
      if (attempt < 5) {
        await sleep(retry);
        return this.get<T>(pathOrUrl, attempt + 1);
      }
      throw new RetryableError(`Lightspeed HTTP ${res.status}`, retry);
    }
    if (!res.ok) throw new Error(`Lightspeed HTTP ${res.status} on ${url.replace(/\?.*/, '')}`);
    const bucket = res.headers.get('X-LS-API-Bucket-Level'); // e.g. "45/60"
    if (bucket) {
      const [lvl, max] = bucket.split('/').map(Number);
      if (lvl !== undefined && max && lvl / max > 0.8) await sleep(1000);
    }
    return (await res.json()) as T;
  }

  /** Iterate Items with cursor pagination (`@attributes.next`), including prices and shop quantities. */
  async *iterateItems(sinceTimestamp?: string): AsyncGenerator<LsItem[]> {
    const params = new URLSearchParams({ load_relations: '["ItemShops"]', limit: '100' });
    if (sinceTimestamp) params.set('timeStamp', `>,${sinceTimestamp}`);
    let next: string | null = `/Item.json?${params.toString()}`;
    while (next) {
      type Page = { '@attributes'?: { next?: string }; Item?: LsItem | LsItem[] };
      const page: Page = await this.get<Page>(next);
      const items = page.Item ? (Array.isArray(page.Item) ? page.Item : [page.Item]) : [];
      if (items.length) yield items;
      next = page['@attributes']?.next || null;
    }
  }

  /** Writes are intentionally unavailable in this phase. */
  async put(): Promise<never> {
    throw new WritesDisabledError('Lightspeed R-Series');
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Map an R-Series Item into the fields our catalog tracks. */
export function mapLsItem(item: LsItem, physicalShopIds?: string[]) {
  const prices = item.Prices ? ([] as { amount: string; useType: string }[]).concat(item.Prices.ItemPrice) : [];
  const def = prices.find((p) => p.useType === 'Default') ?? prices[0];
  const shops = item.ItemShops ? ([] as { shopID: string; qoh: string }[]).concat(item.ItemShops.ItemShop) : [];
  // shopID "0" is the account-wide total row in R-Series; we only count real shops.
  const qty = shops
    .filter((s) => s.shopID !== '0' && (!physicalShopIds || physicalShopIds.includes(s.shopID)))
    .reduce((n, s) => n + Math.max(0, Number(s.qoh) || 0), 0);
  const toCents = (v?: string) => (v === undefined || v === '' ? null : Math.round(Number(v) * 100));
  return {
    lightspeedItemId: item.itemID,
    title: item.description,
    upc: item.upc || item.ean || null,
    sku: item.customSku || null,
    mpn: item.manufacturerSku || null,
    priceCents: toCents(def?.amount),
    costCents: toCents(item.defaultCost) ?? toCents(item.avgCost),
    physicalQty: qty,
    matrixId: item.itemMatrixID && item.itemMatrixID !== '0' ? item.itemMatrixID : null,
    updatedAt: item.timeStamp ?? null,
  };
}
