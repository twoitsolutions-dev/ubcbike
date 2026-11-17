import { z } from 'zod';
import type { AppMode } from '@ubc/shared';

const bool = z.enum(['true', 'false', '1', '0', '']).optional().transform((v) => v === 'true' || v === '1');

const schema = z.object({
  APP_MODE: z.enum(['demo', 'live']).default('demo'),
  /** LIVE requires this exact acknowledgement so a typo can never switch modes. */
  LIVE_MODE_ACK: z.string().optional(),
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().default(8787),
  HOST: z.string().default('127.0.0.1'),
  COOKIE_SECURE: bool,
  SESSION_TTL_HOURS: z.coerce.number().positive().default(12),
  ADMIN_DIR: z.string().optional(),
  CORS_ORIGIN: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  SHOPIFY_PLAN: z.enum(['trial', 'basic', 'grow', 'standard', 'advanced', 'plus']).default('plus'),
  SHOPIFY_SHOP_DOMAIN: z.string().optional(),
  SHOPIFY_CLIENT_ID: z.string().optional(),
  SHOPIFY_CLIENT_SECRET: z.string().optional(),
  SHOPIFY_ADMIN_ACCESS_TOKEN: z.string().optional(),
  SHOPIFY_API_VERSION: z.string().optional(),
  SHOPIFY_WEBHOOK_SECRET: z.string().optional(),
  SHOPIFY_WRITES_ENABLED: bool,
  SHOPIFY_PHYSICAL_LOCATION_ID: z.string().optional(),
  SHOPIFY_DELIVERY_CUSTOMIZATION_ENABLED: bool,
  /**
   * full        = the Hub owns the store catalog (creates/updates products) — test store.
   * update_only = another app (Workstand) owns the catalog; the Hub only updates price, sale price
   *               and stock of variants linked in `shopify_variant_links`. Never creates products.
   */
  SHOPIFY_SYNC_MODE: z.enum(['full', 'update_only']).default('full'),
  /**
   * update_only: Lightspeed shopID → Shopify location, e.g. "1=gid://shopify/Location/111,2=gid://shopify/Location/222".
   * Stock is pushed per location only for mapped shops; other Shopify locations (e.g. "Workstand Supplier Stock") are never touched.
   */
  SHOPIFY_LOCATION_MAP: z.string().optional(),
  /** update_only: also push Lightspeed physical stock (default true). */
  SHOPIFY_PUSH_STOCK: z.enum(['true', 'false', '1', '0', '']).optional().transform((v) => v === undefined || v === '' || v === 'true' || v === '1'),

  LIGHTSPEED_R_CLIENT_ID: z.string().optional(),
  LIGHTSPEED_R_CLIENT_SECRET: z.string().optional(),
  LIGHTSPEED_R_REFRESH_TOKEN: z.string().optional(),
  LIGHTSPEED_R_ACCOUNT_ID: z.string().optional(),
  LIGHTSPEED_R_PHYSICAL_SHOP_ID: z.string().optional(),
  LIGHTSPEED_R_TOKEN_URL: z.string().optional(),
  LIGHTSPEED_R_API_BASE: z.string().optional(),
  /** Disabled by default; enabled only when UBC authorises POS price parity for special events (Black Friday, Christmas, etc.). */
  LIGHTSPEED_R_POS_EVENT_WRITES_ENABLED: bool,

  QBP_API_KEY: z.string().optional(),
  QBP_API_BASE_URL: z.string().optional(),
  QBP_ACCOUNT_NUMBER: z.string().optional(),
  QBP_DEALER_AUTHORIZED: z.string().optional(),
  JBI_ACCOUNT_NUMBER: z.string().optional(),
  JBI_FEED_URL: z.string().optional(),
  JBI_FEED_CREDENTIAL: z.string().optional(),
  JBI_DEALER_AUTHORIZED: z.string().optional(),
  SPECIALIZED_DEALER_ID: z.string().optional(),
  SPECIALIZED_API_CREDENTIAL: z.string().optional(),
  SPECIALIZED_DEALER_AUTHORIZED: z.string().optional(),
  SPECIALIZED_BIKES_PICKUP_ONLY: bool,

  /** Used only in DEMO to sign simulated webhooks so they travel the real verification path. */
  DEMO_WEBHOOK_SECRET: z.string().default('demo-webhook-secret-not-for-production'),
});

export type Env = z.infer<typeof schema>;

export interface AppConfig {
  mode: AppMode;
  env: Env;
}

export const LIVE_ACK_VALUE = 'I_UNDERSTAND_THIS_CONNECTS_REAL_SYSTEMS';

export function loadConfig(source: Record<string, string | undefined> = process.env): AppConfig {
  const defaultHost = source.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1';
  const env = schema.parse({ ...source, HOST: source.HOST?.trim() || defaultHost });
  // 2026+ Shopify Dev Dashboard apps sign webhooks using SHOPIFY_CLIENT_SECRET when no separate webhook secret is set.
  if (!env.SHOPIFY_WEBHOOK_SECRET?.trim() && env.SHOPIFY_CLIENT_SECRET?.trim()) {
    env.SHOPIFY_WEBHOOK_SECRET = env.SHOPIFY_CLIENT_SECRET.trim();
  }
  if (env.APP_MODE === 'live' && env.LIVE_MODE_ACK !== LIVE_ACK_VALUE) {
    throw new Error(`APP_MODE=live requires LIVE_MODE_ACK=${LIVE_ACK_VALUE}. Refusing to start.`);
  }
  if (env.APP_MODE === 'live' && !env.SHOPIFY_WEBHOOK_SECRET) {
    throw new Error('APP_MODE=live requires SHOPIFY_WEBHOOK_SECRET (or SHOPIFY_CLIENT_SECRET from Shopify Dev Dashboard)');
  }
  return { mode: env.APP_MODE, env };
}
