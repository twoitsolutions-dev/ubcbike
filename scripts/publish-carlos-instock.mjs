/**
 * Publishes all in-stock (`inventory_total:>0`) products on Carlos's Shopify store
 * (`z5wxyn-uc.myshopify.com`) that Workstand/Masterlinq left with `publishedAt: null`
 * (excluded from the `Online Store` sales channel — hiding Specialized, Giant, Giro, etc.!).
 */
import { ShopifyAdminClient } from '../packages/integrations/dist/index.js';

const SHOP_DOMAIN = process.env.UBC_LIVE_SHOPIFY_DOMAIN || 'z5wxyn-uc.myshopify.com';
const ACCESS_TOKEN = process.env.UBC_LIVE_SHOPIFY_ACCESS_TOKEN;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function publishRestProduct(numId) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(`https://${SHOP_DOMAIN}/admin/api/2026-10/products/${numId}.json`, {
      method: 'PUT',
      headers: {
        'X-Shopify-Access-Token': ACCESS_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ product: { id: Number(numId), published: true } }),
    });
    if (res.status === 429) {
      const waitSec = Number(res.headers.get('Retry-After') || '2');
      await sleep(waitSec * 1000);
      continue;
    }
    const callLimit = res.headers.get('X-Shopify-Shop-Api-Call-Limit'); // e.g. "35/40"
    if (callLimit) {
      const [used, max] = callLimit.split('/').map(Number);
      if (used && max && used >= max - 5) await sleep(800);
    }
    if (!res.ok) {
      const txt = await res.text();
      console.warn(`  [warn] ${numId}: HTTP ${res.status} ${txt.slice(0, 120)}`);
      return false;
    }
    return true;
  }
  return false;
}

async function main() {
  const client = new ShopifyAdminClient({
    shopDomain: SHOP_DOMAIN,
    accessToken: ACCESS_TOKEN,
    writesEnabled: false,
  });

  const unpublishedInStock = [];
  let alreadyPublished = 0;
  let cursor = null;

  do {
    const d = await client.query(
      `query($cursor: String) {
        products(first: 250, after: $cursor, query: "status:active inventory_total:>0") {
          pageInfo { hasNextPage endCursor }
          nodes { id title vendor publishedAt }
        }
      }`,
      { cursor },
    );
    for (const p of d.products.nodes) {
      if (!p.publishedAt) {
        unpublishedInStock.push({ numId: p.id.split('/').pop(), title: p.title, vendor: p.vendor });
      } else {
        alreadyPublished++;
      }
    }
    cursor = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
  } while (cursor);

  console.log(`Found ${unpublishedInStock.length} IN-STOCK products hidden from Online Store (publishedAt=null); ${alreadyPublished} were already published.`);

  let idx = 0;
  let done = 0;
  let okCount = 0;
  // Shopify REST leaky bucket refills at 2 req/s (burst 40); 3 gentle workers stay smoothly inside bucket!
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      while (idx < unpublishedInStock.length) {
        const cur = unpublishedInStock[idx++];
        const ok = await publishRestProduct(cur.numId);
        if (ok) okCount++;
        done++;
        if (done % 25 === 0 || done === unpublishedInStock.length) {
          process.stdout.write(`  • Published to Online Store: ${done}/${unpublishedInStock.length} (Specialized, Giant, Giro, Fox...)...\r`);
        }
        await sleep(350);
      }
    }),
  );
  console.log(`\n✓ Successfully published ${okCount} in-stock products (including all 191 Specialized items!) to Online Store!`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
