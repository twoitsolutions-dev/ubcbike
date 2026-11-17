/**
 * Adds server-side combinable `brand-<handle>` and `price-<tier>` tags to all in-stock products
 * on Carlos's Shopify store (`z5wxyn-uc.myshopify.com`) so Brand + Price + Location + Department + Sort
 * filters all work 100% natively & combinably (`/collections/<dept>/<loc>+<brand>+<price>?sort_by=...`)!
 */
import { ShopifyAdminClient } from '../packages/integrations/dist/index.js';

const SHOP_DOMAIN = process.env.UBC_LIVE_SHOPIFY_DOMAIN || 'z5wxyn-uc.myshopify.com';
const ACCESS_TOKEN = process.env.UBC_LIVE_SHOPIFY_ACCESS_TOKEN;

function handleize(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['"’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function main() {
  const client = new ShopifyAdminClient({
    shopDomain: SHOP_DOMAIN,
    accessToken: ACCESS_TOKEN,
    writesEnabled: true,
  });

  // Fetch all in-stock products (627–641 products -> 3 pages of 250!)
  const products = [];
  let cursor = null;
  do {
    const d = await client.query(
      `query($cursor: String) {
        products(first: 250, after: $cursor, query: "inventory_total:>0") {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            vendor
            priceRangeV2 { minVariantPrice { amount } }
          }
        }
      }`,
      { cursor },
    );
    products.push(...d.products.nodes);
    cursor = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
  } while (cursor);

  console.log(`Tagging ${products.length} in-stock products with brand-* and price-* filter tags...`);

  let idx = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (idx < products.length) {
        const p = products[idx++];
        const tags = [];
        const vHandle = handleize(p.vendor);
        if (vHandle) tags.push(`brand-${vHandle}`);

        const price = Number(p.priceRangeV2?.minVariantPrice?.amount || 0);
        if (price > 0 && price < 50) tags.push('price-under-50');
        else if (price >= 50 && price < 200) tags.push('price-50-200');
        else if (price >= 200 && price < 1000) tags.push('price-200-1000');
        else if (price >= 1000) tags.push('price-1000-plus');

        if (tags.length) {
          await client.mutate(
            `mutation($id: ID!, $tags: [String!]!) {
              tagsAdd(id: $id, tags: $tags) { userErrors { message } }
            }`,
            { id: p.id, tags },
          ).catch(() => {});
        }
        done++;
        if (done % 100 === 0 || done === products.length) {
          process.stdout.write(`  • Tagged ${done}/${products.length}...\r`);
        }
      }
    }),
  );
  console.log(`\n✓ Done tagging ${products.length} products with combinable Brand & Price facets!`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
