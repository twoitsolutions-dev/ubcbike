/**
 * Lightspeed Retail **R-Series** (formerly Lightspeed Retail / MerchantOS) client.
 * NOT X-Series (Vend) — different API, auth and data model.
 *
 * Read-only by default. POS price writes are disabled unless explicitly enabled
 * (`posEventWritesEnabled: true`) for authorised omnichannel events (e.g. Black Friday,
 * Christmas). OAuth endpoints and base URL are configurable because public sources
 * disagree on the token URL; confirm them in the official R-Series developer docs
 * during app registration:
 *   LIGHTSPEED_R_TOKEN_URL  (default https://cloud.lightspeedapp.com/auth/oauth/token)
 *   LIGHTSPEED_R_API_BASE   (default https://api.lightspeedapp.com/API/V3)
 * Account ID is resolved from GET /Account.json after the token exchange.
 */
import { NotConfiguredError, RetryableError, WritesDisabledError, type ConnectorHealth } from '../types.js';

export interface LightspeedTokenVaultState {
  clientId?: string | null;
  clientSecret?: string | null;
  refreshToken: string;
  accountId?: string | null;
  accessToken?: string | null;
  expiresAt?: string | null;
}

export interface LightspeedRConfig {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  accountId?: string;
  tokenUrl?: string;
  apiBase?: string;
  /** Opt-in gate: only enabled when UBC authorises POS price parity for major events (Black Friday, Christmas, etc.). */
  posEventWritesEnabled?: boolean;
  fetchImpl?: typeof fetch;
  /** Optional server-side vault callbacks to persist rotating refresh tokens across restarts & workers. */
  loadTokenState?: () => Promise<LightspeedTokenVaultState | null>;
  saveTokenState?: (state: LightspeedTokenVaultState) => Promise<void>;
  /**
   * Cross-process mutex around the refresh. Lightspeed rotates the refresh token on every use and
   * revokes the whole grant when an old one is reused, so two server processes (Hostinger runs
   * several) must never refresh at the same time. Implemented with a Postgres advisory lock.
   */
  refreshLock?: <T>(fn: () => Promise<T>) => Promise<T>;
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
  /** Lightspeed "System ID" (e.g. 210000000283) — the Hub's System SKU. */
  systemSku?: string;
  /** Not used by the Hub (Carlos: do not map Custom SKU). */
  customSku?: string;
  manufacturerSku?: string;
  defaultCost?: string;
  avgCost?: string;
  itemMatrixID?: string;
  manufacturerID?: string;
  categoryID?: string;
  archived?: string | boolean;
  timeStamp?: string;
  Prices?: { ItemPrice: { amount: string; useType: string } | { amount: string; useType: string }[] };
  ItemShops?: { ItemShop: { shopID: string; qoh: string; reorderPoint?: string } | { shopID: string; qoh: string }[] };
  Manufacturer?: { manufacturerID?: string; name?: string };
  Category?: { categoryID?: string; name?: string; fullPathName?: string };
  ItemAttributes?: { attribute1?: string; attribute2?: string; attribute3?: string; itemAttributeSetID?: string };
}

/**
 * Matrix option values of one item, named with its attribute set (e.g. { Color: "white", Size: "XL" }).
 * Unknown sets fall back to "Option 1/2/3"; empty attributes are skipped.
 */
export function lsOptionValues(
  attrs: LsItem['ItemAttributes'] | undefined,
  setNames?: Map<string, [string, string, string]>,
): Record<string, string> {
  if (!attrs) return {};
  const names = (attrs.itemAttributeSetID && setNames?.get(attrs.itemAttributeSetID)) || ['', '', ''];
  const out: Record<string, string> = {};
  [attrs.attribute1, attrs.attribute2, attrs.attribute3].forEach((raw, i) => {
    const v = (raw ?? '').trim();
    if (!v) return;
    const name = names[i]?.trim() || `Option ${i + 1}`;
    out[name] = v;
  });
  return out;
}

/** Strip trailing matrix option values from an item description ("sun arm sleeves white XL" → "sun arm sleeves"). */
export function lsMatrixBaseTitle(description: string, optionValues: Record<string, string>): string {
  let t = (description ?? '').trim();
  const vals = Object.values(optionValues).map((v) => v.trim()).filter(Boolean);
  for (let pass = 0; pass < vals.length; pass++) {
    for (const v of vals) {
      const esc = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      t = t.replace(new RegExp(`[\\s\\-–—/,]+${esc}\\s*$`, 'i'), '').trim();
    }
  }
  return t || (description ?? '').trim();
}

