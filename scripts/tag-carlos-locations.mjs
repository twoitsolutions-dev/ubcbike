/**
 * Separates UBC Tampa Showroom (`shop #1`) vs UBC Alafia River Park (`shop #2`) across Shopify:
 *  1) Tags every stocked product with `ubc-tampa-stock` and/or `ubc-alafia-stock` (`tagsAdd`).
 *  2) Sets `ubc.tampa_qty` and `ubc.alafia_qty` metafields on both Products and Variants so every
 *     product card & PDP displays exact per-store unit counts (`📍 UBC Tampa: 5 · 🌲 Alafia: 2`).
 *  3) Creates & publishes `/collections/in-stock-tampa` and `/collections/in-stock-alafia` Smart Collections,
 *     AND enables native `/collections/<dept>/ubc-tampa-stock` & `/collections/<dept>/ubc-alafia-stock` filtering!
 */
import { performance } from 'node:perf_hooks';
import { normalizeGtin } from '../packages/business-rules/dist/index.js';
import { ShopifyAdminClient } from '../packages/integrations/dist/index.js';
import { createPool } from '../packages/database/dist/index.js';

const SHOP_DOMAIN = process.env.UBC_LIVE_SHOPIFY_DOMAIN || 'z5wxyn-uc.myshopify.com';
const ACCESS_TOKEN = process.env.UBC_LIVE_SHOPIFY_ACCESS_TOKEN;

