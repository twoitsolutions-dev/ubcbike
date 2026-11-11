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

  SHOPIFY_SHOP_DOMAIN: z.string().optional(),
  SHOPIFY_ADMIN_ACCESS_TOKEN: z.string().optional(),
  SHOPIFY_API_VERSION: z.string().optional(),
  SHOPIFY_WEBHOOK_SECRET: z.string().optional(),
  SHOPIFY_WRITES_ENABLED: bool,

  LIGHTSPEED_R_CLIENT_ID: z.string().optional(),
  LIGHTSPEED_R_CLIENT_SECRET: z.string().optional(),
  LIGHTSPEED_R_REFRESH_TOKEN: z.string().optional(),
  LIGHTSPEED_R_ACCOUNT_ID: z.string().optional(),
  LIGHTSPEED_R_TOKEN_URL: z.string().optional(),
  LIGHTSPEED_R_API_BASE: z.string().optional(),

  QBP_API_KEY: z.string().optional(),
  QBP_API_BASE_URL: z.string().optional(),
  QBP_ACCOUNT_NUMBER: z.string().optional(),
  JBI_ACCOUNT_NUMBER: z.string().optional(),
  JBI_FEED_URL: z.string().optional(),
  JBI_FEED_CREDENTIAL: z.string().optional(),
  SPECIALIZED_DEALER_ID: z.string().optional(),
  SPECIALIZED_API_CREDENTIAL: z.string().optional(),

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
  const env = schema.parse(source);
  if (env.APP_MODE === 'live' && env.LIVE_MODE_ACK !== LIVE_ACK_VALUE) {
    throw new Error(`APP_MODE=live requires LIVE_MODE_ACK=${LIVE_ACK_VALUE}. Refusing to start.`);
  }
  if (env.APP_MODE === 'live' && !env.SHOPIFY_WEBHOOK_SECRET) {
    throw new Error('APP_MODE=live requires SHOPIFY_WEBHOOK_SECRET');
  }
  return { mode: env.APP_MODE, env };
}
