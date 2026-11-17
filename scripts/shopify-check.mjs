// Read-only Shopify connection & catalog diagnostic (`npm run shopify:check`).
// Supports 2026+ Shopify Dev Dashboard apps (`SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET`
// with automatic ~24h OAuth `client_credentials` token acquisition) as well as legacy
// `SHOPIFY_ADMIN_ACCESS_TOKEN` (`shpat_...`).
// Never mutates anything on Shopify (`writesEnabled: false` is strictly enforced).
import { ShopifyAdminApi, ShopifyAdminClient } from '../packages/integrations/dist/index.js';

const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN?.trim();
const clientId = process.env.SHOPIFY_CLIENT_ID?.trim();
const clientSecret = process.env.SHOPIFY_CLIENT_SECRET?.trim();
const accessToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN?.trim();
const apiVersion = process.env.SHOPIFY_API_VERSION?.trim() || undefined;
const plan = process.env.SHOPIFY_PLAN?.trim() || 'plus';

const client = new ShopifyAdminClient({
  shopDomain,
  clientId,
  clientSecret,
  accessToken,
  apiVersion,
  plan,
  writesEnabled: false,
});

const health = await client.health();
console.log('--- UBC Commerce Hub · Shopify Read-Only Diagnostic ---');
console.log('Status :', health.status);
console.log('Detail :', health.detail);

if (health.status !== 'connected') {
  if (health.missing.length) {
    console.log('Missing:', health.missing.join(', '));
    console.log('\nTo connect your Shopify store (2026+ Dev Dashboard App), copy .env.example to .env and set:');
    console.log('  SHOPIFY_PLAN=trial                      # or "plus" for UBC production');
    console.log('  SHOPIFY_SHOP_DOMAIN=0v2m1m-hh.myshopify.com');
    console.log('  SHOPIFY_CLIENT_ID=your_dev_dashboard_client_id');
    console.log('  SHOPIFY_CLIENT_SECRET=shpss_...');
    console.log('\n(Pre-2026 stores with an existing Admin Custom App may still set SHOPIFY_ADMIN_ACCESS_TOKEN=shpat_... instead.)');
  }
  process.exitCode = health.status === 'not_connected' ? 0 : 1;
  process.exit();
}

const api = new ShopifyAdminApi(client);
const locations = await api.listLocations();
console.log(`\nLocations (${locations.length}):`);
for (const loc of locations) {
  console.log(`  - ${loc.name} [${loc.isActive ? 'active' : 'inactive'}] -> ${loc.id}`);
}

const firstPage = await api.listVariants(null);
console.log(`\nSample variants fetched: ${firstPage.variants.length}${firstPage.nextCursor ? ' (more pages available)' : ' (complete catalog)'}`);
for (const v of firstPage.variants.slice(0, 5)) {
  const price = `$${(v.priceCents / 100).toFixed(2)}`;
  const cost = v.unitCostCents !== null ? `$${(v.unitCostCents / 100).toFixed(2)}` : 'no-cost';
  console.log(`  - [${v.sku || 'no-sku'}] ${v.title} | price ${price} | cost ${cost} | qty ${v.inventoryQuantity}`);
}
console.log('\nRead-only check succeeded. Zero writes were sent to Shopify.');
