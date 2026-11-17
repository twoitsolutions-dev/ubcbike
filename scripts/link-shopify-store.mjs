/**
 * Links Hub variants that come from Lightspeed (#114391) to the variants that ALREADY exist in a
 * Shopify store whose catalog is owned by another app (UBC's real store: catalog from Workstand).
 *
 * Match = barcode (UPC/EAN normalized to GTIN-14, so Workstand's "00"-prefixed UPCs match Lightspeed's).
 * Every color/size of a matrix is its own Lightspeed item with its own UPC, so each Shopify variant is
 * matched individually.
 *
 *   node --env-file=.env scripts/link-shopify-store.mjs            # DRY RUN: read-only report, writes nothing
 *   node --env-file=.env scripts/link-shopify-store.mjs --apply    # save links + queue the first price/stock push
 *
 * Store: UBC_LIVE_SHOPIFY_DOMAIN / UBC_LIVE_SHOPIFY_ACCESS_TOKEN (override with --shop / env).
 * Never creates, deletes or edits products here; --apply only writes to the Hub database.
 */
import { normalizeGtin } from '../packages/business-rules/dist/index.js';
import { createPool } from '../packages/database/dist/index.js';

const APPLY = process.argv.includes('--apply');
const shopArg = process.argv.find((a) => a.startsWith('--shop='));
const SHOP = (shopArg ? shopArg.slice(7) : process.env.UBC_LIVE_SHOPIFY_DOMAIN || '').toLowerCase();
const TOKEN = process.env.UBC_LIVE_SHOPIFY_ACCESS_TOKEN;
const API = process.env.SHOPIFY_API_VERSION || '2025-10';
if (!SHOP || !TOKEN) throw new Error('Set UBC_LIVE_SHOPIFY_DOMAIN and UBC_LIVE_SHOPIFY_ACCESS_TOKEN');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cents = (s) => (s === null || s === undefined || s === '' ? null : Math.round(Number(s) * 100));
const money = (c) => (c === null || c === undefined ? '—' : `$${(c / 100).toFixed(2)}`);

