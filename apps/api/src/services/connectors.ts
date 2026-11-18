import type { IntegrationSystem } from '@ubc/shared';
import {
  LightspeedRClient, liveJbi, liveQbp, liveSpecialized, MockShopifyAdmin, MockSupplierConnector,
  ShopifyAdminApi, ShopifyAdminClient, WritesDisabledError, type ConnectorHealth, type ShopifyAdminPort, type SupplierConnector,
} from '@ubc/integrations';
import type { Pool } from '@ubc/database';
import type { AppConfig } from '../config/env.js';

export interface PosPricePort {
  /** Changing POS prices is reserved for authorised omnichannel events (Black Friday, Christmas, etc.). */
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

export async function resolveLiveStoreConfigFromDb(pool: Pool, cfg: AppConfig): Promise<void> {
  if (cfg.mode !== 'live') return;
  if (!cfg.env.SHOPIFY_SHOP_DOMAIN || cfg.env.SHOPIFY_SHOP_DOMAIN === 'twoit-pruebas-pipeline.myshopify.com') {
    const r = await pool.query<{ shopify_shop_domain: string; shopify_location_id: string | null }>(
      `SELECT s.shopify_shop_domain, l.shopify_location_id
       FROM stores s
       LEFT JOIN locations l ON l.store_id = s.id AND l.kind = 'physical'
       WHERE s.shopify_shop_domain IS NOT NULL
         AND s.shopify_shop_domain <> 'twoit-pruebas-pipeline.myshopify.com'
         AND s.shopify_shop_domain <> 'demo.local'
       ORDER BY s.created_at DESC
       LIMIT 1`,
    );
    const row = r.rows[0];
    if (row?.shopify_shop_domain) {
      cfg.env.SHOPIFY_SHOP_DOMAIN = row.shopify_shop_domain;
      if (row.shopify_location_id) {
        cfg.env.SHOPIFY_PHYSICAL_LOCATION_ID = row.shopify_location_id;
      }
    }
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
      shopifyHealth: async () => demoHealth('shopify', 'Shopify Plus DEMO adapter — ready to connect (Functions & Bulk Ops prepared)'),
      lightspeed: null,
      lightspeedHealth: async () => demoHealth('lightspeed_r', 'Lightspeed R-Series DEMO adapter — POS price sync opt-in only for special events'),
      pos: {
        async updatePrices(updates) {
          demoCalls.push({ system: 'lightspeed_r', op: 'updateEventPosPrices (simulated)', at: new Date().toISOString(), detail: { count: updates.length } });
        },
      },
      suppliers: new Map([
        ['QBP', new DemoDbSupplier('QBP', ['api', 'catalog_feed', 'sftp'], pool)],
        ['JBI', new DemoDbSupplier('JBI', ['catalog_feed', 'sftp', 'dealer_portal'], pool)],
        ['SPECIALIZED', new DemoDbSupplier('SPECIALIZED', ['catalog_feed', 'dealer_portal'], pool)],
      ]),
      demoCalls,
    };
  }

  const e = cfg.env;
  const shopifyClient = new ShopifyAdminClient({
    shopDomain: e.SHOPIFY_SHOP_DOMAIN,
    clientId: e.SHOPIFY_CLIENT_ID,
    clientSecret: e.SHOPIFY_CLIENT_SECRET,
    accessToken: e.SHOPIFY_ADMIN_ACCESS_TOKEN,
    apiVersion: e.SHOPIFY_API_VERSION,
    plan: e.SHOPIFY_PLAN,
    physicalLocationId: e.SHOPIFY_PHYSICAL_LOCATION_ID,
    deliveryCustomizationEnabled: e.SHOPIFY_DELIVERY_CUSTOMIZATION_ENABLED,
    writesEnabled: e.SHOPIFY_WRITES_ENABLED,
  });
  const ls = new LightspeedRClient({
    clientId: e.LIGHTSPEED_R_CLIENT_ID,
    clientSecret: e.LIGHTSPEED_R_CLIENT_SECRET,
    refreshToken: e.LIGHTSPEED_R_REFRESH_TOKEN,
    accountId: e.LIGHTSPEED_R_ACCOUNT_ID,
    tokenUrl: e.LIGHTSPEED_R_TOKEN_URL,
    apiBase: e.LIGHTSPEED_R_API_BASE,
    posEventWritesEnabled: e.LIGHTSPEED_R_POS_EVENT_WRITES_ENABLED,
    async loadTokenState() {
      const r = await pool.query<{
        client_id: string | null;
        client_secret: string | null;
        refresh_token: string;
        account_id: string | null;
        access_token: string | null;
        expires_at: Date | null;
      }>(
        `SELECT client_id, client_secret, refresh_token, account_id, access_token, expires_at
         FROM integration_oauth_tokens
         WHERE system = 'lightspeed_r'
         ORDER BY updated_at DESC LIMIT 1`,
      );
      const row = r.rows[0];
      if (!row) return null;
      return {
        clientId: row.client_id,
        clientSecret: row.client_secret,
        refreshToken: row.refresh_token,
        accountId: row.account_id,
        accessToken: row.access_token,
        expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
      };
    },
    async refreshLock(fn) {
      // Transaction-scoped advisory lock: works across processes & PgBouncer pools and auto-releases on disconnect.
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT pg_advisory_xact_lock(hashtext('ubc:lightspeed_r:token_refresh'))`);
        const res = await fn();
        await c.query('COMMIT');
        return res;
      } catch (err) {
        await c.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        c.release();
      }
    },
    async saveTokenState(st) {
      await pool.query(
        `UPDATE integration_oauth_tokens
         SET refresh_token = $1,
             access_token = $2,
             expires_at = $3,
             updated_at = now()
         WHERE system = 'lightspeed_r'`,
        [st.refreshToken, st.accessToken ?? null, st.expiresAt ?? null],
      );
    },
  });
  return {
    mode: 'live',
    shopify: e.SHOPIFY_SYNC_MODE === 'update_only' ? guardCatalogOwnedByOtherApp(new ShopifyAdminApi(shopifyClient)) : new ShopifyAdminApi(shopifyClient),
    shopifyHealth: () => shopifyClient.health(),
    lightspeed: ls,
    lightspeedHealth: () => ls.health(),
    pos: { updatePrices: (updates) => ls.updateEventPosPrices(updates) },
    suppliers: new Map<string, SupplierConnector>([
      ['QBP', liveQbp(e as never)], ['JBI', liveJbi(e as never)], ['SPECIALIZED', liveSpecialized(e as never)],
    ]),
    demoCalls,
  };
}

function summarizeArgs(args: unknown[]): unknown {
  return args.map((a) => (Array.isArray(a) ? { items: a.length } : a));
}

/**
 * In SHOPIFY_SYNC_MODE=update_only another app (Workstand) owns the store catalog: block every call
 * that creates products or creates collections/definitions. Publish/hide (status), price, sale price,
 * stock, discounts and reads stay allowed.
 */
const CATALOG_OWNER_ONLY_OPS = new Set(['upsertProduct', 'ensureSmartCollections', 'ensureUbcMetafieldDefinitions', 'setVariantFulfillmentMetafields']);
function guardCatalogOwnedByOtherApp(api: ShopifyAdminPort): ShopifyAdminPort {
  return new Proxy(api, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof prop === 'string' && CATALOG_OWNER_ONLY_OPS.has(prop)) {
        return async () => {
          throw new WritesDisabledError(`Shopify ${prop} (SHOPIFY_SYNC_MODE=update_only: the catalog belongs to Workstand)`);
        };
      }
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}
