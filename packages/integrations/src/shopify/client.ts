import type { ShopifyPlan } from '@ubc/shared';
import { NotConfiguredError, RetryableError, WritesDisabledError, type ConnectorHealth } from '../types.js';

/**
 * Shopify Admin GraphQL client (server-side only — credentials never reach a browser).
 *
 * Supports BOTH authentication models:
 *  1. **2026+ Shopify Dev Dashboard Apps (Recommended / New Stores):**
 *     Uses `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET` via the OAuth 2.0
 *     `client_credentials` grant (`POST /admin/oauth/access_token`). Tokens
 *     (`shpua_...`, ~24h TTL) are cached in memory, refreshed automatically
 *     5 minutes before expiry, and re-acquired once on HTTP 401.
 *  2. **Legacy Admin Custom Apps (Pre-2026 stores):**
 *     Uses a static `SHOPIFY_ADMIN_ACCESS_TOKEN` (`shpat_...`) if provided.
 *
 * Works across both Trial/Dev stores (`SHOPIFY_PLAN=trial`, e.g. `0v2m1m-hh.myshopify.com`)
 * and UBC's production **Shopify Plus** store (`SHOPIFY_PLAN=plus`).
 */
export interface ShopifyConfig {
  shopDomain?: string; // e.g. 0v2m1m-hh.myshopify.com
  /** 2026+ Shopify Dev Dashboard Client ID */
  clientId?: string;
  /** 2026+ Shopify Dev Dashboard Client Secret */
  clientSecret?: string;
  /** Optional legacy static Admin API token (`shpat_...`) for pre-2026 custom apps */
  accessToken?: string;
  apiVersion?: string;
  plan?: ShopifyPlan;
  physicalLocationId?: string;
  deliveryCustomizationEnabled?: boolean;
  writesEnabled?: boolean;
  fetchImpl?: typeof fetch;
}

export const DEFAULT_SHOPIFY_API_VERSION = '2026-10';

/** Refresh client-credentials tokens 5 minutes before Shopify's reported expiry. */
const TOKEN_SAFETY_BUFFER_MS = 5 * 60 * 1000;

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string; extensions?: { code?: string } }[];
  extensions?: { cost?: { throttleStatus?: { currentlyAvailable: number; restoreRate: number } } };
}

interface ClientCredentialsTokenResponse {
  access_token: string;
  expires_in?: number;
  scope?: string;
}

function normalizeShopDomain(raw?: string): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
  return cleaned || undefined;
}

export class ShopifyAdminClient {
  readonly apiVersion: string;
  readonly plan: ShopifyPlan;
  readonly shopDomain?: string;
  grantedScopes: string[] = [];
  private readonly fetchImpl: typeof fetch;
  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;
  private inflightToken: Promise<string> | null = null;

