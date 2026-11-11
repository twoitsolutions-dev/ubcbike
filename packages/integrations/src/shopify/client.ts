import { NotConfiguredError, RetryableError, WritesDisabledError, type ConnectorHealth } from '../types.js';

/**
 * Shopify Admin GraphQL client (server side only — the token never reaches a browser).
 *
 * The API version is pinned via SHOPIFY_API_VERSION. Shopify ships a version
 * per quarter; check https://shopify.dev/docs/api/usage/versioning and bump
 * deliberately. Default here: 2026-10 (verify it is marked stable before LIVE).
 */
export interface ShopifyConfig {
  shopDomain?: string; // e.g. ubc-dev.myshopify.com
  accessToken?: string;
  apiVersion?: string;
  writesEnabled?: boolean;
  fetchImpl?: typeof fetch;
}

export const DEFAULT_SHOPIFY_API_VERSION = '2026-10';

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string; extensions?: { code?: string } }[];
  extensions?: { cost?: { throttleStatus?: { currentlyAvailable: number; restoreRate: number } } };
}

export class ShopifyAdminClient {
  readonly apiVersion: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: ShopifyConfig) {
    this.apiVersion = cfg.apiVersion || DEFAULT_SHOPIFY_API_VERSION;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  missing(): string[] {
    const m: string[] = [];
    if (!this.cfg.shopDomain) m.push('SHOPIFY_SHOP_DOMAIN');
    if (!this.cfg.accessToken) m.push('SHOPIFY_ADMIN_ACCESS_TOKEN');
    return m;
  }

  async health(): Promise<ConnectorHealth> {
    const missing = this.missing();
    const base = { system: 'shopify' as const, checkedAt: new Date().toISOString(), writesEnabled: !!this.cfg.writesEnabled };
    if (missing.length) return { ...base, status: 'not_connected', detail: 'No Shopify credentials configured', missing };
    try {
      const r = await this.query<{ shop: { name: string } }>('query { shop { name } }');
      return { ...base, status: 'connected', detail: `Authenticated to ${r.shop.name} (API ${this.apiVersion})`, missing: [] };
    } catch (e) {
      return { ...base, status: 'error', detail: (e as Error).message, missing: [] };
    }
  }

  async query<T>(query: string, variables?: Record<string, unknown>, attempt = 0): Promise<T> {
    const missing = this.missing();
    if (missing.length) throw new NotConfiguredError('Shopify', missing);
    const url = `https://${this.cfg.shopDomain}/admin/api/${this.apiVersion}/graphql.json`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': this.cfg.accessToken! },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 429 || res.status >= 500) {
      if (attempt < 4) {
        await sleep(500 * 2 ** attempt);
        return this.query<T>(query, variables, attempt + 1);
      }
      throw new RetryableError(`Shopify HTTP ${res.status}`);
    }
    if (!res.ok) throw new Error(`Shopify HTTP ${res.status}`);
    const body = (await res.json()) as GraphQLResponse<T>;
    if (body.errors?.some((e) => e.extensions?.code === 'THROTTLED')) {
      if (attempt < 6) {
        await sleep(1000 * 2 ** attempt);
        return this.query<T>(query, variables, attempt + 1);
      }
      throw new RetryableError('Shopify throttled');
    }
    if (body.errors?.length) throw new Error(`Shopify GraphQL: ${body.errors.map((e) => e.message).join('; ')}`);
    return body.data as T;
  }

  /** Every mutating call goes through here so the global write switch is enforced. */
  async mutate<T>(mutation: string, variables: Record<string, unknown>): Promise<T> {
    if (!this.cfg.writesEnabled) throw new WritesDisabledError('Shopify');
    return this.query<T>(mutation, variables);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