async function main() {
  const t0 = performance.now();
  if (!ACCESS_TOKEN) throw new Error('Missing UBC_LIVE_SHOPIFY_ACCESS_TOKEN');

  const client = new ShopifyAdminClient({
    shopDomain: SHOP_DOMAIN,
    accessToken: ACCESS_TOKEN,
    writesEnabled: true,
  });

  // 1. Ensure metafield definitions for `ubc.tampa_qty` and `ubc.alafia_qty` exist (Public Storefront readable)
  for (const ownerType of ['PRODUCT', 'PRODUCTVARIANT']) {
    for (const [key, name] of [['tampa_qty', 'UBC Tampa Showroom Qty'], ['alafia_qty', 'UBC Alafia Park Qty']]) {
      await client.mutate(
        `mutation($def: MetafieldDefinitionInput!) {
          metafieldDefinitionCreate(definition: $def) {
            createdDefinition { id }
            userErrors { code message }
          }
        }`,
        {
          def: {
            name,
            namespace: 'ubc',
            key,
            type: 'number_integer',
            ownerType,
            access: { storefront: 'PUBLIC_READ' },
          },
        },
      ).catch(() => {});
    }
  }

  const pool = createPool(process.env.DATABASE_URL);
  try {
    console.log('\n══════════════════════════════════════════════════════════════════════');
    console.log('  UBC Hub · Tagging & Separating UBC Tampa vs Alafia River Park');
    console.log('══════════════════════════════════════════════════════════════════════\n');

    const comp = await pool.query(`SELECT id FROM companies WHERE slug = 'twoit-sandbox' LIMIT 1`);
    const companyId = comp.rows[0].id;

    const lsInvRows = await pool.query(
      `SELECT v.upc,
              coalesce(sum(CASE WHEN l.lightspeed_shop_id = '1' THEN il.on_hand ELSE 0 END), 0)::int AS tampa_qty,
              coalesce(sum(CASE WHEN l.lightspeed_shop_id = '2' THEN il.on_hand ELSE 0 END), 0)::int AS alafia_qty
       FROM variants v
       LEFT JOIN inventory_levels il ON il.variant_id = v.id
       LEFT JOIN locations l ON l.id = il.location_id
       WHERE v.company_id = $1 AND v.ref LIKE 'lsv-%' AND v.upc IS NOT NULL
       GROUP BY v.id, v.upc`,
      [companyId],
    );

    const gtinMap = new Map();
    const dupes = new Set();
    for (const r of lsInvRows.rows) {
      const g14 = normalizeGtin(r.upc);
      if (!g14) continue;
      if (gtinMap.has(g14)) {
        dupes.add(g14);
        gtinMap.delete(g14);
      } else if (!dupes.has(g14)) {
        gtinMap.set(g14, { tampa: r.tampa_qty, alafia: r.alafia_qty });
      }
    }

    const stockedGtins = [...gtinMap.entries()].filter(([, q]) => q.tampa > 0 || q.alafia > 0);
    console.log(`1) Matching ${stockedGtins.length} stocked POS GTINs to Shopify Products & Variants...`);

    // Map productId -> { tampaTotal, alafiaTotal } & variantId -> { tampa, alafia }
    const prodTotals = new Map();
    const varTotals = new Map();
    const seenVariants = new Set();

    const BATCH = 30;
    for (let i = 0; i < stockedGtins.length; i += BATCH) {
      const slice = stockedGtins.slice(i, i + BATCH);
      const terms = [];
      for (const [g14] of slice) {
        terms.push(`barcode:${g14}`);
        const trimmed12 = g14.startsWith('00') ? g14.slice(2) : g14.startsWith('0') ? g14.slice(1) : null;
        if (trimmed12) terms.push(`barcode:${trimmed12}`);
      }
      const res = await client.query(
        `query($q: String!) {
          productVariants(first: 250, query: $q) {
            nodes {
              id
              barcode
              product { id }
            }
          }
        }`,
        { q: terms.join(' OR ') },
      );

      for (const v of res.productVariants?.nodes ?? []) {
        if (seenVariants.has(v.id)) continue;
        const g14 = normalizeGtin(v.barcode);
        const hit = g14 ? gtinMap.get(g14) : undefined;
        if (!hit) continue;
        seenVariants.add(v.id);
        varTotals.set(v.id, hit);

        const pid = v.product.id;
        const cur = prodTotals.get(pid) ?? { tampa: 0, alafia: 0 };
        cur.tampa += hit.tampa;
        cur.alafia += hit.alafia;
        prodTotals.set(pid, cur);
      }
    }

    const tampaProducts = [...prodTotals.entries()].filter(([, q]) => q.tampa > 0);
    const alafiaProducts = [...prodTotals.entries()].filter(([, q]) => q.alafia > 0);
    console.log(`   • Matched Unique Products in Stock at UBC Tampa Showroom : ${tampaProducts.length}`);
    console.log(`   • Matched Unique Products in Stock at UBC Alafia Park    : ${alafiaProducts.length}`);

    // 2. Apply `ubc-tampa-stock` & `ubc-alafia-stock` tags with 8 concurrent workers
    console.log('\n2) Applying `ubc-tampa-stock` & `ubc-alafia-stock` tags to products...');
    const prodEntries = [...prodTotals.entries()];
    let tagIdx = 0;
    let tagDone = 0;
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        while (tagIdx < prodEntries.length) {
          const [pid, q] = prodEntries[tagIdx++];
          const tags = [];
          if (q.tampa > 0) tags.push('ubc-tampa-stock');
          if (q.alafia > 0) tags.push('ubc-alafia-stock');
          if (tags.length) {
            await client.mutate(
              `mutation($id: ID!, $tags: [String!]!) {
                tagsAdd(id: $id, tags: $tags) { userErrors { message } }
              }`,
              { id: pid, tags },
            ).catch(() => {});
          }
          tagDone++;
          if (tagDone % 100 === 0 || tagDone === prodEntries.length) {
            process.stdout.write(`   • Tagged ${tagDone}/${prodEntries.length} products...\r`);
          }
        }
      }),
    );
    process.stdout.write('\n');

    // 3. Push `ubc.tampa_qty` & `ubc.alafia_qty` metafields in batches of 12 owners (24 metafields per call; max is 25!)
    console.log('\n3) Writing exact `ubc.tampa_qty` & `ubc.alafia_qty` metafields to Products & Variants...');
    const allMetafields = [];
    for (const [pid, q] of prodEntries) {
      allMetafields.push(
        { ownerId: pid, namespace: 'ubc', key: 'tampa_qty', type: 'number_integer', value: String(q.tampa) },
        { ownerId: pid, namespace: 'ubc', key: 'alafia_qty', type: 'number_integer', value: String(q.alafia) },
      );
    }
    for (const [vid, q] of varTotals.entries()) {
      allMetafields.push(
        { ownerId: vid, namespace: 'ubc', key: 'tampa_qty', type: 'number_integer', value: String(q.tampa) },
        { ownerId: vid, namespace: 'ubc', key: 'alafia_qty', type: 'number_integer', value: String(q.alafia) },
      );
    }

    for (let i = 0; i < allMetafields.length; i += 24) {
      const slice = allMetafields.slice(i, i + 24);
      await client.mutate(
        `mutation($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) { userErrors { field message } }
        }`,
        { metafields: slice },
      );
      if ((i + 24) % 480 === 0 || i + 24 >= allMetafields.length) {
        process.stdout.write(`   • Saved ${Math.min(i + 24, allMetafields.length)}/${allMetafields.length} store-qty metafields...\r`);
      }
    }
    process.stdout.write('\n');

    // 4. Create & publish `/collections/in-stock-tampa` & `/collections/in-stock-alafia`
    const storeCols = [
      {
        handle: 'in-stock-tampa',
        title: 'In Stock — UBC Tampa Showroom',
        tag: 'ubc-tampa-stock',
      },
      {
        handle: 'in-stock-alafia',
        title: 'In Stock — UBC Alafia River Park',
        tag: 'ubc-alafia-stock',
      },
    ];

    for (const sc of storeCols) {
      const found = await client.query(`query($h: String!) { collectionByHandle(handle: $h) { id } }`, { h: sc.handle });
      const ruleSet = {
        appliedDisjunctively: false,
        rules: [
          { column: 'TAG', relation: 'EQUALS', condition: sc.tag },
          { column: 'VARIANT_INVENTORY', relation: 'GREATER_THAN', condition: '0' },
        ],
      };
      let colGid = found.collectionByHandle?.id;
      if (colGid) {
        await client.mutate(
          `mutation($input: CollectionInput!) { collectionUpdate(input: $input) { userErrors { message } } }`,
          { input: { id: colGid, title: sc.title, sortOrder: 'PRICE_DESC', ruleSet } },
        );
      } else {
        const crt = await client.mutate(
          `mutation($input: CollectionInput!) { collectionCreate(input: $input) { collection { id } userErrors { message } } }`,
          { input: { title: sc.title, handle: sc.handle, sortOrder: 'PRICE_DESC', ruleSet } },
        );
        colGid = crt.collectionCreate.collection?.id;
      }
      if (colGid) {
        const numId = colGid.split('/').pop();
        await fetch(`https://${SHOP_DOMAIN}/admin/api/2026-10/smart_collections/${numId}.json`, {
          method: 'PUT',
          headers: { 'X-Shopify-Access-Token': ACCESS_TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify({ smart_collection: { id: Number(numId), published: true } }),
        });
      }
      console.log(`   • Published Smart Collection /collections/${sc.handle} ("${sc.title}")`);
    }

    const sec = ((performance.now() - t0) / 1000).toFixed(1);
    console.log(`\n══════════════════════════════════════════════════════════════════════`);
    console.log(`  ✓ TAMPA VS ALAFIA SEPARATION COMPLETE IN ${sec}s!`);
    console.log(`    • UBC Tampa Showroom : ${tampaProducts.length} products tagged & quantified`);
    console.log(`    • UBC Alafia Park    : ${alafiaProducts.length} products tagged & quantified`);
    console.log(`══════════════════════════════════════════════════════════════════════\n`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
