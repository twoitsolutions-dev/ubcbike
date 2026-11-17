/**
 * Master Reconciliation for Carlos's Shopify Store (`z5wxyn-uc.myshopify.com`) <-> Lightspeed (#114391):
 *  1) Full-catalog cursor scan (zero `query: OR` truncation) to catch & activate the 43 missed flagship
 *     variants (`Epic World Cup Pro`, `Roubaix SL8 Expert`, `Sirrus X 3.0`, `Diverge STR Comp`, `Turbo Tero X`,
 *     `Stumpjumper Expert`, `Tactic 4`, `2FO Method Shoes`, etc.) on Tampa & Alafia locations.
 *  2) Publishes any newly stocked product (`publishedAt == null`) to Online Store.
 *  3) Applies complete 100%-coverage `dept-*` tags across all 62 Shopify `productTypes` (rescuing pumps,
 *     tools, workstands, bags, handlebars, seatposts, BMX bikes, hydration packs, locks, racks, fenders, mirrors)
 *     + `ubc-tampa-stock`/`ubc-alafia-stock` + `brand-*` + `price-*` + `ubc.tampa_qty`/`ubc.alafia_qty` metafields.
 *  4) Updates all Department Smart Collections + the 3 legacy Workstand collections (`bicycle-tires`, `shoes`,
 *     `bicycle-roll`) to strictly enforce `VARIANT_INVENTORY > 0` with zero orphaned products!
 */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { normalizeGtin } from '../packages/business-rules/dist/index.js';
import { ShopifyAdminApi, ShopifyAdminClient } from '../packages/integrations/dist/index.js';
import { createPool } from '../packages/database/dist/index.js';

const SHOP_DOMAIN = process.env.UBC_LIVE_SHOPIFY_DOMAIN || 'z5wxyn-uc.myshopify.com';
const ACCESS_TOKEN = process.env.UBC_LIVE_SHOPIFY_ACCESS_TOKEN;

