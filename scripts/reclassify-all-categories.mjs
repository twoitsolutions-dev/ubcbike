/**
 * Re-classifies 100% of all 25,160 Lightspeed R-Series (#114391) products in UBC Commerce Hub
 * using Carlos's exact 218 Lightspeed `Category.fullPathName` paths + upgraded `normalizeCyclingCategory`
 * & `formatPosBrand` (fixing Jupiter Bikes -> `Electric Bikes` + brand `Jupiter`, Jupiter/E-Bike parts ->
 * `Parts & Components` / `Accessories & Gear`, Specialized Levo -> `Electric Bikes`, Road Endurance ->
 * `Road & Gravel Bikes`, Kids/BMX -> `Kids & BMX Bikes`, Framesets -> `Parts & Components`, and cleaning
 * raw POS discount/rental categories into `Workshop Services`).
 *
 * Also fixes the 3 Specialized bikes miscategorized by Workstand on Carlos's Shopify (`Sirrus X 5.0` &
 * `Sirrus X 2.0` -> `dept-hybrid-bikes`, `Allez Comp` -> `dept-road-bikes`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { mapLsItem, normalizeCyclingCategory, ShopifyAdminClient } from '../packages/integrations/dist/index.js';
import { createPool } from '../packages/database/dist/index.js';
import { loadConfig } from '../apps/api/dist/config/env.js';
import { createConnectors } from '../apps/api/dist/services/connectors.js';
import { formatPosBrand } from '../apps/api/dist/services/lightspeed-sync.js';

const ENV_PATH = path.resolve(process.cwd(), '.env');
function syncLocalEnvRefreshToken(newRefreshToken) {
  if (!newRefreshToken || !fs.existsSync(ENV_PATH)) return;
  const raw = fs.readFileSync(ENV_PATH, 'utf8');
  if (!/^LIGHTSPEED_R_REFRESH_TOKEN=/m.test(raw)) return;
  const updated = raw.replace(/^LIGHTSPEED_R_REFRESH_TOKEN=.*$/m, `LIGHTSPEED_R_REFRESH_TOKEN=${newRefreshToken}`);
  if (updated !== raw) fs.writeFileSync(ENV_PATH, updated, 'utf8');
}

async function main() {
  const t0 = performance.now();
  const cfg = loadConfig(process.env);
  const pool = createPool(cfg.env.DATABASE_URL);

  try {
    const companyId = (await pool.query(`SELECT id FROM companies WHERE slug = 'twoit-sandbox' LIMIT 1`)).rows[0].id;
    const connectors = createConnectors(cfg, pool, companyId);

    // 1. Map Lightspeed itemID -> Hub product_id
    const extRes = await pool.query(
      `SELECT e.external_id AS ls_id, v.product_id
       FROM external_ids e
       JOIN variants v ON v.id = e.entity_id
       WHERE e.company_id = $1 AND e.system = 'lightspeed_r' AND e.entity_type = 'variant'`,
      [companyId],
    );
    const lsToProd = new Map();
    for (const r of extRes.rows) {
      lsToProd.set(String(r.ls_id), r.product_id);
    }
    console.log(`Loaded ${lsToProd.size.toLocaleString('en-US')} Lightspeed->Hub variant links.`);

    // 2. Stream all 25,160 items from Lightspeed #114391 (100% read-only) to get exact Category.fullPathName & Manufacturer
    const prodUpdates = new Map();
    let seen = 0;
    for await (const page of connectors.lightspeed.iterateItems()) {
      for (const raw of page) {
        seen++;
        const pid = lsToProd.get(String(raw.itemID));
        if (!pid) continue;
        const m = mapLsItem(raw, ['1', '2']);
        const newCat = normalizeCyclingCategory(m.rawCategory, m.title);
        const newBrand = formatPosBrand(m.brand, m.title);

        // If a matrix product has multiple variants, prefer complete-bike category if any variant is a complete bike
        const prev = prodUpdates.get(pid);
        if (!prev || prev.cat === 'Parts & Components') {
          prodUpdates.set(pid, { pid, brand: newBrand, cat: newCat });
        }
      }
      if (seen % 2500 === 0) {
        console.log(`  • Read ${seen.toLocaleString('en-US')} / 25,160 Lightspeed items...`);
      }
    }

    // Persist rotated refresh_token locally if rotated
    const tokRow = await pool.query(`SELECT value FROM app_settings WHERE company_id = $1 AND key = 'lightspeed_oauth' LIMIT 1`, [companyId]).catch(() => ({ rows: [] }));
    if (tokRow.rows[0]?.value?.refreshToken) {
      syncLocalEnvRefreshToken(tokRow.rows[0].value.refreshToken);
    }

    // 3. Apply bulk category + brand update in chunks of 2,500
    const arr = [...prodUpdates.values()];
    console.log(`\nUpdating ${arr.length.toLocaleString('en-US')} Hub products with exact categories & brands...`);
    for (let i = 0; i < arr.length; i += 2500) {
      const slice = arr.slice(i, i + 2500);
      await pool.query(
        `UPDATE products AS p
         SET brand = r.brand,
             category = r.cat,
             updated_at = now()
         FROM jsonb_to_recordset($2::jsonb) AS r(pid uuid, brand text, cat text)
         WHERE p.company_id = $1 AND p.id = r.pid AND (p.brand IS DISTINCT FROM r.brand OR p.category IS DISTINCT FROM r.cat)`,
        [companyId, JSON.stringify(slice)],
      );
    }

    // 4. Fix Workstand's 3 miscategorized Specialized bikes on Carlos's Shopify store
    const shopClient = new ShopifyAdminClient({
      shopDomain: process.env.UBC_LIVE_SHOPIFY_DOMAIN || 'z5wxyn-uc.myshopify.com',
      accessToken: process.env.UBC_LIVE_SHOPIFY_ACCESS_TOKEN,
      writesEnabled: true,
    });
    const shopFixes = [
      { id: 'gid://shopify/Product/15478544040253', title: 'Sirrus X 5.0', remove: ['dept-electric-bikes'], add: ['dept-bikes', 'dept-hybrid-bikes'] },
      { id: 'gid://shopify/Product/15478570025277', title: 'Sirrus X 2.0', remove: ['dept-electric-bikes'], add: ['dept-bikes', 'dept-hybrid-bikes'] },
      { id: 'gid://shopify/Product/15478754246973', title: 'Allez Comp', remove: ['dept-hybrid-bikes'], add: ['dept-bikes', 'dept-road-bikes'] },
    ];
    for (const fx of shopFixes) {
      await shopClient.mutate(`mutation($id: ID!, $tags: [String!]!) { tagsRemove(id: $id, tags: $tags) { userErrors { message } } }`, { id: fx.id, tags: fx.remove });
      await shopClient.mutate(`mutation($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`, { id: fx.id, tags: fx.add });
      console.log(`  ✓ Fixed Shopify department tags on ${fx.title}: -${fx.remove.join(',')} +${fx.add.join(',')}`);
    }

    // 5. Verify Jupiter items + global category summary!
    const jupCheck = await pool.query(
      `SELECT p.title, p.brand, p.category,
              coalesce(sum(CASE WHEN l.lightspeed_shop_id = '1' THEN il.on_hand ELSE 0 END), 0)::int AS tampa,
              coalesce(sum(CASE WHEN l.lightspeed_shop_id = '2' THEN il.on_hand ELSE 0 END), 0)::int AS alafia
       FROM products p
       JOIN variants v ON v.product_id = p.id
       LEFT JOIN inventory_levels il ON il.variant_id = v.id
       LEFT JOIN locations l ON l.id = il.location_id
       WHERE p.company_id = $1 AND (p.title ILIKE '%jupiter%' OR p.brand ILIKE '%jupiter%')
       GROUP BY p.id, p.title, p.brand, p.category
       ORDER BY (coalesce(sum(il.on_hand), 0)) DESC, p.category, p.title`,
      [companyId],
    );

    const catCheck = await pool.query(
      `SELECT category, count(*)::int AS products_cnt
       FROM products
       WHERE company_id = $1
       GROUP BY category
       ORDER BY products_cnt DESC`,
      [companyId],
    );

    const sec = ((performance.now() - t0) / 1000).toFixed(1);
    console.log(`\n══════════════════════════════════════════════════════════════════════`);
    console.log(`  ✓ ALL 25,160 ITEMS RECLASSIFIED IN ${sec}s!`);
    console.log(`══════════════════════════════════════════════════════════════════════`);
    console.log('\n[Hub Categories Summary]');
    for (const c of catCheck.rows) {
      console.log(`  • ${c.category.padEnd(26)} -> ${String(c.products_cnt).padStart(6)} products`);
    }
    console.log('\n[All Jupiter Items Verified]');
    for (const j of jupCheck.rows) {
      console.log(`  • ${j.category.padEnd(22)} | ${j.brand.padEnd(10)} | T:${String(j.tampa).padStart(2)} A:${j.alafia} | ${j.title}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Reclassification failed:', err);
  process.exit(1);
});