  constructor(private readonly cfg: ShopifyConfig) {
    this.shopDomain = normalizeShopDomain(cfg.shopDomain);
    this.apiVersion = cfg.apiVersion || DEFAULT_SHOPIFY_API_VERSION;
    this.plan = cfg.plan || 'plus';
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  private usesClientCredentials(): boolean {
    return !!(this.cfg.clientId?.trim() && this.cfg.clientSecret?.trim());
  }

  missing(): string[] {
    const m: string[] = [];
    if (!this.shopDomain) m.push('SHOPIFY_SHOP_DOMAIN');
    const hasStatic = !!this.cfg.accessToken?.trim();
    const hasClientCreds = this.usesClientCredentials();
    if (!hasStatic && !hasClientCreds) {
      if (this.cfg.clientId?.trim() && !this.cfg.clientSecret?.trim()) {
        m.push('SHOPIFY_CLIENT_SECRET');
      } else if (!this.cfg.clientId?.trim() && this.cfg.clientSecret?.trim()) {
        m.push('SHOPIFY_CLIENT_ID');
      } else {
        m.push('SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (Dev Dashboard app) or legacy SHOPIFY_ADMIN_ACCESS_TOKEN');
      }
    }
    return m;
  }

  /**
   * Resolves a valid Admin API token:
   *  - Returns static `accessToken` immediately if configured without client credentials.
   *  - Otherwise exchanges `clientId` + `clientSecret` via `grant_type=client_credentials`
   *    and caches until `expires_in - 5m`.
   */
  async getAccessToken(forceRefresh = false): Promise<string> {
    const missing = this.missing();
    if (missing.length) throw new NotConfiguredError('Shopify', missing);

    if (!this.usesClientCredentials()) {
      return this.cfg.accessToken!.trim();
    }

    if (!forceRefresh && this.cachedToken && Date.now() < this.tokenExpiresAt) {
      return this.cachedToken;
    }

    if (this.inflightToken) return this.inflightToken;

    this.inflightToken = (async () => {
      try {
        const url = `https://${this.shopDomain}/admin/oauth/access_token`;
        const body = new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.cfg.clientId!.trim(),
          client_secret: this.cfg.clientSecret!.trim(),
        }).toString();

        const res = await this.fetchImpl(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body,
        });

        if (!res.ok) {
          throw new Error(`Shopify OAuth client_credentials token exchange failed: HTTP ${res.status}`);
        }

        const data = (await res.json()) as ClientCredentialsTokenResponse;
        if (!data.access_token) {
          throw new Error('Shopify OAuth response did not include access_token');
        }

        const ttlMs = Math.max(60_000, (data.expires_in ?? 86_400) * 1000 - TOKEN_SAFETY_BUFFER_MS);
        this.cachedToken = data.access_token;
        this.tokenExpiresAt = Date.now() + ttlMs;
        if (data.scope) {
          this.grantedScopes = data.scope.split(',').map((s) => s.trim()).filter(Boolean);
        }
        return this.cachedToken;
      } finally {
        this.inflightToken = null;
      }
    })();

    return this.inflightToken;
  }

  async health(): Promise<ConnectorHealth> {
    const missing = this.missing();
    const planLabel = this.plan === 'plus' ? 'Shopify Plus' : `Shopify (${this.plan})`;
    const authMode = this.usesClientCredentials() ? 'Dev Dashboard OAuth auto-refresh' : 'static token';
    const base = { system: 'shopify' as const, checkedAt: new Date().toISOString(), writesEnabled: !!this.cfg.writesEnabled };
    if (missing.length) return { ...base, status: 'not_connected', detail: `${planLabel} ready to connect — awaiting store credentials`, missing };
    try {
      const r = await this.query<{ shop: { name: string; plan?: { displayName?: string; shopifyPlus?: boolean } } }>(
        'query { shop { name plan { displayName shopifyPlus } } }',
      );
      const detectedPlan = r.shop.plan?.displayName ? `plan: ${r.shop.plan.displayName}` : planLabel;
      const scopeSummary = this.grantedScopes.length ? `, scopes: ${this.grantedScopes.join(',')}` : '';
      return {
        ...base,
        status: 'connected',
        detail: `Authenticated to ${r.shop.name} (${detectedPlan}, ${authMode}, API ${this.apiVersion}${scopeSummary})`,
        missing: [],
      };
    } catch (e) {
      return { ...base, status: 'error', detail: (e as Error).message, missing: [] };
    }
  }

  async query<T>(query: string, variables?: Record<string, unknown>, attempt = 0, refreshed401 = false): Promise<T> {
    const token = await this.getAccessToken(false);
    const url = `https://${this.shopDomain}/admin/api/${this.apiVersion}/graphql.json`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query, variables }),
    });

    // If a 24h Dev Dashboard token expired early or was rotated, refresh once automatically.
    if (res.status === 401 && this.usesClientCredentials() && !refreshed401) {
      await this.getAccessToken(true);
      return this.query<T>(query, variables, attempt, true);
    }

    if (res.status === 429 || res.status >= 500) {
      if (attempt < 4) {
        await sleep(500 * 2 ** attempt);
        return this.query<T>(query, variables, attempt + 1, refreshed401);
      }
      throw new RetryableError(`Shopify HTTP ${res.status}`);
    }
    if (!res.ok) throw new Error(`Shopify HTTP ${res.status}`);
    const body = (await res.json()) as GraphQLResponse<T>;
    if (body.errors?.some((e) => e.extensions?.code === 'THROTTLED')) {
      if (attempt < 6) {
        await sleep(1000 * 2 ** attempt);
        return this.query<T>(query, variables, attempt + 1, refreshed401);
      }
      throw new RetryableError('Shopify throttled');
    }
    if (body.errors?.length) throw new Error(`Shopify GraphQL: ${body.errors.map((e) => e.message).join('; ')}`);
    const ts = body.extensions?.cost?.throttleStatus;
    if (ts && typeof ts.currentlyAvailable === 'number' && ts.currentlyAvailable < 160) {
      const restoreRate = Math.max(50, Number(ts.restoreRate) || 50);
      const waitMs = Math.min(2500, Math.ceil(((200 - ts.currentlyAvailable) / restoreRate) * 1000));
      if (waitMs > 25) await sleep(waitMs);
    }
    return body.data as T;
  }

  /** Every mutating call goes through here so the global write switch is enforced. */
  async mutate<T>(mutation: string, variables: Record<string, unknown>): Promise<T> {
    if (!this.cfg.writesEnabled) throw new WritesDisabledError('Shopify');
    return this.query<T>(mutation, variables);
  }

  /**
   * Mutating REST call against Shopify Admin API (used strictly for `published_scope: 'web'`
   * Online Store sales channel publication using `write_products`, without requiring `write_publications`).
   */
  async restMutate<T>(method: 'PUT' | 'POST', path: string, payload: unknown, attempt = 0, refreshed401 = false): Promise<T> {
    if (!this.cfg.writesEnabled) throw new WritesDisabledError('Shopify');
    const token = await this.getAccessToken(false);
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    const url = `https://${this.shopDomain}/admin/api/2025-10${cleanPath}`;
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify(payload),
    });
    if (res.status === 401 && this.usesClientCredentials() && !refreshed401) {
      await this.getAccessToken(true);
      return this.restMutate<T>(method, path, payload, attempt, true);
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt < 4) {
        await sleep(500 * 2 ** attempt);
        return this.restMutate<T>(method, path, payload, attempt + 1, refreshed401);
      }
      throw new RetryableError(`Shopify REST HTTP ${res.status}`);
    }
    if (!res.ok) throw new Error(`Shopify REST HTTP ${res.status}`);
    return (await res.json()) as T;
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