async function gql(query, variables = {}) {
  const res = await fetch(`https://${SHOP}/admin/api/${API}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  const j = await res.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 400));
  return j.data;
}

/** Read every variant of the store with a Shopify bulk query (read-only). */
async function readAllVariants() {
  const cur = await gql(`{ currentBulkOperation(type: QUERY) { id status } }`);
  if (cur.currentBulkOperation && ['CREATED', 'RUNNING'].includes(cur.currentBulkOperation.status)) {
    throw new Error('Another bulk query is running on this store; try again in a few minutes.');
  }
  const run = await gql(`mutation { bulkOperationRunQuery(query: """
    { productVariants { edges { node {
        id sku barcode price compareAtPrice inventoryQuantity displayName
        inventoryItem { id tracked }
        product { id status }
    } } } }
  """) { bulkOperation { id status } userErrors { field message } } }`);
  const ue = run.bulkOperationRunQuery.userErrors;
  if (ue.length) throw new Error(JSON.stringify(ue));
  process.stdout.write('   reading store variants (Shopify bulk query)');
  for (;;) {
    await sleep(4000);
    const s = (await gql(`{ currentBulkOperation(type: QUERY) { status errorCode objectCount url } }`)).currentBulkOperation;
    process.stdout.write('.');
    if (s.status === 'COMPLETED') {
      process.stdout.write(` ${s.objectCount} objects\n`);
      if (!s.url) return [];
      const txt = await (await fetch(s.url)).text();
      return txt.trim() ? txt.trim().split('\n').map((l) => JSON.parse(l)) : [];
    }
    if (['FAILED', 'CANCELED', 'EXPIRED'].includes(s.status)) throw new Error(`Bulk query ${s.status} ${s.errorCode ?? ''}`);
  }
}

async function main() {
  console.log(`\n${APPLY ? 'APPLY' : 'DRY RUN (read-only)'} — link Lightspeed items to ${SHOP}\n`);
  const pool = createPool(process.env.DATABASE_URL);
  try {
    const companyId = (await pool.query(`SELECT id FROM companies WHERE slug = 'twoit-sandbox' LIMIT 1`)).rows[0].id;

    const locs = (await gql(`{ locations(first: 25) { nodes { id name isActive fulfillsOnlineOrders } } }`)).locations.nodes;
    console.log('1) Store locations:');
    for (const l of locs) console.log(`   • ${l.name} ${l.isActive ? '' : '(inactive)'} ${l.fulfillsOnlineOrders ? '· fulfills online' : ''}  ${l.id}`);

    const hub = await pool.query(
      `SELECT v.id, v.upc, v.title, v.price_cents, v.compare_at_cents, v.map_cents,
              COALESCE((SELECT sum(il.on_hand)::int FROM inventory_levels il WHERE il.variant_id = v.id), 0) AS on_hand
       FROM variants v
       JOIN external_ids e ON e.company_id = v.company_id AND e.entity_type = 'variant' AND e.entity_id = v.id AND e.system = 'lightspeed_r'
       WHERE v.company_id = $1`,
      [companyId],
    );
    const groups = new Map();
    let hubNoBarcode = 0;
    for (const v of hub.rows) {
      const g = normalizeGtin(v.upc);
      if (!g) { hubNoBarcode++; continue; }
      groups.set(g, [...(groups.get(g) ?? []), v]);
    }
    // Same UPC on several Lightspeed items (usually "EACH" vs a bulk pack, or an old and a new version).
    // Pick one only when there is no doubt: the only one with stock, else the only single unit; otherwise skip.
    const isPack = (t) => /\b(\d+\s*(pcs?|pk|pack|box|ct|bx|bag)|bulk|case|\d{2,}p)\b/i.test(String(t ?? ''));
    const hubByGtin = new Map();
    const dupGtin = new Set();
    let dupResolved = 0;
    for (const [g, vs] of groups) {
      if (vs.length === 1) { hubByGtin.set(g, vs[0]); continue; }
      const stocked = vs.filter((v) => v.on_hand > 0);
      const singles = vs.filter((v) => !isPack(v.title));
      const pick = stocked.length === 1 ? stocked[0] : (stocked.length === 0 && singles.length === 1 ? singles[0] : null);
      if (pick) { hubByGtin.set(g, pick); dupResolved++; } else dupGtin.add(g);
    }
    console.log(`\n2) Hub items from Lightspeed: ${hub.rows.length.toLocaleString('en-US')} (${hubNoBarcode.toLocaleString('en-US')} without barcode; repeated UPCs: ${dupResolved} resolved, ${dupGtin.size} left for review)`);

    const nodes = await readAllVariants();
    const links = [];
    const matchedHub = new Set();
    let storeNoBarcode = 0;
    let priceDiff = 0;
    let qtyDiff = 0;
    let untracked = 0;
    const samples = [];
    for (const n of nodes) {
      if (!n.id?.includes('ProductVariant')) continue;
      const g = normalizeGtin(n.barcode);
      if (!g) { storeNoBarcode++; continue; }
      if (dupGtin.has(g)) continue;
      const v = hubByGtin.get(g);
      if (!v) continue;
      matchedHub.add(v.id);
      const sp = cents(n.price);
      const sc = cents(n.compareAtPrice);
      const targetC = v.compare_at_cents && v.compare_at_cents > v.price_cents ? v.compare_at_cents : null;
      const differs = v.price_cents > 0 && (sp !== v.price_cents || (sc && sc > sp ? sc : null) !== targetC);
      if (differs) {
        priceDiff++;
        if (samples.length < 12) samples.push(`   • ${n.displayName.slice(0, 70)}: Shopify ${money(sp)}${sc && sc > sp ? ` (was ${money(sc)})` : ''} → Lightspeed ${money(v.price_cents)}${targetC ? ` (was ${money(targetC)})` : ''}`);
      }
      if ((n.inventoryQuantity ?? 0) !== v.on_hand) qtyDiff++;
      if (n.inventoryItem && !n.inventoryItem.tracked) untracked++;
      links.push({
        vid: v.id, pid: n.product?.id ?? n.__parentId, svid: n.id, inv: n.inventoryItem?.id ?? null,
        // last_* = what the store has NOW, so the first push only sends real differences.
        p: sp, c: sc && sc > sp ? sc : null, q: n.inventoryQuantity ?? null,
      });
    }
    const variantsInStore = nodes.filter((n) => n.id?.includes('ProductVariant')).length;
    console.log(`\n3) Store variants: ${variantsInStore.toLocaleString('en-US')} (${storeNoBarcode.toLocaleString('en-US')} without barcode)`);
    console.log(`   Lightspeed items found in the store : ${matchedHub.size.toLocaleString('en-US')}`);
    console.log(`   Store variants linked               : ${links.length.toLocaleString('en-US')} (some Lightspeed items appear in more than one Shopify product)`);
    console.log(`   Price/sale differs from Lightspeed  : ${priceDiff.toLocaleString('en-US')}`);
    console.log(`   Stock differs from Lightspeed       : ${qtyDiff.toLocaleString('en-US')}`);
    console.log(`   Linked variants with untracked stock: ${untracked.toLocaleString('en-US')}`);
    if (samples.length) console.log(`\n   Examples that would change:\n${samples.join('\n')}`);

    if (!APPLY) {
      console.log('\nDRY RUN — nothing was written. Re-run with --apply to save the links.\n');
      return;
    }

    await pool.query(`DELETE FROM shopify_variant_links WHERE company_id = $1 AND shop_domain = $2`, [companyId, SHOP]);
    for (let i = 0; i < links.length; i += 2000) {
      await pool.query(
        `INSERT INTO shopify_variant_links (company_id, shop_domain, variant_id, shopify_product_id, shopify_variant_id, shopify_inventory_item_id,
                                            match_method, last_price_cents, last_compare_at_cents, last_qty)
         SELECT $1, $2, r.vid, r.pid, r.svid, r.inv, 'barcode', r.p, r.c, r.q
         FROM jsonb_to_recordset($3::jsonb) AS r(vid uuid, pid text, svid text, inv text, p int, c int, q int)
         ON CONFLICT (company_id, shop_domain, shopify_variant_id) DO NOTHING`,
        [companyId, SHOP, JSON.stringify(links.slice(i, i + 2000))],
      );
    }
    console.log(`\n✓ Saved ${links.length.toLocaleString('en-US')} links.`);

    // First push: price + sale price only (stock is already synced by Workstand per location).
    // Done here directly (not through the queue) and logged in shopify_price_log with the old value.
    const hubById = new Map(hub.rows.map((v) => [v.id, v]));
    const saved = await pool.query(`SELECT id, variant_id, shopify_product_id, shopify_variant_id, last_price_cents, last_compare_at_cents FROM shopify_variant_links WHERE company_id = $1 AND shop_domain = $2`, [companyId, SHOP]);
    const byProduct = new Map();
    let belowMap = 0;
    for (const l of saved.rows) {
      const v = hubById.get(l.variant_id);
      if (!v || !(v.price_cents > 0)) continue;
      if (v.map_cents && v.price_cents < v.map_cents) { belowMap++; continue; }
      const c = v.compare_at_cents && v.compare_at_cents > v.price_cents ? v.compare_at_cents : null;
      if (v.price_cents === l.last_price_cents && c === (l.last_compare_at_cents ?? null)) continue;
      const arr = byProduct.get(l.shopify_product_id) ?? [];
      arr.push({ l, p: v.price_cents, c });
      byProduct.set(l.shopify_product_id, arr);
    }
    const total = [...byProduct.values()].reduce((n, a) => n + a.length, 0);
    console.log(`   Pushing ${total.toLocaleString('en-US')} price changes in ${byProduct.size.toLocaleString('en-US')} products (${belowMap} held: below MAP)...`);
    let done = 0;
    let failed = 0;
    const entries = [...byProduct.entries()];
    let idx = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (idx < entries.length) {
        const [productId, ups] = entries[idx++];
        try {
          const data = await gql(
            `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
               productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { field message } } }`,
            { productId, variants: ups.map((u) => ({ id: u.l.shopify_variant_id, price: (u.p / 100).toFixed(2), compareAtPrice: u.c ? (u.c / 100).toFixed(2) : null })) },
          );
          const errs = data.productVariantsBulkUpdate.userErrors;
          if (errs.length) throw new Error(errs.map((e) => e.message).join('; '));
          await pool.query(
            `INSERT INTO shopify_price_log (company_id, shop_domain, variant_id, shopify_variant_id, old_price_cents, old_compare_at_cents, new_price_cents, new_compare_at_cents, source)
             SELECT $1, $2, r.vid, r.svid, r.op, r.oc, r.np, r.nc, 'lightspeed_initial_link'
             FROM jsonb_to_recordset($3::jsonb) AS r(vid uuid, svid text, op int, oc int, np int, nc int)`,
            [companyId, SHOP, JSON.stringify(ups.map((u) => ({ vid: u.l.variant_id, svid: u.l.shopify_variant_id, op: u.l.last_price_cents, oc: u.l.last_compare_at_cents, np: u.p, nc: u.c })))],
          );
          await pool.query(
            `UPDATE shopify_variant_links l SET last_price_cents = r.p, last_compare_at_cents = r.c, last_pushed_at = now(), updated_at = now()
             FROM jsonb_to_recordset($1::jsonb) AS r(id bigint, p int, c int) WHERE l.id = r.id`,
            [JSON.stringify(ups.map((u) => ({ id: u.l.id, p: u.p, c: u.c })))],
          );
          done += ups.length;
        } catch (err) {
          failed += ups.length;
          console.log(`   ! ${productId}: ${err.message.slice(0, 160)}`);
        }
        if ((done + failed) % 250 < ups.length) console.log(`   • ${done + failed}/${total}`);
      }
    }));
    console.log(`\n✓ First push done: ${done.toLocaleString('en-US')} prices updated, ${failed} failed. Old values saved in shopify_price_log.\n`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('link-shopify-store failed:', err.message);
  process.exit(1);
});