export class LightspeedRClient {
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;
  private currentRefreshToken: string | undefined;
  private currentClientId: string | undefined;
  private currentClientSecret: string | undefined;
  private currentAccountId: string | undefined;
  private vaultHydrated = false;
  private readonly fetchImpl: typeof fetch;
  private readonly tokenUrl: string;
  private readonly apiBase: string;

  constructor(private readonly cfg: LightspeedRConfig) {
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.tokenUrl = cfg.tokenUrl || LS_DEFAULTS.tokenUrl;
    this.apiBase = cfg.apiBase || LS_DEFAULTS.apiBase;
    this.currentClientId = cfg.clientId;
    this.currentClientSecret = cfg.clientSecret;
    this.currentRefreshToken = cfg.refreshToken;
    this.currentAccountId = cfg.accountId;
  }

  async ensureConfigured(): Promise<void> {
    if (this.vaultHydrated || !this.cfg.loadTokenState) return;
    this.vaultHydrated = true;
    try {
      const st = await this.cfg.loadTokenState();
      if (st) {
        if (st.clientId) this.currentClientId = st.clientId;
        if (st.clientSecret) this.currentClientSecret = st.clientSecret;
        if (st.refreshToken) this.currentRefreshToken = st.refreshToken;
        if (st.accountId) this.currentAccountId = st.accountId;
        if (st.accessToken && st.expiresAt && new Date(st.expiresAt).getTime() > Date.now() + 60_000) {
          this.accessToken = st.accessToken;
          this.tokenExpiresAt = new Date(st.expiresAt).getTime();
        }
      }
    } catch {
      // Ignore if migration 006 has not run yet
    }
  }

  missing(): string[] {
    const m: string[] = [];
    if (!this.currentClientId) m.push('LIGHTSPEED_R_CLIENT_ID');
    if (!this.currentClientSecret) m.push('LIGHTSPEED_R_CLIENT_SECRET');
    if (!this.currentRefreshToken) m.push('LIGHTSPEED_R_REFRESH_TOKEN (from the OAuth authorisation by UBC)');
    if (!this.currentAccountId) m.push('LIGHTSPEED_R_ACCOUNT_ID');
    return m;
  }

  async health(): Promise<ConnectorHealth> {
    await this.ensureConfigured();
    const missing = this.missing();
    const writesEnabled = !!this.cfg.posEventWritesEnabled;
    const base = { system: 'lightspeed_r' as const, checkedAt: new Date().toISOString(), writesEnabled };
    if (missing.length) return { ...base, status: 'not_connected', detail: 'Lightspeed R-Series ready to connect — awaiting OAuth authorisation', missing };
    try {
      await this.get('/Account.json');
      const modeLabel = writesEnabled ? 'POS event price sync enabled' : 'read-only; POS event writes disabled';
      return { ...base, status: 'connected', detail: `Authenticated (account ${this.currentAccountId}, ${modeLabel})`, missing: [] };
    } catch (e) {
      return { ...base, status: 'error', detail: (e as Error).message, missing: [] };
    }
  }

  /**
   * Re-read the shared vault. Lightspeed rotates the refresh token on every exchange, so another
   * process (the Hostinger server, the worker, or a CLI script) may already hold the newer one.
   * Returns true when the vault had a still-valid access token we can reuse without refreshing.
   */
  private async reloadFromVault(): Promise<boolean> {
    if (!this.cfg.loadTokenState) return false;
    try {
      const st = await this.cfg.loadTokenState();
      if (!st) return false;
      if (st.refreshToken) this.currentRefreshToken = st.refreshToken;
      if (st.accountId) this.currentAccountId = st.accountId;
      if (st.accessToken && st.expiresAt && new Date(st.expiresAt).getTime() > Date.now() + 60_000) {
        this.accessToken = st.accessToken;
        this.tokenExpiresAt = new Date(st.expiresAt).getTime();
        return true;
      }
    } catch {
      // vault unavailable (migration 006 missing) — fall through to the in-memory token
    }
    return false;
  }

