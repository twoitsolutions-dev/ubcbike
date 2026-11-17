// Enables SHOPIFY_WRITES_ENABLED=true in local .env for sandbox testing (never prints secrets).
import { readFileSync, writeFileSync } from 'node:fs';

const shop = (process.env.SHOPIFY_SHOP_DOMAIN || '').trim();
if (shop && !/pruebas|sandbox|test|dev/i.test(shop)) {
  console.error(`Refusing to auto-enable writes on non-sandbox shop: ${shop}`);
  process.exit(1);
}

let envText = readFileSync('.env', 'utf8');
if (/^SHOPIFY_WRITES_ENABLED=/m.test(envText)) {
  envText = envText.replace(/^SHOPIFY_WRITES_ENABLED=.*$/m, 'SHOPIFY_WRITES_ENABLED=true');
} else {
  envText += '\nSHOPIFY_WRITES_ENABLED=true\n';
}
writeFileSync('.env', envText, 'utf8');
console.log('Updated .env: SHOPIFY_WRITES_ENABLED=true (sandbox mode)');
