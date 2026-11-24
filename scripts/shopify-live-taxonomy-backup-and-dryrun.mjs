// Read-only full backup + taxonomy dry-run audit for ubcbike.myshopify.com (z5wxyn-uc.myshopify.com).
// Never mutates Shopify (writesEnabled: false).
import fs from 'node:fs/promises';
import path from 'node:path';
import { ShopifyAdminClient } from '../packages/integrations/dist/index.js';

const shopDomain = (process.env.UBC_LIVE_SHOPIFY_DOMAIN || '').trim();
const accessToken = (process.env.UBC_LIVE_SHOPIFY_ACCESS_TOKEN || '').trim();
if (!shopDomain || !accessToken) {
  console.error('Missing UBC_LIVE_SHOPIFY_DOMAIN or UBC_LIVE_SHOPIFY_ACCESS_TOKEN in .env');
  process.exit(1);
}

const client = new ShopifyAdminClient({
  shopDomain,
  accessToken,
  apiVersion: process.env.SHOPIFY_API_VERSION?.trim() || '2026-10',
  plan: 'plus',
  writesEnabled: false,
});

// 1. Shop, Metafield Definitions, Collections, Menus
const metaSnap = await client.query(`{
  shop { name myshopifyDomain primaryDomain { host } }
  metafieldDefinitions(first: 100, ownerType: PRODUCT) {
    nodes { id name namespace key type { name } }
  }
  collections(first: 250) {
    nodes {
      id handle title productsCount { count }
      ruleSet { appliedDisjunctively rules { column relation condition } }
    }
  }
  menus(first: 50) {
    nodes {
      id handle title
      items {
        id title type url resourceId
        items {
          id title type url resourceId
          items { id title type url resourceId }
        }
      }
    }
  }
}`);

// 2. Paginate ALL products
const products = [];
let cursor = null;
let pageNum = 0;
while (true) {
  pageNum++;
  const res = await client.query(`query($after: String) {
    products(first: 250, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id handle title status vendor productType tags totalInventory
        category { id fullName }
        options { name values }
        variants(first: 25) {
          nodes { id title sku barcode price compareAtPrice inventoryQuantity }
        }
        metafields(first: 20) {
          nodes { namespace key value type }
        }
      }
    }
  }`, { after: cursor });
  const batch = res.products.nodes || [];
  products.push(...batch);
  if (pageNum % 10 === 0 || !res.products.pageInfo.hasNextPage) {
    console.log(`Fetched ${products.length} products (page ${pageNum})...`);
  }
  if (!res.products.pageInfo.hasNextPage) break;
  cursor = res.products.pageInfo.endCursor;
}

// 3. Save full JSON backup
await fs.mkdir('build', { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.join('build', `ubcbike-live-backup-${stamp}.json`);
const backup = {
  exportedAt: new Date().toISOString(),
  shop: metaSnap.shop,
  metafieldDefinitions: metaSnap.metafieldDefinitions.nodes,
  collections: metaSnap.collections.nodes,
  menus: metaSnap.menus.nodes,
  products,
};
await fs.writeFile(backupPath, JSON.stringify(backup, null, 2));
console.log(`\nBACKUP SAVED: ${backupPath} (${products.length} products, ${metaSnap.collections.nodes.length} collections, ${metaSnap.menus.nodes.length} menus)`);

// 4. Analyze current state
const byStatus = {};
const byType = {};
const deptTags = {};
const allTagsTop = {};
for (const p of products) {
  byStatus[p.status] = (byStatus[p.status] || 0) + 1;
  const pt = p.productType || '(blank)';
  byType[pt] = (byType[pt] || 0) + 1;
  for (const t of p.tags || []) {
    allTagsTop[t] = (allTagsTop[t] || 0) + 1;
    if (/^dept-/i.test(t)) deptTags[t] = (deptTags[t] || 0) + 1;
  }
}

const top = (obj, n = 40) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);
console.log('\n--- PRODUCT STATUS ---');
console.log(byStatus);
console.log('\n--- TOP 40 CURRENT PRODUCT TYPES ---');
for (const [k, v] of top(byType, 40)) console.log(`  ${String(v).padStart(5)}  ${k}`);
console.log('\n--- DEPT-* TAGS ---');
for (const [k, v] of top(deptTags, 50)) console.log(`  ${String(v).padStart(5)}  ${k}`);
console.log('\n--- EXISTING COLLECTIONS ---');
for (const c of metaSnap.collections.nodes) {
  const kind = c.ruleSet ? `AUTO(${c.ruleSet.rules.map((r) => `${r.column} ${r.relation} ${r.condition}`).join(c.ruleSet.appliedDisjunctively ? ' OR ' : ' AND ')})` : 'MANUAL';
  console.log(`  [${String(c.productsCount?.count ?? '?').padStart(4)}] ${c.handle} | "${c.title}" | ${kind}`);
}
console.log('\n--- EXISTING MENUS ---');
for (const m of metaSnap.menus.nodes) {
  console.log(`  Menu: ${m.handle} ("${m.title}") -> ${m.items.length} top items: ${m.items.map((i) => i.title).join(', ')}`);
}
console.log('\n--- EXISTING PRODUCT METAFIELD DEFINITIONS ---');
for (const d of metaSnap.metafieldDefinitions.nodes) {
  console.log(`  ${d.namespace}.${d.key} (${d.type?.name}) - "${d.name}"`);
}
