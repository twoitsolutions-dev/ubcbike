// Create `custom.store_location` (list.single_line_text_field) metafield definition
// and populate it on all in-stock products on ubcbike.myshopify.com from their stock tags/metafields.
import fs from 'node:fs/promises';
import { ShopifyAdminClient } from '../packages/integrations/dist/index.js';

const shopDomain = (process.env.UBC_LIVE_SHOPIFY_DOMAIN || '').trim();
const accessToken = (process.env.UBC_LIVE_SHOPIFY_ACCESS_TOKEN || '').trim();
const client = new ShopifyAdminClient({
  shopDomain,
  accessToken,
  apiVersion: process.env.SHOPIFY_API_VERSION?.trim() || '2026-10',
  plan: 'plus',
  writesEnabled: true,
});

const backup = JSON.parse(await fs.readFile('build/ubcbike-live-backup-2026-11-24T20-12-30-066Z.json', 'utf8'));
const existingDefs = new Set((backup.metafieldDefinitions || []).map((d) => `${d.namespace}.${d.key}`));

if (!existingDefs.has('custom.store_location')) {
  const r = await client.mutate(`mutation($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id key }
      userErrors { field message }
    }
  }`, {
    definition: {
      name: 'Store Location',
      namespace: 'custom',
      key: 'store_location',
      type: 'list.single_line_text_field',
      ownerType: 'PRODUCT',
      pin: true,
    },
  });
  if (r.metafieldDefinitionCreate.userErrors?.length) {
    console.warn('Def warn:', r.metafieldDefinitionCreate.userErrors);
  } else {
    console.log('Created metafield definition: custom.store_location');
  }
} else {
  console.log('Metafield definition custom.store_location already exists');
}

const inStock = backup.products.filter((p) => (p.totalInventory || 0) > 0);
const toUpdate = [];
for (const p of inStock) {
  const tags = p.tags || [];
  const mf = p.metafields?.nodes || [];
  const tampaMf = Number(mf.find((m) => m.namespace === 'ubc' && m.key === 'tampa_qty')?.value || 0);
  const alafiaMf = Number(mf.find((m) => m.namespace === 'ubc' && m.key === 'alafia_qty')?.value || 0);
  const locs = [];
  if (tags.includes('ubc-tampa-stock') || tampaMf > 0) locs.push('UBC Tampa Showroom');
  if (tags.includes('ubc-alafia-stock') || alafiaMf > 0) locs.push('UBC Alafia River Park');
  if (locs.length) {
    toUpdate.push({ id: p.id, handle: p.handle, locs });
  }
}

console.log(`Populating custom.store_location on ${toUpdate.length} in-stock products...`);

let ok = 0;
let fail = 0;
let idx = 0;
const CONCURRENCY = 4;

async function worker() {
  while (idx < toUpdate.length) {
    const item = toUpdate[idx++];
    try {
      const r = await client.mutate(`mutation($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id }
          userErrors { field message }
        }
      }`, {
        metafields: [{
          ownerId: item.id,
          namespace: 'custom',
          key: 'store_location',
          type: 'list.single_line_text_field',
          value: JSON.stringify(item.locs),
        }],
      });
      if (r.metafieldsSet.userErrors?.length) {
        fail++;
        if (fail <= 10) console.error(`Warn ${item.handle}:`, r.metafieldsSet.userErrors);
      } else {
        ok++;
      }
    } catch (err) {
      fail++;
      if (fail <= 10) console.error(`Err ${item.handle}:`, err.message);
    }
    if ((ok + fail) % 200 === 0) console.log(`Progress: ${ok + fail}/${toUpdate.length} (ok=${ok}, fail=${fail})`);
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
console.log(`\nDone! custom.store_location set on ok=${ok}, fail=${fail} out of ${toUpdate.length}`);
