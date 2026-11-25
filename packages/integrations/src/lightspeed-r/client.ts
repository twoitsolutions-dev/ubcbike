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
  /** Opt-in gate: only enabled when UBC authorises HUB Bulk Sheet writes (`LIGHTSPEED_WRITES_ENABLED=true`). */
  writesEnabled?: boolean;
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
  createTime?: string;
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
  private refreshPromise: Promise<string> | null = null;
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

  private isMissingVaultError(err: unknown): boolean {
    const code = (err as { code?: string } | null)?.code;
    const msg = (err as { message?: string } | null)?.message ?? '';
    return code === '42P01' || /relation .*integration_oauth_tokens.* does not exist/i.test(msg);
  }

  async ensureConfigured(): Promise<void> {
    if (this.vaultHydrated || !this.cfg.loadTokenState) return;
    try {
      const st = await this.cfg.loadTokenState();
      this.vaultHydrated = true;
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
    } catch (err) {
      if (this.isMissingVaultError(err)) {
        this.vaultHydrated = true;
        return;
      }
      throw new RetryableError(`Lightspeed token vault unavailable: ${(err as Error).message}`, 5000);
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
    } catch (err) {
      if (this.isMissingVaultError(err)) return false;
      throw new RetryableError(`Lightspeed token vault unavailable: ${(err as Error).message}`, 5000);
    }
    return false;
  }

  private async token(forceRefresh = false): Promise<string> {
    await this.ensureConfigured();
    if (!forceRefresh && this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) return this.accessToken;
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.runTokenRefresh(forceRefresh).finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async runTokenRefresh(forceRefresh: boolean): Promise<string> {
    const staleAccess = forceRefresh ? this.accessToken : null;
    // Another process may have refreshed already: reuse its token instead of burning a stale refresh token.
    if (await this.reloadFromVault() && (!forceRefresh || (this.accessToken && this.accessToken !== staleAccess))) {
      return this.accessToken!;
    }
    if (this.cfg.refreshLock) {
      // Only one process refreshes; the others wait, then pick up the freshly saved token.
      return this.cfg.refreshLock(async () => {
        if (await this.reloadFromVault() && (!forceRefresh || (this.accessToken && this.accessToken !== staleAccess))) {
          return this.accessToken!;
        }
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

  private async persistTokenState(state: LightspeedTokenVaultState): Promise<void> {
    if (!this.cfg.saveTokenState) return;
    let lastErr: unknown;
    for (const waitMs of [0, 250, 750]) {
      if (waitMs) await sleep(waitMs);
      try {
        await this.cfg.saveTokenState(state);
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    console.error('[lightspeed] CRITICAL: failed to persist rotated refresh_token after 3 attempts:', lastErr);
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
      await this.persistTokenState({
        clientId: this.currentClientId ?? null,
        clientSecret: this.currentClientSecret ?? null,
        refreshToken: this.currentRefreshToken,
        accountId: this.currentAccountId ?? null,
        accessToken: this.accessToken,
        expiresAt: new Date(this.tokenExpiresAt).toISOString(),
      });
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
    // If access token was invalidated early (or rotated by another process), reload/refresh once and retry.
    if (res.status === 401 && attempt === 0) {
      this.accessToken = null;
      this.tokenExpiresAt = 0;
      await this.token(true);
      return this.get<T>(pathOrUrl, attempt + 1);
    }
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

  /** Iterate archived Item IDs (sinceTimestamp optional) so items archived in Lightspeed can be removed/hidden from the Hub. */
  async *iterateArchivedIds(sinceTimestamp?: string): AsyncGenerator<string[]> {
    // R-Series `archived=true` includes active items too; `archived=only` returns ONLY archived items.
    const params = new URLSearchParams({ archived: 'only', limit: '100' });
    if (sinceTimestamp) params.set('timeStamp', `>,${sinceTimestamp}`);
    let next: string | null = `/Item.json?${params.toString()}`;
    while (next) {
      type Page = { '@attributes'?: { next?: string }; Item?: LsItem | LsItem[] };
      const page: Page = await this.get<Page>(next);
      const items = page.Item ? (Array.isArray(page.Item) ? page.Item : [page.Item]) : [];
      const ids = items
        .filter((it) => String(it.archived ?? '').toLowerCase() === 'true')
        .map((it) => it.itemID)
        .filter(Boolean);
      if (ids.length) yield ids;
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

  /**
   * Read-only iteration of completed Lightspeed R-Series sales (`/Sale.json`) with `SaleLines`.
   * Yields `{ itemID, soldAt }` pairs for non-voided sales with positive quantity.
   */
  async *iterateCompletedSales(sinceTimestamp?: string): AsyncGenerator<{ itemID: string; soldAt: string }[]> {
    const params = new URLSearchParams({
      completed: 'true',
      archived: 'false',
      load_relations: '["SaleLines"]',
      limit: '100',
    });
    if (sinceTimestamp) params.set('completeTime', `>=,${sinceTimestamp}`);
    let next: string | null = `/Sale.json?${params.toString()}`;
    while (next) {
      type LsSaleLine = { itemID?: string; unitQuantity?: string };
      type LsSale = {
        voided?: string | boolean;
        completeTime?: string;
        timeStamp?: string;
        SaleLines?: { SaleLine?: LsSaleLine | LsSaleLine[] };
      };
      type Page = { '@attributes'?: { next?: string }; Sale?: LsSale | LsSale[] };
      const page: Page = await this.get<Page>(next);
      const sales = page.Sale ? (Array.isArray(page.Sale) ? page.Sale : [page.Sale]) : [];
      const out: { itemID: string; soldAt: string }[] = [];
      for (const s of sales) {
        if (s.voided === true || s.voided === 'true') continue;
        const soldAt = s.completeTime || s.timeStamp;
        if (!soldAt) continue;
        const rawLines = s.SaleLines?.SaleLine;
        const lines = rawLines ? (Array.isArray(rawLines) ? rawLines : [rawLines]) : [];
        for (const l of lines) {
          const itemID = l.itemID ? String(l.itemID).trim() : '';
          if (!itemID || itemID === '0') continue;
          const qty = Number(l.unitQuantity ?? '1');
          if (!Number.isFinite(qty) || qty <= 0) continue;
          out.push({ itemID, soldAt });
        }
      }
      if (out.length) yield out;
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
   * (e.g. Black Friday, Christmas) when `LIGHTSPEED_R_POS_EVENT_WRITES_ENABLED=true`
   * or Owner/Admin Live Writes are enabled.
   *
   * When `regularPriceCents` is provided:
   *  - Discount (`priceCents < regularPriceCents`): preserves `Default` (`useTypeID: '1'`) at `regularPriceCents`
   *    and sets `SALE PRICE` (`useTypeID: '3'`) to `priceCents` so POS registers ring up the promo price cleanly.
   *  - Restore to regular / price increase (`regularPriceCents === null || priceCents >= regularPriceCents`):
   *    sets `Default` (`useTypeID: '1'`) to `priceCents` and clears `SALE PRICE` (`useTypeID: '3'`) to `'0'`.
   * Respects R-Series leaky bucket (`X-LS-API-Bucket-Level`).
   */
  async updateEventPosPrices(
    updates: { lightspeedItemId: string; priceCents: number; regularPriceCents?: number | null }[],
    opts?: { authorizedByOwner?: boolean },
  ): Promise<void> {
    if (!this.cfg.posEventWritesEnabled && !opts?.authorizedByOwner) throw new WritesDisabledError('Lightspeed R-Series');
    await this.ensureConfigured();
    for (const u of updates) {
      const url = `${this.apiBase}/Account/${this.currentAccountId}/Item/${encodeURIComponent(u.lightspeedItemId)}.json`;
      const amount = (u.priceCents / 100).toFixed(2);
      const itemPrices =
        u.regularPriceCents === undefined
          ? [{ amount, useType: 'Default', useTypeID: '1' }]
          : u.regularPriceCents !== null && u.regularPriceCents > u.priceCents
            ? [
                { amount: (u.regularPriceCents / 100).toFixed(2), useType: 'Default', useTypeID: '1' },
                { amount, useType: 'SALE PRICE', useTypeID: '3' },
              ]
            : [
                { amount, useType: 'Default', useTypeID: '1' },
                { amount: '0', useType: 'SALE PRICE', useTypeID: '3' },
              ];
      const res = await this.fetchImpl(url, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${await this.token()}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ Prices: { ItemPrice: itemPrices } }),
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

  /**
   * Controlled HUB Bulk Sheet write to Lightspeed R-Series (`LIGHTSPEED_WRITES_ENABLED=true`).
   * Reads each item first as a backup snapshot, updates only whitelisted Item fields (`PUT Item/{id}.json`),
   * and updates restock thresholds separately via `PUT ItemShop/{itemShopID}.json`.
   */
  async bulkUpdateItems(
    updates: {
      lightspeedItemId: string;
      description?: string;
      customSku?: string;
      tags?: string[];
      defaultPriceCents?: number;
      msrpCents?: number | null;
      salePriceCents?: number | null;
      onlinePriceCents?: number | null;
      defaultCostCents?: number | null;
      reorderPoint?: number;
      desiredLevel?: number;
      physicalShopId?: string;
    }[],
    opts?: { authorizedByOwner?: boolean },
  ): Promise<{ lightspeedItemId: string; before: Record<string, unknown>; updated: boolean }[]> {
    if (!this.cfg.writesEnabled && !opts?.authorizedByOwner) throw new WritesDisabledError('Lightspeed R-Series');
    await this.ensureConfigured();

    const lsJsonReq = async (method: 'GET' | 'PUT', path: string, body?: unknown): Promise<Record<string, unknown>> => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const res = await this.fetchImpl(`${this.apiBase}/Account/${this.currentAccountId}/${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${await this.token()}`,
            Accept: 'application/json',
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        if (res.status === 429 || res.status === 503) {
          const retry = Number(res.headers.get('Retry-After') ?? '2') * 1000;
          await sleep(retry);
          continue;
        }
        const txt = await res.text();
        if (!res.ok) throw new Error(`Lightspeed ${method} ${path} HTTP ${res.status}: ${txt.slice(0, 300)}`);
        const bucket = res.headers.get('X-LS-API-Bucket-Level');
        if (bucket) {
          const [lvl, max] = bucket.split('/').map(Number);
          if (lvl !== undefined && max && lvl / max > 0.75) await sleep(1100);
        }
        return JSON.parse(txt) as Record<string, unknown>;
      }
      throw new RetryableError(`Lightspeed ${method} ${path} exhausted rate-limit retries`, 2000);
    };

    const escXml = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

    const lsXmlPut = async (path: string, xmlBody: string): Promise<void> => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const res = await this.fetchImpl(`${this.apiBase}/Account/${this.currentAccountId}/${path}`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${await this.token()}`,
            Accept: 'application/json',
            'Content-Type': 'application/xml',
          },
          body: xmlBody,
        });
        if (res.status === 429 || res.status === 503) {
          const retry = Number(res.headers.get('Retry-After') ?? '2') * 1000;
          await sleep(retry);
          continue;
        }
        const txt = await res.text();
        if (!res.ok) throw new Error(`Lightspeed PUT ${path} HTTP ${res.status}: ${txt.slice(0, 300)}`);
        const bucket = res.headers.get('X-LS-API-Bucket-Level');
        if (bucket) {
          const [lvl, max] = bucket.split('/').map(Number);
          if (lvl !== undefined && max && lvl / max > 0.75) await sleep(1100);
        }
        return;
      }
      throw new RetryableError(`Lightspeed PUT ${path} exhausted rate-limit retries`, 2000);
    };

    const results: { lightspeedItemId: string; before: Record<string, unknown>; updated: boolean }[] = [];
    for (const u of updates) {
      const beforeWrap = await lsJsonReq(
        'GET',
        `Item/${encodeURIComponent(u.lightspeedItemId)}.json?load_relations=${encodeURIComponent('["ItemShops","Tags"]')}`,
      );
      const before = (beforeWrap.Item ?? {}) as Record<string, unknown>;
      const putBody: Record<string, unknown> = {};
      if (u.description !== undefined) putBody.description = u.description;
      if (u.customSku !== undefined) putBody.customSku = u.customSku;
      if (u.defaultCostCents !== undefined && u.defaultCostCents !== null) {
        putBody.defaultCost = (u.defaultCostCents / 100).toFixed(2);
      }
      let multiTagsXml: string | null = null;
      if (u.tags !== undefined) {
        const cleanTags = u.tags.map((t) => t.trim()).filter(Boolean);
        // Lightspeed R-Series V3 JSON rejects `{}` AND rejects `{ tag: ["a","b"] }` with HTTP 400
        // "JSON structure is invalid". 0 or 1 tag works in JSON; 2+ tags must be sent via `.xml`
        // as `<Item><Tags><tag>...</tag><tag>...</tag></Tags></Item>`.
        if (cleanTags.length <= 1) {
          putBody.Tags = cleanTags.length === 0 ? { tag: [] } : { tag: cleanTags[0] };
        } else {
          multiTagsXml = `<Item><Tags>${cleanTags.map((t) => `<tag>${escXml(t)}</tag>`).join('')}</Tags></Item>`;
        }
      }

      const hasPriceUpdate =
        u.defaultPriceCents !== undefined ||
        u.msrpCents !== undefined ||
        u.salePriceCents !== undefined ||
        u.onlinePriceCents !== undefined;
      if (hasPriceUpdate) {
        const curPricesRaw = (before.Prices as { ItemPrice?: unknown } | undefined)?.ItemPrice;
        const curPrices = (Array.isArray(curPricesRaw) ? curPricesRaw : curPricesRaw ? [curPricesRaw] : []) as {
          amount: string;
          useTypeID: string;
          useType: string;
        }[];
        const priceOverrides = new Map<string, string>();
        if (u.defaultPriceCents !== undefined) priceOverrides.set('1', (u.defaultPriceCents / 100).toFixed(2));
        if (u.msrpCents !== undefined) priceOverrides.set('2', u.msrpCents === null ? '0' : (u.msrpCents / 100).toFixed(2));
        if (u.salePriceCents !== undefined) priceOverrides.set('3', u.salePriceCents === null ? '0' : (u.salePriceCents / 100).toFixed(2));
        if (u.onlinePriceCents !== undefined) priceOverrides.set('4', u.onlinePriceCents === null ? '0' : (u.onlinePriceCents / 100).toFixed(2));
        const nextPrices = curPrices.map((p) => ({
          amount: priceOverrides.get(String(p.useTypeID)) ?? p.amount,
          useTypeID: String(p.useTypeID),
          useType: p.useType,
        }));
        putBody.Prices = { ItemPrice: nextPrices };
      }

      if (Object.keys(putBody).length > 0) {
        await lsJsonReq('PUT', `Item/${encodeURIComponent(u.lightspeedItemId)}.json`, putBody);
      }
      if (multiTagsXml) {
        await lsXmlPut(`Item/${encodeURIComponent(u.lightspeedItemId)}.xml`, multiTagsXml);
      }

      if (u.reorderPoint !== undefined || u.desiredLevel !== undefined) {
        const shopsRaw = (before.ItemShops as { ItemShop?: unknown } | undefined)?.ItemShop;
        const shops = (Array.isArray(shopsRaw) ? shopsRaw : shopsRaw ? [shopsRaw] : []) as {
          itemShopID?: string;
          shopID?: string;
        }[];
        const targetShopId = u.physicalShopId || '1';
        const shopRow = shops.find((s) => String(s.shopID) === targetShopId) ?? shops.find((s) => s.shopID && s.shopID !== '0');
        if (shopRow?.itemShopID) {
          const shopPatch: Record<string, string> = {};
          if (u.reorderPoint !== undefined) shopPatch.reorderPoint = String(u.reorderPoint);
          if (u.desiredLevel !== undefined) shopPatch.reorderLevel = String(u.desiredLevel);
          await lsJsonReq('PUT', `ItemShop/${encodeURIComponent(shopRow.itemShopID)}.json`, shopPatch);
        }
      }

      results.push({ lightspeedItemId: u.lightspeedItemId, before, updated: true });
    }
    return results;
  }

  /**
   * Live hydration for HUB Lightspeed Bulk Sheet: fetches exact live R-Series fields
   * (`customSku`, `manufacturerSku`, `defaultCost`, `Prices`, `Tags`, `ItemShops`) for up to 100 itemIDs in 1 call.
   */
  async fetchSheetDetailsByIds(
    itemIds: string[],
    physicalShopId = '1',
  ): Promise<
    Map<
      string,
      {
        mpn: string;
        upc: string;
        description: string;
        customSku: string;
        tags: string[];
        defaultPriceCents: number | null;
        msrpCents: number | null;
        salePriceCents: number | null;
        onlinePriceCents: number | null;
        defaultCostCents: number | null;
        reorderPoint: number;
        desiredLevel: number;
      }
    >
  > {
    const out = new Map<
      string,
      {
        mpn: string;
        upc: string;
        description: string;
        customSku: string;
        tags: string[];
        defaultPriceCents: number | null;
        msrpCents: number | null;
        salePriceCents: number | null;
        onlinePriceCents: number | null;
        defaultCostCents: number | null;
        reorderPoint: number;
        desiredLevel: number;
      }
    >();
    const cleanIds = [...new Set(itemIds.map((x) => String(x || '').trim()).filter((x) => /^\d+$/.test(x)))];
    if (!cleanIds.length) return out;
    await this.ensureConfigured();

    const toCents = (v: unknown): number | null => {
      if (v === undefined || v === null || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? Math.round(n * 100) : null;
    };

    for (let i = 0; i < cleanIds.length; i += 80) {
      const chunk = cleanIds.slice(i, i + 80);
      const q = new URLSearchParams({
        itemID: `IN,[${chunk.join(',')}]`,
        load_relations: '["ItemShops","Tags"]',
        limit: '100',
      });
      type Page = { Item?: LsItem | LsItem[] };
      const page = await this.get<Page>(`/Item.json?${q.toString()}`);
      const list = page.Item ? (Array.isArray(page.Item) ? page.Item : [page.Item]) : [];
      for (const it of list) {
        const raw = it as unknown as Record<string, unknown>;
        const pricesRaw = (raw.Prices as { ItemPrice?: unknown } | undefined)?.ItemPrice;
        const prices = (Array.isArray(pricesRaw) ? pricesRaw : pricesRaw ? [pricesRaw] : []) as {
          amount?: string;
          useTypeID?: string;
          useType?: string;
        }[];
        const byType = new Map<string, number | null>();
        for (const p of prices) {
          if (p.useTypeID) byType.set(String(p.useTypeID), toCents(p.amount));
        }

        const tagsWrap = raw.Tags as { tag?: string | string[] } | undefined;
        const tagsRaw = tagsWrap?.tag;
        const tags = (Array.isArray(tagsRaw) ? tagsRaw : tagsRaw ? [tagsRaw] : [])
          .map((t) => String(t || '').trim())
          .filter(Boolean);

        const shopsRaw = (raw.ItemShops as { ItemShop?: unknown } | undefined)?.ItemShop;
        const shops = (Array.isArray(shopsRaw) ? shopsRaw : shopsRaw ? [shopsRaw] : []) as {
          shopID?: string;
          reorderPoint?: string;
          reorderLevel?: string;
        }[];
        const shop = shops.find((s) => String(s.shopID) === physicalShopId) ?? shops.find((s) => s.shopID && s.shopID !== '0');

        out.set(String(it.itemID), {
          mpn: String(it.manufacturerSku || '').trim(),
          upc: String(it.upc || it.ean || '').trim(),
          description: String(it.description || '').trim(),
          customSku: String(it.customSku || '').trim(),
          tags,
          defaultPriceCents: byType.get('1') ?? null,
          msrpCents: byType.get('2') ?? null,
          salePriceCents: byType.get('3') ?? null,
          onlinePriceCents: byType.get('4') ?? null,
          defaultCostCents: toCents(raw.defaultCost),
          reorderPoint: Math.max(0, Math.floor(Number(shop?.reorderPoint) || 0)),
          desiredLevel: Math.max(0, Math.floor(Number(shop?.reorderLevel) || 0)),
        });
      }
    }
    return out;
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
    // $0.00 avgCost/defaultCost in Lightspeed means no cost on file (e.g. USED bikes, labor, uncosted items) -> null so margin floors protect them!
    costCents: toPositiveCents(item.avgCost) ?? toPositiveCents(item.defaultCost),
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