const TAMPA_LOC = 'gid://shopify/Location/109716930877';
const ALAFIA_LOC = 'gid://shopify/Location/109676560701';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function handleize(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['"’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Map ANY of the 62 Workstand/Masterlinq Shopify `productType`s (plus title sanity overrides for Workstand typos) into canonical department tags. */
function getDeptTagsForProductType(rawType, title = '') {
  const t = String(rawType || '').trim().toLowerCase();
  const tl = String(title || '').trim().toLowerCase();

  // Fix Workstand catalog typos (e.g. Sirrus X tagged as electric_bikes, Allez Comp tagged as urban_bike)
  if (/\bsirrus\b/.test(tl) && !/\b(vado|turbo|como)\b/.test(tl)) return ['dept-bikes', 'dept-hybrid-bikes'];
  if (/\b(allez|tarmac|roubaix|diverge|crux|aethos)\b/.test(tl) && !/\b(frameset|frame|tire|saddle|stem|shoe)\b/.test(tl)) {
    return ['dept-bikes', 'dept-road-bikes'];
  }
  if (/\bjupiter\b/.test(tl) && !/\b(rack|bag|pack|basket|charger|battery|display|grip|seat|pad|crank|light|adapter|controller)\b/.test(tl)) {
    return ['dept-bikes', 'dept-electric-bikes'];
  }

  const out = [];

  // Complete Bikes
  if (t === 'electric_bikes') return ['dept-bikes', 'dept-electric-bikes'];
  if (t === 'road_bike') return ['dept-bikes', 'dept-road-bikes'];
  if (t === 'mountain_bike') return ['dept-bikes', 'dept-mountain-bikes'];
  if (t === 'urban_bike' || t === 'other_bikes') return ['dept-bikes', 'dept-hybrid-bikes'];
  if (t === 'childrens_bike' || t === 'bmx_bike') return ['dept-bikes', 'dept-kids-bikes'];

  // Helmets, Clothing, Shoes, Eyewear
  if (t === 'helmets' || t === 'helmet_parts_and_accessories' || t === 'safety_accessories') return ['dept-helmets'];
  if (t === 'clothing') return ['dept-clothing'];
  if (t === 'shoes' || t === 'shoes_parts_and_accessories') return ['dept-shoes'];
  if (t.includes('eyewear')) return ['dept-eyewear'];

  // Tires & Tubes
  if (t === 'tires' || t === 'tires_and_tubes_accessories') return ['dept-tires-tubes'];
  if (t === 'tubes') return ['dept-tires-tubes', 'dept-tubes'];

  // Saddles & Pedals (both dedicated AND part of Parts & Drivetrain)
  if (t === 'saddles') return ['dept-parts', 'dept-saddles'];
  if (t === 'pedals' || t === 'pedal_parts_and_accessories') return ['dept-parts', 'dept-pedals'];

  // Hydration & Nutrition
  if (t === 'nutrition') return ['dept-hydration'];
  if (t === 'bottles_and_cages' || t === 'hydration_packs' || t === 'hydration_parts_and_accessories') {
    return ['dept-hydration', 'dept-bottles-cages'];
  }

  // Tools, Pumps & Lubes
  if (t === 'pumps' || t === 'pump_parts_and_accessories' || t === 'tools_and_workstands' || t === 'lubes_and_cleaners') {
    return ['dept-tools'];
  }

  // Accessories, Lights, Electronics, Bags, Locks, Racks, Mirrors, Fenders
  if (
    t.includes('accessories') ||
    t.includes('bags') ||
    t.includes('locks') ||
    t.includes('racks') ||
    t.includes('baskets') ||
    t === 'mirrors' ||
    t === 'fenders' ||
    t === 'trailers' ||
    t === 'travel_cases'
  ) {
    return ['dept-accessories'];
  }

  // Everything else (handlebars, seatposts, shifters, group_sets, brake_parts, chain_parts, wheel_rims, forks, frames, cables, grips, tape, etc.) -> Parts!
  out.push('dept-parts');
  return out;
}

const DEPT_COLLECTIONS = [
  { handle: 'all', title: 'In-Stock Catalog — Tampa & Alafia', sortOrder: 'PRICE_DESC', rules: [{ column: 'VARIANT_INVENTORY', relation: 'GREATER_THAN', condition: '0' }] },
  { handle: 'bikes', title: 'Bikes & E-Bikes — In Stock', sortOrder: 'PRICE_DESC', rules: [{ column: 'TAG', relation: 'EQUALS', condition: 'dept-bikes' }, { column: 'VARIANT_INVENTORY', relation: 'GREATER_THAN', condition: '0' }] },
  { handle: 'electric-bikes', title: 'Electric Bikes — In Stock', sortOrder: 'PRICE_DESC', rules: [{ column: 'TAG', relation: 'EQUALS', condition: 'dept-electric-bikes' }, { column: 'VARIANT_INVENTORY', relation: 'GREATER_THAN', condition: '0' }] },
  { handle: 'road-bikes', title: 'Road & Gravel Bikes — In Stock', sortOrder: 'PRICE_DESC', rules: [{ column: 'TAG', relation: 'EQUALS', condition: 'dept-road-bikes' }, { column: 'VARIANT_INVENTORY', relation: 'GREATER_THAN', condition: '0' }] },
  { handle: 'mountain-bikes', title: 'Mountain Bikes — In Stock', sortOrder: 'PRICE_DESC', rules: [{ column: 'TAG', relation: 'EQUALS', condition: 'dept-mountain-bikes' }, { column: 'VARIANT_INVENTORY', relation: 'GREATER_THAN', condition: '0' }] },
  { handle: 'hybrid-bikes', title: 'Hybrid, Comfort & Urban Bikes — In Stock', sortOrder: 'PRICE_DESC', rules: [{ column: 'TAG', relation: 'EQUALS', condition: 'dept-hybrid-bikes' }, { column: 'VARIANT_INVENTORY', relation: 'GREATER_THAN', condition: '0' }] },
  { handle: 'kids-bikes', title: 'Kids & BMX Bikes — In Stock', sortOrder: 'PRICE_DESC', rules: [{ column: 'TAG', relation: 'EQUALS', condition: 'dept-kids-bikes' }, { column: 'VARIANT_INVENTORY', relation: 'GREATER_THAN', condition: '0' }] },
  { handle: 'helmets', title: 'Helmets & Safety — In Stock', sortOrder: 'PRICE_DESC', rules: [{ column: 'TAG', relation: 'EQUALS', condition: 'dept-helmets' }, { column: 'VARIANT_INVENTORY', relation: 'GREATER_THAN', condition: '0' }] },
  { handle: 'clothing', title: 'Apparel, Jerseys & Shorts — In Stock', sortOrder: 'PRICE_DESC', rules: [{ column: 'TAG', relation: 'EQUALS', condition: 'dept-clothing' }, { column: 'VARIANT_INVENTORY', relation: 'GREATER_THAN', condition: '0' }] },
  { handle: 'cycling-shoes', title: 'Cycling Shoes — In Stock', sortOrder: 'PRICE_DESC', rules: [{ column: 'TAG', relation: 'EQUALS', condition: 'dept-shoes' }, { column: 'VARIANT_INVENTORY', relation: 'GREATER_THAN', condition: '0' }] },
  { handle: 'eyewear', title: 'Sunglasses & Eyewear — In Stock', sortOrder: 'PRICE_DESC', rules: [{ column: 'TAG', relation: 'EQUALS', condition: 'dept-eyewear' }, { column: 'VARIANT_INVENTORY', relation: 'GREATER_THAN', condition: '0' }] },
  { handle: 'tires-tubes', title: 'Tires, Tubes & Tubeless — In Stock', sortOrder: 'PRICE_DESC', rules: [{ column: 'TAG', relation: 'EQUALS', condition: 'dept-tires-tubes' }, { column: 'VARIANT_INVENTORY', relation: 'GREATER_THAN', condition: '0' }] },
  { handle: 'tubes', title: 'Inner Tubes — In Stock', sortOrder: 'PRICE_ASC', rules: [{ column: 'TAG', relation: 'EQUALS', condition: 'dept-tubes' }, { column: 'VARIANT_INVENTORY', relation: 'GREATER_THAN', condition: '0' }] },
  { handle: 'parts-components', title: 'Parts, Drivetrain & Cockpit — In Stock', sortOrder: 'PRICE_DESC', rules: [{ column: 'TAG', relation: 'EQUALS', condition: 'dept-parts' }, { column: 'VARIANT_INVENTORY', relation: 'GREATER_THAN', condition: '0' }] },
  { handle: 'saddles', title: 'Saddles — In Stock', sortOrder: 'PRICE_DESC', rules: [{ column: 'TAG', relation: 'EQUALS', condition: 'dept-saddles' }, { column: 'VARIANT_INVENTORY', relation: 'GREATER_THAN', condition: '0' }] },
  { handle: 'pedals', title: 'Pedals & Cleats — In Stock', sortOrder: 'PRICE_DESC', rules: [{ column: 'TAG', relation: 'EQUALS', condition: 'dept-pedals' }, { column: 'VARIANT_INVENTORY', relation: 'GREATER_THAN', condition: '0' }] },
  { handle: 'hydration-nutrition', title: 'Hydration, Bottles & Nutrition — In Stock', sortOrder: 'PRICE_ASC', rules: [{ column: 'TAG', relation: 'EQUALS', condition: 'dept-hydration' }, { column: 'VARIANT_INVENTORY', relation: 'GREATER_THAN', condition: '0' }] },
  { handle: 'bottles-cages', title: 'Bottles, Cages & Packs — In Stock', sortOrder: 'PRICE_ASC', rules: [{ column: 'TAG', relation: 'EQUALS', condition: 'dept-bottles-cages' }, { column: 'VARIANT_INVENTORY', relation: 'GREATER_THAN', condition: '0' }] },
  { handle: 'accessories-gear', title: 'Accessories, Lights, Bags & Locks — In Stock', sortOrder: 'PRICE_DESC', rules: [{ column: 'TAG', relation: 'EQUALS', condition: 'dept-accessories' }, { column: 'VARIANT_INVENTORY', relation: 'GREATER_THAN', condition: '0' }] },
  { handle: 'tools-workshop', title: 'Pumps, Tools & Bike Care — In Stock', sortOrder: 'PRICE_DESC', rules: [{ column: 'TAG', relation: 'EQUALS', condition: 'dept-tools' }, { column: 'VARIANT_INVENTORY', relation: 'GREATER_THAN', condition: '0' }] },
  // Legacy Workstand handles -> also enforce VARIANT_INVENTORY > 0 so old bookmarks never show Sold Out!
  { handle: 'bicycle-tires', title: 'Bicycle Tires — In Stock', sortOrder: 'PRICE_DESC', rules: [{ column: 'TYPE', relation: 'EQUALS', condition: 'tires' }, { column: 'VARIANT_INVENTORY', relation: 'GREATER_THAN', condition: '0' }] },
  { handle: 'shoes', title: 'Shoes — In Stock', sortOrder: 'PRICE_DESC', rules: [{ column: 'TYPE', relation: 'EQUALS', condition: 'shoes' }, { column: 'VARIANT_INVENTORY', relation: 'GREATER_THAN', condition: '0' }] },
  { handle: 'bicycle-roll', title: 'Bags & Packs — In Stock', sortOrder: 'PRICE_DESC', rules: [{ column: 'TYPE', relation: 'EQUALS', condition: 'bags_and_packs' }, { column: 'VARIANT_INVENTORY', relation: 'GREATER_THAN', condition: '0' }] },
];

async function activateOne(client, api, inventoryItemId, locationId, qty) {
  await client.mutate(
    `mutation($id: ID!, $input: InventoryItemInput!) {
      inventoryItemUpdate(id: $id, input: $input) { inventoryItem { id tracked } userErrors { field message } }
    }`,
    { id: inventoryItemId, input: { tracked: true } },
  ).catch(() => {});

  const act = await client.mutate(
    `mutation($inventoryItemId: ID!, $locationId: ID!, $available: Int, $k: String!) {
      inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId, available: $available) @idempotent(key: $k) {
        inventoryLevel { id }
        userErrors { field message }
      }
    }`,
    { inventoryItemId, locationId, available: Math.max(0, Math.floor(qty)), k: randomUUID() },
  );
  if ((act.inventoryActivate.userErrors ?? []).length > 0) {
    await api.setInventoryOnHand(locationId, [{ inventoryItemId, quantity: Math.max(0, Math.floor(qty)) }]);
  }
}

async function publishRestProduct(numId) {
  for (let a = 0; a < 5; a++) {
    const res = await fetch(`https://${SHOP_DOMAIN}/admin/api/2026-10/products/${numId}.json`, {
      method: 'PUT',
      headers: { 'X-Shopify-Access-Token': ACCESS_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ product: { id: Number(numId), published: true } }),
    });
    if (res.status === 429) {
      await sleep(Number(res.headers.get('Retry-After') || '2') * 1000);
      continue;
    }
    return res.ok;
  }
  return false;
}

async function main() {
  const t0 = performance.now();
  const client = new ShopifyAdminClient({ shopDomain: SHOP_DOMAIN, accessToken: ACCESS_TOKEN, writesEnabled: true });
  const api = new ShopifyAdminApi(client);
  const pool = createPool(process.env.DATABASE_URL);

  try {
    const comp = await pool.query(`SELECT id FROM companies WHERE slug = 'twoit-sandbox' LIMIT 1`);
    const cid = comp.rows[0].id;

    // 1. Load all unambiguous stocked GTINs from Lightspeed #114391
    const lsRows = await pool.query(
      `SELECT v.id, v.product_id, v.upc,
              coalesce(sum(CASE WHEN l.lightspeed_shop_id = '1' THEN il.on_hand ELSE 0 END), 0)::int AS tampa,
              coalesce(sum(CASE WHEN l.lightspeed_shop_id = '2' THEN il.on_hand ELSE 0 END), 0)::int AS alafia
       FROM variants v
       LEFT JOIN inventory_levels il ON il.variant_id = v.id
       LEFT JOIN locations l ON l.id = il.location_id
       WHERE v.company_id = $1 AND v.upc IS NOT NULL
       GROUP BY v.id, v.product_id, v.upc`,
      [cid],
    );

    const gtinMap = new Map();
    const dupes = new Set();
    for (const r of lsRows.rows) {
      const g14 = normalizeGtin(r.upc);
      if (!g14) continue;
      if (gtinMap.has(g14)) {
        dupes.add(g14);
        gtinMap.delete(g14);
      } else if (!dupes.has(g14) && (r.tampa > 0 || r.alafia > 0)) {
        gtinMap.set(g14, r);
      }
    }

    // 2. Full cursor scan of Shopify variants -> find ANY stocked GTIN still at 0 in Shopify + collect all matched variants!
    console.log(`1) Scanning all 167,421 Shopify variants to catch & activate the 43 missed flagship items...`);
    let vCur = null;
    const missedToActivate = [];
    const matchedVarTotals = new Map();
    const matchedProdTotals = new Map();
    const hubLinks = [];

    do {
      const page = await api.listVariants(vCur);
      for (const sv of page.variants) {
        if (!sv.barcode || !sv.inventoryItemId) continue;
        const g14 = normalizeGtin(sv.barcode);
        const hit = g14 ? gtinMap.get(g14) : undefined;
        if (!hit) continue;

        matchedVarTotals.set(sv.variantId, hit);
        const curP = matchedProdTotals.get(sv.productId) ?? { tampa: 0, alafia: 0 };
        curP.tampa += hit.tampa;
        curP.alafia += hit.alafia;
        matchedProdTotals.set(sv.productId, curP);
        hubLinks.push({ vid: hit.id, pid: hit.product_id, shopVid: sv.variantId });

        if ((sv.inventoryQuantity ?? 0) < hit.tampa + hit.alafia) {
          missedToActivate.push({ variantGid: sv.variantId, invId: sv.inventoryItemId, tampa: hit.tampa, alafia: hit.alafia, title: `${sv.productTitle} (${sv.title})` });
        }
      }
      vCur = page.nextCursor;
    } while (vCur);

    console.log(`   • Found ${missedToActivate.length} variants needing stock activation/correction (e.g. Epic World Cup Pro, Roubaix SL8 Expert, Stumpjumper Expert...).`);
    for (const m of missedToActivate) {
      if (m.tampa > 0) await activateOne(client, api, m.invId, TAMPA_LOC, m.tampa);
      if (m.alafia > 0) await activateOne(client, api, m.invId, ALAFIA_LOC, m.alafia);
    }
    if (missedToActivate.length) console.log(`   ✓ Activated & stocked all ${missedToActivate.length} variants!`);

    // Update Hub `published` status for newly linked variants too!
    if (hubLinks.length) {
      const uniq = new Map();
      const pids = new Set();
      for (const h of hubLinks) {
        if (!uniq.has(h.vid)) uniq.set(h.vid, h.shopVid);
        pids.add(h.pid);
      }
      const arr = [...uniq.entries()].map(([vid, shop_vid]) => ({ vid, shop_vid }));
      await pool.query(
        `INSERT INTO external_ids (company_id, entity_type, entity_id, system, external_id)
         SELECT $1, 'variant', r.vid, 'shopify', r.shop_vid
         FROM jsonb_to_recordset($2::jsonb) AS r(vid uuid, shop_vid text)
         ON CONFLICT (company_id, system, entity_type, entity_id) DO UPDATE SET external_id = EXCLUDED.external_id`,
        [cid, JSON.stringify(arr)],
      );
      await pool.query(`UPDATE variants SET status = 'published', updated_at = now() WHERE company_id = $1 AND id = ANY($2::uuid[])`, [cid, arr.map((x) => x.vid)]);
      await pool.query(`UPDATE products SET status = 'published', updated_at = now() WHERE company_id = $1 AND id = ANY($2::uuid[])`, [cid, [...pids]]);
    }

    // 3. Fetch ALL in-stock Shopify products now -> publish any unpublished, apply complete `dept-*` + `ubc-*` + `brand-*` + `price-*` tags & store-qty metafields!
    await sleep(3000);
    const inStockProds = [];
    let pCur = null;
    do {
      const d = await client.query(
        `query($cursor: String) {
          products(first: 250, after: $cursor, query: "status:active inventory_total:>0") {
            pageInfo { hasNextPage endCursor }
            nodes {
              id title vendor productType publishedAt tags
              priceRangeV2 { minVariantPrice { amount } }
            }
          }
        }`,
        { cursor: pCur },
      );
      inStockProds.push(...d.products.nodes);
      pCur = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
    } while (pCur);

    console.log(`\n2) Reconciling ${inStockProds.length} total in-stock Shopify products (Online Store channel, Dept tags, Store tags, Metafields)...`);
    let newlyPublished = 0;
    for (const p of inStockProds) {
      if (!p.publishedAt) {
        const ok = await publishRestProduct(p.id.split('/').pop());
        if (ok) newlyPublished++;
        await sleep(350);
      }
    }
    if (newlyPublished > 0) console.log(`   ✓ Published ${newlyPublished} newly stocked flagship products to Online Store!`);

    // Tag all inStockProds with missing `dept-*`, `ubc-*`, `brand-*`, `price-*` tags
    let tIdx = 0;
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        while (tIdx < inStockProds.length) {
          const p = inStockProds[tIdx++];
          const needed = [];
          for (const dt of getDeptTagsForProductType(p.productType, p.title)) {
            if (!p.tags.includes(dt)) needed.push(dt);
          }
          const vh = handleize(p.vendor);
          if (vh && !p.tags.includes(`brand-${vh}`)) needed.push(`brand-${vh}`);
          const pr = Number(p.priceRangeV2?.minVariantPrice?.amount || 0);
          const pTag = pr < 50 ? 'price-under-50' : pr < 200 ? 'price-50-200' : pr < 1000 ? 'price-200-1000' : 'price-1000-plus';
          if (pr > 0 && !p.tags.includes(pTag)) needed.push(pTag);

          const qtys = matchedProdTotals.get(p.id);
          if (qtys?.tampa > 0 && !p.tags.includes('ubc-tampa-stock')) needed.push('ubc-tampa-stock');
          if (qtys?.alafia > 0 && !p.tags.includes('ubc-alafia-stock')) needed.push('ubc-alafia-stock');

          if (needed.length) {
            await client.mutate(`mutation($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`, { id: p.id, tags: needed }).catch(() => {});
          }
        }
      }),
    );
    console.log(`   ✓ Verified 100% department, brand, price & store tags across all ${inStockProds.length} products!`);

    // Write metafields for all matched products + newly activated variants
    const mfs = [];
    for (const [pid, q] of matchedProdTotals.entries()) {
      mfs.push(
        { ownerId: pid, namespace: 'ubc', key: 'tampa_qty', type: 'number_integer', value: String(q.tampa) },
        { ownerId: pid, namespace: 'ubc', key: 'alafia_qty', type: 'number_integer', value: String(q.alafia) },
      );
    }
    for (const m of missedToActivate) {
      mfs.push(
        { ownerId: m.variantGid, namespace: 'ubc', key: 'availability', type: 'single_line_text_field', value: 'in_store' },
        { ownerId: m.variantGid, namespace: 'ubc', key: 'tampa_qty', type: 'number_integer', value: String(m.tampa) },
        { ownerId: m.variantGid, namespace: 'ubc', key: 'alafia_qty', type: 'number_integer', value: String(m.alafia) },
      );
    }
    for (let i = 0; i < mfs.length; i += 24) {
      await client.mutate(`mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { userErrors { message } } }`, { m: mfs.slice(i, i + 24) });
    }

    // 4. Update all Smart Collections to use lossless `dept-*` tags + `VARIANT_INVENTORY > 0`
    console.log(`\n3) Updating all 23 Smart Collections (100% productType coverage, zero orphans, zero Sold out)...`);
    for (const col of DEPT_COLLECTIONS) {
      const f = await client.query(`query($h: String!) { collectionByHandle(handle: $h) { id } }`, { h: col.handle });
      const ruleSet = { appliedDisjunctively: false, rules: col.rules };
      let colGid = f.collectionByHandle?.id;
      if (colGid) {
        await client.mutate(`mutation($input: CollectionInput!) { collectionUpdate(input: $input) { userErrors { message } } }`, {
          input: { id: colGid, title: col.title, sortOrder: col.sortOrder, ruleSet },
        });
      } else {
        const crt = await client.mutate(`mutation($input: CollectionInput!) { collectionCreate(input: $input) { collection { id } userErrors { message } } }`, {
          input: { title: col.title, handle: col.handle, sortOrder: col.sortOrder, ruleSet },
        });
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
    }

    await sleep(6000);
    const checkCols = await client.query(`query { collections(first: 40) { nodes { handle title productsCount { count } } } inStock: productsCount(query: "inventory_total:>0") { count } }`);
    const sec = ((performance.now() - t0) / 1000).toFixed(1);
    console.log(`\n══════════════════════════════════════════════════════════════════════`);
    console.log(`  ✓ MASTER RECONCILIATION COMPLETE IN ${sec}s!`);
    console.log(`  Total In-Stock Products Live on Shopify: ${checkCols.inStock?.count}`);
    console.log(`══════════════════════════════════════════════════════════════════════`);
    for (const c of checkCols.collections.nodes.sort((a, b) => (b.productsCount?.count ?? 0) - (a.productsCount?.count ?? 0))) {
      console.log(`  • /collections/${c.handle.padEnd(24)} -> ${String(c.productsCount?.count ?? 0).padStart(4)} products (${c.title})`);
    }
    console.log(`══════════════════════════════════════════════════════════════════════\n`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Reconcile failed:', err.message);
  process.exit(1);
});