  private async token(): Promise<string> {
    await this.ensureConfigured();
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) return this.accessToken;
    // Another process may have refreshed already: reuse its token instead of burning a stale refresh token.
    if (await this.reloadFromVault()) return this.accessToken!;
    if (this.cfg.refreshLock) {
      // Only one process refreshes; the others wait, then pick up the freshly saved token.
      return this.cfg.refreshLock(async () => {
        if (await this.reloadFromVault()) return this.accessToken!;
        return this.refreshAccessToken();
      });
    }
    try {
      return await this.refreshAccessToken();
    } catch (err) {
      // Our refresh token was rotated by someone else between the read and the exchange: re-read once and retry.
      if (!/token refresh failed: HTTP 4\d\d/.test((err as Error).message)) throw err;
      const before = this.currentRefreshToken;
      await sleep(1500); // let the winning process finish saving its rotated token
      if (await this.reloadFromVault()) return this.accessToken!;
      if (this.currentRefreshToken && this.currentRefreshToken !== before) return this.refreshAccessToken();
      throw err;
    }
  }

  private async refreshAccessToken(): Promise<string> {
    const missing = this.missing();
    if (missing.length) throw new NotConfiguredError('Lightspeed R-Series', missing);
    const res = await this.fetchImpl(this.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.currentRefreshToken!,
        client_id: this.currentClientId!,
        client_secret: this.currentClientSecret!,
      }).toString(),
    });
    if (!res.ok) throw new Error(`Lightspeed token refresh failed: HTTP ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in: number; refresh_token?: string };
    this.accessToken = body.access_token;
    this.tokenExpiresAt = Date.now() + (body.expires_in || 1800) * 1000;
    // Lightspeed V3 Auth Server rotates refresh_token on every exchange — capture & persist immediately!
    if (body.refresh_token) {
      this.currentRefreshToken = body.refresh_token;
    }
    if (this.cfg.saveTokenState && this.currentRefreshToken) {
      await this.cfg.saveTokenState({
        clientId: this.currentClientId ?? null,
        clientSecret: this.currentClientSecret ?? null,
        refreshToken: this.currentRefreshToken,
        accountId: this.currentAccountId ?? null,
        accessToken: this.accessToken,
        expiresAt: new Date(this.tokenExpiresAt).toISOString(),
      }).catch(() => {});
    }
    return this.accessToken;
  }

  /** GET relative to /Account/{id} (or absolute "next" URLs from pagination). */
  async get<T = unknown>(pathOrUrl: string, attempt = 0): Promise<T> {
    await this.ensureConfigured();
    const url = pathOrUrl.startsWith('http')
      ? pathOrUrl
      : pathOrUrl === '/Account.json'
        ? `${this.apiBase}/Account.json`
        : `${this.apiBase}/Account/${this.currentAccountId}${pathOrUrl}`;
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

  /** Iterate active Items with cursor pagination (`@attributes.next`), including prices, brand, category & shop quantities. */
  async *iterateItems(sinceTimestamp?: string): AsyncGenerator<LsItem[]> {
    const params = new URLSearchParams({
      archived: 'false',
      // ItemAttributes = matrix option values (e.g. Color "white", Size "XL") of each size/color item.
      load_relations: '["ItemShops","Category","Manufacturer","ItemAttributes"]',
      limit: '100',
    });
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

  /**
   * Read-only iteration of Lightspeed R-Series `SpecialOrder` records (`/SpecialOrder.json`).
   * Used to detect when Carlos links an item to a vendor PO (`ordered`) or when UBC reception
   * scans the PO check-in (`ready` / `completed`) without writing to Lightspeed POS.
   */
  async *iterateSpecialOrders(sinceTimestamp?: string): AsyncGenerator<LsSpecialOrder[]> {
    // No load_relations: R-Series rejects "Note" on SpecialOrder with HTTP 400 (InvalidQueryException).
    // With the current read-only inventory scope this endpoint answers 403, which the job treats as "skipped".
    const params = new URLSearchParams({ limit: '100' });
    if (sinceTimestamp) params.set('timeStamp', `>,${sinceTimestamp}`);
    let next: string | null = `/SpecialOrder.json?${params.toString()}`;
    while (next) {
      type Page = { '@attributes'?: { next?: string }; SpecialOrder?: LsSpecialOrder | LsSpecialOrder[] };
      const page: Page = await this.get<Page>(next);
      const rows = page.SpecialOrder ? (Array.isArray(page.SpecialOrder) ? page.SpecialOrder : [page.SpecialOrder]) : [];
      if (rows.length) yield rows;
      next = page['@attributes']?.next || null;
    }
  }

  /** Attribute set names per `itemAttributeSetID` (e.g. "1" → ["Color","Size",""]). Read-only. */
  async listItemAttributeSets(): Promise<Map<string, [string, string, string]>> {
    type Row = { itemAttributeSetID: string; attributeName1?: string; attributeName2?: string; attributeName3?: string };
    const page = await this.get<{ ItemAttributeSet?: Row | Row[] }>('/ItemAttributeSet.json?limit=100');
    const rows = page.ItemAttributeSet ? ([] as Row[]).concat(page.ItemAttributeSet) : [];
    return new Map(rows.map((r) => [r.itemAttributeSetID, [r.attributeName1 ?? '', r.attributeName2 ?? '', r.attributeName3 ?? '']]));
  }

  /** Generic writes remain disabled unless explicitly routed through authorised POS event price sync. */
  async put(): Promise<never> {
    throw new WritesDisabledError('Lightspeed R-Series');
  }

  /**
   * Ready-to-connect POS price update exclusively for special omnichannel events
   * (e.g. Black Friday, Christmas) when `LIGHTSPEED_R_POS_EVENT_WRITES_ENABLED=true`.
   * Respects R-Series leaky bucket (`X-LS-API-Bucket-Level`).
   */
  async updateEventPosPrices(updates: { lightspeedItemId: string; priceCents: number }[]): Promise<void> {
    if (!this.cfg.posEventWritesEnabled) throw new WritesDisabledError('Lightspeed R-Series');
    await this.ensureConfigured();
    for (const u of updates) {
      const url = `${this.apiBase}/Account/${this.currentAccountId}/Item/${encodeURIComponent(u.lightspeedItemId)}.json`;
      const amount = (u.priceCents / 100).toFixed(2);
      const res = await this.fetchImpl(url, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${await this.token()}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ Prices: { ItemPrice: [{ amount, useType: 'Default', useTypeID: '1' }] } }),
      });
      if (res.status === 429 || res.status === 503) {
        const retry = Number(res.headers.get('Retry-After') ?? '2') * 1000;
        await sleep(retry);
        throw new RetryableError(`Lightspeed HTTP ${res.status} while updating POS event price`, retry);
      }
      if (!res.ok) throw new Error(`Lightspeed HTTP ${res.status} updating item ${u.lightspeedItemId}`);
      const bucket = res.headers.get('X-LS-API-Bucket-Level');
      if (bucket) {
        const [lvl, max] = bucket.split('/').map(Number);
        if (lvl !== undefined && max && lvl / max > 0.75) await sleep(1100);
      }
    }
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Map an R-Series Item into the fields our catalog tracks (`Default` = regular price, `SALE PRICE` = sale price when < Default). */
export function mapLsItem(item: LsItem, physicalShopIds?: string[]) {
  const prices = item.Prices ? ([] as { amount: string; useType: string }[]).concat(item.Prices.ItemPrice) : [];
  const def = prices.find((p) => p.useType === 'Default') ?? prices[0];
  const sale = prices.find((p) => /^sale/i.test(p.useType));
  const msrp = prices.find((p) => p.useType === 'MSRP');
  const shops = item.ItemShops ? ([] as { shopID: string; qoh: string }[]).concat(item.ItemShops.ItemShop) : [];
  // shopID "0" is the synthetic account-wide total row in R-Series; we only count real physical shops (e.g. "1" Tampa, "2" Alafia).
  const shopQuantities: Record<string, number> = {};
  for (const s of shops) {
    if (!s.shopID || s.shopID === '0') continue;
    shopQuantities[s.shopID] = (shopQuantities[s.shopID] ?? 0) + Math.max(0, Math.floor(Number(s.qoh) || 0));
  }
  const qty = Object.entries(shopQuantities)
    .filter(([sid]) => !physicalShopIds || physicalShopIds.includes(sid))
    .reduce((n, [, q]) => n + q, 0);

  const toPositiveCents = (v?: string) => {
    if (v === undefined || v === '') return null;
    const n = Math.round(Number(v) * 100);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const defaultPriceCents = toPositiveCents(def?.amount) ?? toPositiveCents(msrp?.amount);
  const rawSaleCents = toPositiveCents(sale?.amount);
  const hasActiveSale = rawSaleCents !== null && defaultPriceCents !== null && rawSaleCents < defaultPriceCents;
  const priceCents = hasActiveSale ? rawSaleCents : defaultPriceCents;
  const compareAtCents = hasActiveSale ? defaultPriceCents : null;

  const rawMfg = item.Manufacturer?.name?.trim() ?? '';
  const brand = rawMfg && !/^(none|unknown|n\/a|-+)$/i.test(rawMfg) ? rawMfg : null;
  const rawCategory = item.Category?.fullPathName?.trim() || item.Category?.name?.trim() || null;

  return {
    lightspeedItemId: item.itemID,
    title: item.description,
    brand,
    rawCategory,
    upc: item.upc || item.ean || null,
    // Hub System SKU = Lightspeed System ID (systemSku). Custom SKU is intentionally not mapped.
    sku: item.systemSku || null,
    mpn: item.manufacturerSku || null,
    priceCents,
    compareAtCents,
    defaultPriceCents,
    salePriceCents: hasActiveSale ? rawSaleCents : null,
    // $0.00 defaultCost/avgCost in Lightspeed means no cost on file (e.g. USED bikes, labor, uncosted items) -> null so margin floors protect them!
    costCents: toPositiveCents(item.defaultCost) ?? toPositiveCents(item.avgCost),
    msrpCents: toPositiveCents(msrp?.amount),
    physicalQty: qty,
    shopQuantities,
    matrixId: item.itemMatrixID && item.itemMatrixID !== '0' ? item.itemMatrixID : null,
    itemAttributes: item.ItemAttributes ?? null,
    updatedAt: item.timeStamp ?? null,
  };
}

export interface LsSpecialOrder {
  specialOrderID: string;
  status?: string;
  unitQuantity?: string;
  receivedQuantity?: string;
  completed?: string | boolean;
  contacted?: string | boolean;
  customerID?: string;
  orderID?: string;
  saleLineID?: string;
  itemID?: string;
  shopID?: string;
  timeStamp?: string;
  Note?: { note?: string };
  SaleLine?: { itemID?: string; unitQuantity?: string; Sale?: { referenceNumber?: string } };
}

/** Extract normalized SpecialOrder lifecycle & explicit Shopify #Order reference (when present). */
export function mapLsSpecialOrder(so: LsSpecialOrder) {
  const rawStatus = (so.status || '').toLowerCase();
  const isDone = so.completed === true || so.completed === 'true';
  let status: 'not_ordered' | 'ordered' | 'ready' | 'completed' | 'cancelled' = 'not_ordered';
  if (rawStatus.includes('cancel')) status = 'cancelled';
  else if (isDone || rawStatus === 'completed' || rawStatus === 'picked_up') status = 'completed';
  else if (rawStatus === 'ready' || rawStatus === 'in_stock' || Number(so.receivedQuantity || 0) > 0) status = 'ready';
  else if (rawStatus === 'ordered' || (so.orderID && so.orderID !== '0')) status = 'ordered';

  const noteText = [so.Note?.note, so.SaleLine?.Sale?.referenceNumber].filter(Boolean).join(' ');
  const refMatch = noteText.match(/(?:shopify\s*)?#([A-Z0-9-]{3,24})/i);
  const qtyOrdered = Math.max(0, Number(so.unitQuantity ?? so.SaleLine?.unitQuantity ?? 0) || 0);
  const qtyReady = status === 'ready' || status === 'completed'
    ? Math.max(qtyOrdered, Number(so.receivedQuantity || 0) || qtyOrdered)
    : Math.max(0, Number(so.receivedQuantity || 0) || 0);

  return {
    specialOrderId: so.specialOrderID,
    lightspeedItemId: so.itemID || so.SaleLine?.itemID || null,
    lightspeedPoId: so.orderID && so.orderID !== '0' ? so.orderID : null,
    customerId: so.customerID && so.customerID !== '0' ? so.customerID : null,
    status,
    qtyOrdered,
    qtyReady,
    referenceOrderNumber: refMatch ? `#${refMatch[1]!.toUpperCase()}` : null,
    updatedAt: so.timeStamp ?? null,
  };
}
