// Prints the full Hostinger Node.js env var set for ubc-hub.twoitsolutions.com pointing at Carlos's
// real store (z5wxyn-uc) in SHOPIFY_SYNC_MODE=update_only. Secrets come from the local .env.
// Usage: node --env-file=.env scripts/hostinger-env-carlos.mjs
const e = process.env;
const vars = {
  NODE_ENV: 'production', HOST: '0.0.0.0', COOKIE_SECURE: 'true', SESSION_TTL_HOURS: '12', LOG_LEVEL: 'info',
  APP_MODE: 'live', LIVE_MODE_ACK: e.LIVE_MODE_ACK, DATABASE_URL: e.DATABASE_URL, DEMO_WEBHOOK_SECRET: e.DEMO_WEBHOOK_SECRET,
  SHOPIFY_PLAN: 'grow', SHOPIFY_SHOP_DOMAIN: e.UBC_LIVE_SHOPIFY_DOMAIN, SHOPIFY_ADMIN_ACCESS_TOKEN: e.UBC_LIVE_SHOPIFY_ACCESS_TOKEN,
  SHOPIFY_WEBHOOK_SECRET: e.UBC_LIVE_SHOPIFY_CLIENT_SECRET, SHOPIFY_API_VERSION: '2026-10', SHOPIFY_WRITES_ENABLED: 'true',
  SHOPIFY_PHYSICAL_LOCATION_ID: 'gid://shopify/Location/109716930877', SHOPIFY_DELIVERY_CUSTOMIZATION_ENABLED: 'false',
  SHOPIFY_SYNC_MODE: 'update_only', SHOPIFY_PUSH_STOCK: 'true',
  // Lightspeed shop 1 (Tampa) → "University Bicycle Center", shop 2 (Alafia) → "UBC at Alafia River State Park".
  // "Workstand Supplier Stock" and "Warehouse" are never touched.
  SHOPIFY_LOCATION_MAP: '1=gid://shopify/Location/109716930877,2=gid://shopify/Location/109676560701',
  LIGHTSPEED_R_PHYSICAL_SHOP_ID: e.LIGHTSPEED_R_PHYSICAL_SHOP_ID, LIGHTSPEED_R_TOKEN_URL: e.LIGHTSPEED_R_TOKEN_URL,
  LIGHTSPEED_R_API_BASE: e.LIGHTSPEED_R_API_BASE, LIGHTSPEED_R_POS_EVENT_WRITES_ENABLED: 'false',
  QBP_DEALER_AUTHORIZED: 'true', JBI_DEALER_AUTHORIZED: 'true', SPECIALIZED_DEALER_AUTHORIZED: 'true', SPECIALIZED_BIKES_PICKUP_ONLY: 'true',
};
const missing = Object.keys(vars).filter((k) => !vars[k]);
if (missing.length) {
  console.error('MISSING', missing);
  process.exit(1);
}
console.log(JSON.stringify(Object.entries(vars).map(([key, value]) => ({ key, value }))));
