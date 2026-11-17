/**
 * Fast, idempotent live sync of Carlos's real Tampa & Alafia stock (`#114391`) into
 * `z5wxyn-uc.myshopify.com` (`University Bicycle Center` + `UBC at Alafia River State Park`),
 * activating each inventory item at its physical store location via `inventoryActivate @idempotent`
 * so `inventoryQuantity > 0` updates immediately across all 21 Lightspeed-mirrored Smart Collections!
 */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { normalizeGtin } from '../packages/business-rules/dist/index.js';
import { ShopifyAdminClient } from '../packages/integrations/dist/index.js';
import { createPool } from '../packages/database/dist/index.js';

const SHOP_DOMAIN = process.env.UBC_LIVE_SHOPIFY_DOMAIN || 'z5wxyn-uc.myshopify.com';
const ACCESS_TOKEN = process.env.UBC_LIVE_SHOPIFY_ACCESS_TOKEN;

const TAMPA_SHOPIFY_LOC = 'gid://shopify/Location/109716930877'; // University Bicycle Center
const ALAFIA_SHOPIFY_LOC = 'gid://shopify/Location/109676560701'; // UBC at Alafia River State Park

async function activateAndSetBatch(client, locationId, label, items) {
  if (!items.length) return;
  let done = 0;
  const CONCURRENCY = 8;
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const cur = items[idx++];
      try {
        const act = await client.mutate(
          `mutation($inventoryItemId: ID!, $locationId: ID!, $available: Int, $k: String!) {
            inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId, available: $available) @idempotent(key: $k) {
              inventoryLevel { id }
              userErrors { field message }
            }
          }`,
          {
            inventoryItemId: cur.inventoryItemId,
            locationId,
            available: Math.max(0, Math.floor(cur.qty)),
            k: randomUUID(),
          },
        );
        const errs = act.inventoryActivate.userErrors ?? [];
        if (errs.length > 0) {
          // Already activated -> set exact on_hand quantity
          await client.mutate(
            `mutation($input: InventorySetQuantitiesInput!, $k: String!) {
              inventorySetQuantities(input: $input) @idempotent(key: $k) {
                userErrors { field message }
              }
            }`,
            {
              k: randomUUID(),
              input: {
                name: 'on_hand',
                reason: 'correction',
                quantities: [{
                  inventoryItemId: cur.inventoryItemId,
                  locationId,
                  quantity: Math.max(0, Math.floor(cur.qty)),
                  changeFromQuantity: null,
                }],
              },
            },
          );
        }
      } catch (e) {
        if (done < 5) console.warn(`  [err] ${e.message}`);
        await new Promise((r) => setTimeout(r, 600));
      }
      done++;
      if (done % 50 === 0 || done === items.length) {
        process.stdout.write(`   • ${label}: activated & stocked ${done}/${items.length} items...\r`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  process.stdout.write('\n');
}

async function main() {
  const t0 = performance.now();
  if (!ACCESS_TOKEN) throw new Error('Missing UBC_LIVE_SHOPIFY_ACCESS_TOKEN in .env');

  const client = new ShopifyAdminClient({
    shopDomain: SHOP_DOMAIN,
    accessToken: ACCESS_TOKEN,
    writesEnabled: true,
  });

  const pool = createPool(process.env.DATABASE_URL);
  try {
    console.log('\n══════════════════════════════════════════════════════════════════════');
    console.log('  UBC Hub · Fast Physical Location Activation & Stock Sync (Tampa + Alafia)');
    console.log('══════════════════════════════════════════════════════════════════════\n');

    const comp = await pool.query(`SELECT id FROM companies WHERE slug = 'twoit-sandbox' LIMIT 1`);
    const companyId = comp.rows[0].id;

    // Only load Lightspeed items that have UPC AND positive stock in Tampa or Alafia!
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
    const duplicateGtins = new Set();
    for (const r of lsInvRows.rows) {
      const g14 = normalizeGtin(r.upc);
      if (!g14) continue;
      if (gtinMap.has(g14)) {
        duplicateGtins.add(g14);
        gtinMap.delete(g14);
      } else if (!duplicateGtins.has(g14)) {
        gtinMap.set(g14, { tampa: r.tampa_qty, alafia: r.alafia_qty });
      }
    }

    // Keep only GTINs with positive stock in Tampa or Alafia!
    const stockedGtins = [...gtinMap.entries()].filter(([, q]) => q.tampa > 0 || q.alafia > 0);
    console.log(`1) Found ${stockedGtins.length.toLocaleString('en-US')} stocked GTINs in Lightspeed (Tampa + Alafia). Querying Shopify by GTIN-14...`);

    const tampaUpdates = [];
    const alafiaUpdates = [];
    const seenInvItems = new Set();

    // Query Shopify directly for those stocked GTIN-14s (both 14-digit "00..." and 12/13-digit forms) in batches of 30!
    const BATCH = 30;
    for (let i = 0; i < stockedGtins.length; i += BATCH) {
      const slice = stockedGtins.slice(i, i + BATCH);
      const terms = [];
      for (const [g14] of slice) {
        terms.push(`barcode:${g14}`);
        const trimmed12 = g14.startsWith('00') ? g14.slice(2) : g14.startsWith('0') ? g14.slice(1) : null;
        if (trimmed12) terms.push(`barcode:${trimmed12}`);
      }
      const qStr = terms.join(' OR ');
      const res = await client.query(
        `query($q: String!) {
          productVariants(first: 250, query: $q) {
            nodes {
              id
              barcode
              inventoryItem { id }
            }
          }
        }`,
        { q: qStr },
      );

      for (const v of res.productVariants?.nodes ?? []) {
        const invId = v.inventoryItem?.id;
        if (!invId || seenInvItems.has(invId)) continue;
        const g14 = normalizeGtin(v.barcode);
        const hit = g14 ? gtinMap.get(g14) : undefined;
        if (!hit) continue;
        seenInvItems.add(invId);
        if (hit.tampa > 0) tampaUpdates.push({ inventoryItemId: invId, qty: hit.tampa });
        if (hit.alafia > 0) alafiaUpdates.push({ inventoryItemId: invId, qty: hit.alafia });
      }

      if ((i + BATCH) % 300 === 0 || i + BATCH >= stockedGtins.length) {
        process.stdout.write(`   Queried ${Math.min(i + BATCH, stockedGtins.length)}/${stockedGtins.length} stocked POS GTINs -> matched Tampa=${tampaUpdates.length}, Alafia=${alafiaUpdates.length}\r`);
      }
    }
    process.stdout.write('\n\n');

    console.log(`2) Activating & setting real stock on Shopify Physical Locations:`);
    await activateAndSetBatch(client, TAMPA_SHOPIFY_LOC, 'Tampa Showroom', tampaUpdates);
    await activateAndSetBatch(client, ALAFIA_SHOPIFY_LOC, 'Alafia River Park', alafiaUpdates);

    console.log('\nWaiting 8s for Shopify Smart Collection indexer to refresh counts...');
    await new Promise((r) => setTimeout(r, 8000));

    const checkCols = await client.query(
      `query {
        collections(first: 40) { nodes { handle title productsCount { count } } }
        inStock: productsCount(query: "inventory_total:>0") { count }
      }`,
    );

    const sec = ((performance.now() - t0) / 1000).toFixed(1);
    console.log(`\n══════════════════════════════════════════════════════════════════════`);
    console.log(`  ✓ COMPLETED IN ${sec}s — REAL STOCK & COLLECTIONS LIVE!`);
    console.log(`  Total In-Stock Products Now on Shopify: ${checkCols.inStock?.count}`);
    console.log(`══════════════════════════════════════════════════════════════════════`);
    for (const n of checkCols.collections.nodes.sort((a, b) => (b.productsCount?.count ?? 0) - (a.productsCount?.count ?? 0))) {
      console.log(`  • /collections/${n.handle.padEnd(24)} -> ${String(n.productsCount?.count ?? 0).padStart(5)} products (${n.title})`);
    }
    console.log(`══════════════════════════════════════════════════════════════════════\n`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
