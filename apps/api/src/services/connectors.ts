import type { IntegrationSystem } from '@ubc/shared';
import {
  LightspeedRClient, liveJbi, liveQbp, liveSpecialized, MockShopifyAdmin, MockSupplierConnector,
  ShopifyAdminApi, ShopifyAdminClient, type ConnectorHealth, type ShopifyAdminPort, type SupplierConnector,
} from '@ubc/integrations';
import type { Pool } from '@ubc/database';
import type { AppConfig } from '../config/env.js';

export interface PosPricePort {
  /** Changing POS prices requires explicit authorisation; LIVE implementation refuses. */
  updatePrices(updates: { lightspeedItemId: string; priceCents: number }[]): Promise<void>;
}

export interface Connectors {
  mode: AppConfig['mode'];
  shopify: ShopifyAdminPort;
  shopifyHealth(): Promise<ConnectorHealth>;
  lightspeed: LightspeedRClient | null;
  lightspeedHealth(): Promise<ConnectorHealth>;
  pos: PosPricePort;
  suppliers: Map<string, SupplierConnector>;
  /** Calls recorded by DEMO adapters (inspectable in the admin and in tests). */
  demoCalls: { system: string; op: string; at: string; detail: unknown }[];
}

const demoHealth = (system: IntegrationSystem, detail: string): ConnectorHealth => ({
  system, status: 'demo_adapter', detail, checkedAt: new Date().toISOString(), writesEnabled: false,
  missing: ['DEMO mode — real credentials are only read in LIVE mode'],
});

/**
 * DEMO supplier adapter backed by the demo supplier_offers rows, so availability
 * re-checks during approval see the same simulated data the admin shows.
 */
class DemoDbSupplier extends MockSupplierConnector {
  constructor(code: string, methods: ConstructorParameters<typeof MockSupplierConnector>[1], private readonly pool: Pool) {
    super(code, methods);
  }
  override async checkAvailability(skus: string[]) {
    if (this.failNext > 0) { this.failNext--; throw new Error(`${this.code} demo adapter: simulated connection error`); }
    const r = await this.pool.query<{ supplier_sku: string; qty_available: number; cost_cents: number | null }>(
      `SELECT so.supplier_sku, so.qty_available, so.cost_cents FROM supplier_offers so JOIN suppliers s ON s.id = so.supplier_id
       WHERE s.code = $1 AND so.supplier_sku = ANY($2::text[])`, [this.code, skus]);
    const now = new Date().toISOString();
    return skus.map((sku) => {
      const row = r.rows.find((x) => x.supplier_sku === sku);
      return { supplierSku: sku, qtyAvailable: row?.qty_available ?? 0, costCents: row?.cost_cents ?? null, reportedAt: now };
    });
  }
}

export function createConnectors(cfg: AppConfig, pool: Pool): Connectors {
  const demoCalls: Connectors['demoCalls'] = [];
  if (cfg.mode === 'demo') {
    const mockShopify = new MockShopifyAdmin();
    const recording = new Proxy(mockShopify, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        if (typeof v !== 'function') return v;
        return async (...args: unknown[]) => {
          demoCalls.push({ system: 'shopify', op: String(prop), at: new Date().toISOString(), detail: summarizeArgs(args) });
          if (demoCalls.length > 500) demoCalls.splice(0, demoCalls.length - 500);
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    return {
      mode: 'demo',
      shopify: recording,
      shopifyHealth: async () => demoHealth('shopify', 'Simulated Shopify Admin adapter (records the calls it would make)'),
      lightspeed: null,
      lightspeedHealth: async () => demoHealth('lightspeed_r', 'Simulated Lightspeed R-Series adapter (read-only)'),
      pos: {
        async updatePrices(updates) {
          demoCalls.push({ system: 'lightspeed_r', op: 'updatePrices (simulated)', at: new Date().toISOString(), detail: { count: updates.length } });
        },
      },
      suppliers: new Map([
        ['QBP', new DemoDbSupplier('QBP', ['api', 'catalog_feed'], pool)],
        ['JBI', new DemoDbSupplier('JBI', ['catalog_feed', 'dealer_portal'], pool)],
        ['SPECIALIZED', new DemoDbSupplier('SPECIALIZED', ['dealer_portal'], pool)],
      ]),
      demoCalls,
    };
  }

  const e = cfg.env;
  const shopifyClient = new ShopifyAdminClient({
    shopDomain: e.SHOPIFY_SHOP_DOMAIN, accessToken: e.SHOPIFY_ADMIN_ACCESS_TOKEN,
    apiVersion: e.SHOPIFY_API_VERSION, writesEnabled: e.SHOPIFY_WRITES_ENABLED,
  });
  const ls = new LightspeedRClient({
    clientId: e.LIGHTSPEED_R_CLIENT_ID, clientSecret: e.LIGHTSPEED_R_CLIENT_SECRET,
    refreshToken: e.LIGHTSPEED_R_REFRESH_TOKEN, accountId: e.LIGHTSPEED_R_ACCOUNT_ID,
    tokenUrl: e.LIGHTSPEED_R_TOKEN_URL, apiBase: e.LIGHTSPEED_R_API_BASE,
  });
  return {
    mode: 'live',
    shopify: new ShopifyAdminApi(shopifyClient),
    shopifyHealth: () => shopifyClient.health(),
    lightspeed: ls,
    lightspeedHealth: () => ls.health(),
    pos: { updatePrices: () => ls.put() },
    suppliers: new Map<string, SupplierConnector>([
      ['QBP', liveQbp(e as never)], ['JBI', liveJbi(e as never)], ['SPECIALIZED', liveSpecialized(e as never)],
    ]),
    demoCalls,
  };
}

function summarizeArgs(args: unknown[]): unknown {
  return args.map((a) => (Array.isArray(a) ? { items: a.length } : a));
}
