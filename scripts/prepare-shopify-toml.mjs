// Generates a local git-ignored `shopify.app.toml` bound to SHOPIFY_CLIENT_ID from .env
// with read + write scopes for products, inventory, locations, and orders.
import { writeFileSync } from 'node:fs';

const clientId = (process.env.SHOPIFY_CLIENT_ID || '').trim();
if (!clientId) {
  console.error('SHOPIFY_CLIENT_ID is missing in .env');
  process.exit(1);
}

const toml = `# Generated locally from .env for Shopify CLI (git-ignored)
client_id = "${clientId}"
name = "UBC Commerce Hub"
application_url = "https://shopify.dev/apps/default-app-home"
embedded = false

[build]
include_config_on_deploy = true

[access_scopes]
scopes = "read_products,write_products,read_inventory,write_inventory,read_locations,read_orders"

[auth]
redirect_urls = [ "https://shopify.dev/apps/default-app-home/api/auth" ]
`;

writeFileSync('shopify.app.toml', toml, 'utf8');
console.log('Generated shopify.app.toml with read/write scopes (client_id bound from .env).');
