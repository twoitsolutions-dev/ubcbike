// Sync exact Shopify Location quantities (Tampa, Alafia, Warehouse) into ubc.tampa_qty,
// ubc.alafia_qty, custom.store_location, and ubc-*-stock tags for the 44 in-stock products
// that were showing generic "In Stock at UBC".
import fs from 'node:fs/promises';
import { ShopifyAdminClient } from '../packages/integrations/dist/index.js';

const LOC_TAMPA = 'gid://shopify/Location/109716930877';   // University Bicycle Center
const LOC_ALAFIA = 'gid://shopify/Location/109676560701';  // UBC at Alafia River State Park
const LOC_WAREHOUSE = 'gid://shopify/Location/109609779517'; // Warehouse

const client = new ShopifyAdminClient({
  shopDomain: (process.env.UBC_LIVE_SHOPIFY_DOMAIN || '').trim(),
  accessToken: (process.env.UBC_LIVE_SHOPIFY_ACCESS_TOKEN || '').trim(),
  apiVersion: process.env.SHOPIFY_API_VERSION?.trim() || '2026-10',
  plan: 'plus',
  writesEnabled: true,
});

const backup = JSON.parse(await fs.readFile('build/ubcbike-live-backup-2026-11-24T20-12-30-066Z.json', 'utf8'));
const missing = backup.products.filter((p) => {
  if ((p.totalInventory || 0) <= 0) return false;
  const tags = p.tags || [];
  const mf = p.metafields?.nodes || [];
  const t = Number(mf.find((m) => m.namespace === 'ubc' && m.key === 'tampa_qty')?.value || 0);
  const a = Number(mf.find((m) => m.namespace === 'ubc' && m.key === 'alafia_qty')?.value || 0);
  return !(tags.includes('ubc-tampa-stock') || t > 0 || tags.includes('ubc-alafia-stock') || a > 0);
});

console.log(`Found ${missing.length} products to sync exact store locations.`);

const ids = missing.map((p) => p.id);
const res = await client.query(`query($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Product {
      id handle title tags
      variants(first: 25) {
        nodes {
          inventoryItem {
            inventoryLevels(first: 10) {
              nodes {
                location { id name }
                quantities(names: ["available"]) { quantity }
              }
            }
          }
        }
      }
    }
  }
}`, { ids });

let tampaCount = 0, alafiaCount = 0, warehouseOnly = 0, updated = 0;
for (const p of res.nodes || []) {
  if (!p) continue;
  let tq = 0, aq = 0, wq = 0;
  for (const v of p.variants?.nodes || []) {
    for (const lvl of v.inventoryItem?.inventoryLevels?.nodes || []) {
      const q = lvl.quantities?.[0]?.quantity || 0;
      if (q <= 0) continue;
      if (lvl.location.id === LOC_TAMPA) tq += q;
      else if (lvl.location.id === LOC_ALAFIA) aq += q;
      else if (lvl.location.id === LOC_WAREHOUSE) wq += q;
    }
  }

  const locs = [];
  const nextTags = new Set(p.tags || []);
  const metafields = [];

  if (tq > 0) {
    locs.push('UBC Tampa Showroom');
    nextTags.add('ubc-tampa-stock');
    metafields.push({ namespace: 'ubc', key: 'tampa_qty', type: 'number_integer', value: String(tq) });
    tampaCount++;
  }
  if (aq > 0) {
    locs.push('UBC Alafia River Park');
    nextTags.add('ubc-alafia-stock');
    metafields.push({ namespace: 'ubc', key: 'alafia_qty', type: 'number_integer', value: String(aq) });
    alafiaCount++;
  }
  if (tq === 0 && aq === 0 && wq > 0) {
    locs.push('Warehouse');
    nextTags.add('ubc-warehouse-stock');
    warehouseOnly++;
  }
  if (locs.length) {
    metafields.push({ namespace: 'custom', key: 'store_location', type: 'list.single_line_text_field', value: JSON.stringify(locs) });
  }

  if (metafields.length) {
    const r = await client.mutate(`mutation($product: ProductUpdateInput!) {
      productUpdate(product: $product) {
        product { id }
        userErrors { field message }
      }
    }`, {
      product: {
        id: p.id,
        tags: Array.from(nextTags),
        metafields,
      },
    });
    if (r.productUpdate.userErrors?.length) {
      console.error(`Err ${p.handle}:`, r.productUpdate.userErrors);
    } else {
      updated++;
    }
  }
}

console.log(`Updated ${updated}/${missing.length}: Tampa=${tampaCount}, Alafia=${alafiaCount}, WarehouseOnly=${warehouseOnly}`);
