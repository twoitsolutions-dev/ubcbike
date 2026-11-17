// Real 40,000+ SKU Stress Benchmark & Live Shopify Smart Collections Verification
// 1. Applies migration 004 (`pg_trgm`, functional GTIN/MPN indexes, universal catalog metadata) on Supabase.
// 2. Ensures all 8 cycling Smart Collections & 3 `ubc.*` metafield definitions exist live on `ubcbike-hub.myshopify.com`.
// 3. Runs a full 41,000-SKU stress test inside an isolated temporary tenant (`scale-test-40k`) on Supabase PostgreSQL,
//    then deletes `scale-test-40k` in `finally` so Carlos's live `twoit-sandbox` stays 100% untouched.

import { performance } from 'node:perf_hooks';
import { DEFAULT_CAMPAIGN_RULES } from '../packages/shared/dist/index.js';
import { DEFAULT_AVAILABILITY, isValidGtinCheckDigit } from '../packages/business-rules/dist/index.js';
import { mapFeed, MockShopifyAdmin } from '../packages/integrations/dist/index.js';
import { createPool, runMigrations } from '../packages/database/dist/index.js';
import { loadConfig } from '../apps/api/dist/config/env.js';
import { createConnectors, resolveLiveStoreConfigFromDb } from '../apps/api/dist/services/connectors.js';
import { ingestLightspeedItemsBatch } from '../apps/api/dist/services/lightspeed-sync.js';
import { importSupplierRecords, promoteUnmatchedOffersJob } from '../apps/api/dist/services/suppliers.js';
import { listItems } from '../apps/api/dist/services/catalog.js';
import { evaluate } from '../apps/api/dist/services/campaigns.js';
import { flushStagedToShopifyJob } from '../apps/api/dist/services/pipeline.js';

/** Generate a valid 12-digit GS1 UPC-A with real modulo-10 check digit. */
function makeValidUpc12(seq) {
  const body = ('74' + String(seq).padStart(9, '0')).slice(0, 11);
  let sum = 0;
  for (let i = 0; i < 11; i++) {
    const d = Number(body[10 - i]);
    sum += d * (i % 2 === 0 ? 3 : 1);
  }
  const check = (10 - (sum % 10)) % 10;
  const upc = body + String(check);
  if (!isValidGtinCheckDigit(upc)) throw new Error('Invalid generated UPC: ' + upc);
  return upc;
}

const ms = (t0) => Math.round(performance.now() - t0);
const sec = (t0) => ((performance.now() - t0) / 1000).toFixed(2) + 's';

const cfg = loadConfig(process.env);
const pool = createPool(cfg.env.DATABASE_URL);

let benchCompanyId = null;

try {
  console.log('\n======================================================================');
  console.log(' UBC Commerce Hub — 40,000+ SKU Universal Catalog & Scale Benchmark');
  console.log('======================================================================\n');

  // 1. Apply migrations (including 004_scale_40k_and_universal_catalog.sql)
  const tMig = performance.now();
  await runMigrations(pool, (msg) => console.log('  [migrate]', msg));
  console.log(`✓ Step 1: PostgreSQL migrations & 40K indexes verified (${ms(tMig)} ms)`);

  // 2. Live Shopify Smart Collections & Metafields on `ubcbike-hub.myshopify.com`
  await resolveLiveStoreConfigFromDb(pool, cfg);
  const liveConnectors = createConnectors(cfg, pool);
  if (cfg.mode === 'live' && cfg.env.SHOPIFY_WRITES_ENABLED) {
    const tShop = performance.now();
    const metaDefs = await liveConnectors.shopify.ensureUbcMetafieldDefinitions();
    const smartCols = await liveConnectors.shopify.ensureSmartCollections();
    console.log(`✓ Step 2: Live Shopify (${cfg.env.SHOPIFY_SHOP_DOMAIN}) ready (${ms(tShop)} ms)`);
    console.log(`    • Metafields active       : ${[...metaDefs.created, ...metaDefs.existing].join(', ')}`);
    console.log(`    • Smart Collections active: ${[...smartCols.created, ...smartCols.existing].join(', ')}`);
  } else {
    console.log(`✓ Step 2: Shopify mode=${cfg.mode}, writesEnabled=${cfg.env.SHOPIFY_WRITES_ENABLED} (skipping live collection mutation)`);
  }

  // 3. Provision isolated temporary benchmark tenant (`scale-test-40k`)
  const oldBench = await pool.query(`SELECT id FROM companies WHERE slug = 'scale-test-40k'`);
  for (const r of oldBench.rows) {
    await pool.query(`DELETE FROM supplier_offer_history WHERE company_id = $1`, [r.id]);
    await pool.query(`DELETE FROM outbound_sync_staging WHERE company_id = $1`, [r.id]);
    await pool.query(`DELETE FROM match_reviews WHERE company_id = $1`, [r.id]);
    await pool.query(`DELETE FROM supplier_offers WHERE company_id = $1`, [r.id]);
    await pool.query(`DELETE FROM inventory_levels WHERE company_id = $1`, [r.id]);
    await pool.query(`DELETE FROM external_ids WHERE company_id = $1`, [r.id]);
    await pool.query(`DELETE FROM variants WHERE company_id = $1`, [r.id]);
    await pool.query(`DELETE FROM products WHERE company_id = $1`, [r.id]);
    await pool.query(`DELETE FROM companies WHERE id = $1`, [r.id]);
  }
  const compRow = await pool.query(
    `INSERT INTO companies (slug, name) VALUES ('scale-test-40k', 'UBC 40K Scale Benchmark (Temp)') RETURNING id`,
  );
  benchCompanyId = compRow.rows[0].id;

  const storeRow = await pool.query(
    `INSERT INTO stores (company_id, name, shopify_shop_domain) VALUES ($1, 'Benchmark Store', 'scale-40k.local') RETURNING id`,
    [benchCompanyId],
  );
  const storeId = storeRow.rows[0].id;
  await pool.query(
    `INSERT INTO locations (company_id, store_id, name, kind, lightspeed_shop_id, shopify_location_id)
     VALUES ($1, $2, 'Tampa Main Showroom', 'physical', '1', 'gid://shopify/Location/bench-1')`,
    [benchCompanyId, storeId],
  );
  await pool.query(
    `INSERT INTO company_settings (company_id, campaign_rules, availability_rules) VALUES ($1, $2, $3)`,
    [benchCompanyId, JSON.stringify(DEFAULT_CAMPAIGN_RULES), JSON.stringify(DEFAULT_AVAILABILITY)],
  );
  for (const [code, name] of [['QBP', 'Quality Bicycle Products'], ['JBI', 'J&B Importers'], ['SPECIALIZED', 'Specialized B2B']]) {
    await pool.query(
      `INSERT INTO suppliers (company_id, code, name, connector, methods, is_active)
       VALUES ($1, $2, $3, $4, '{catalog_feed,csv}', true)`,
      [benchCompanyId, code, name, code.toLowerCase()],
    );
  }

  // Benchmark context uses MockShopifyAdmin so we never touch Carlos's live Shopify catalog with 41,000 test items!
  const mockShopify = new MockShopifyAdmin();
  const benchCtx = {
    pool,
    config: { ...cfg, mode: 'demo' },
    connectors: {
      ...liveConnectors,
      mode: 'demo',
      shopify: mockShopify,
    },
  };

  // 4. Phase A: Ingest 12,000 Lightspeed R-Series POS items (with matrices, physical shop QOH & shopID "0" account totals)
  const BRANDS = ['Continental', 'Shimano', 'SRAM', 'Giro', 'Park Tool', 'Garmin', 'Specialized', 'Trek', 'Vittoria', 'Maxxis', 'RockShox', 'Skratch'];
  const lsItems = [];
  for (let i = 1; i <= 12000; i++) {
    const isMatrix = i <= 3000;
    const matrixId = isMatrix ? String(Math.ceil(i / 3)) : '0';
    const brand = isMatrix ? BRANDS[Math.ceil(i / 3) % BRANDS.length] : BRANDS[i % BRANDS.length];
    const size = ['S', 'M', 'L'][i % 3];
    const upc = i <= 10500 ? makeValidUpc12(100000 + i) : undefined; // leave 1,500 without UPC to test MPN matching!
    const cost = 25 + (i % 150);
    // Intentionally price items 1..500 BELOW incoming vendor MAP ($90 retail vs $119.99 MAP) to verify MAP Quarantine!
    const retail = i <= 500 ? 90.00 : Math.round(cost * 1.85) + 0.99;
    const shop1Qty = i % 4 === 0 ? 0 : (i % 7) + 2; // 75% in stock physically, 25% zero in-store stock
    lsItems.push({
      itemID: String(500000 + i),
      description: `${brand} Pro Series Component #${i}${isMatrix ? ' - ' + size : ''}`,
      upc,
      customSku: `UBC-POS-${i}`,
      manufacturerSku: `MPN-CORE-${100000 + i}`,
      defaultCost: cost.toFixed(2),
      itemMatrixID: matrixId,
      timeStamp: '2026-11-16T06:00:00+00:00',
      Prices: { ItemPrice: [{ amount: retail.toFixed(2), useType: 'Default' }] },
      // Include shopID "0" (R-Series account sum = 99) + real shopID "1" to prove shopID "0" is never double-counted!
      ItemShops: { ItemShop: [{ shopID: '0', qoh: '99' }, { shopID: '1', qoh: String(shop1Qty) }] },
    });
  }

  const tLs = performance.now();
  const lsRes = await ingestLightspeedItemsBatch(benchCtx, benchCompanyId, lsItems, {
    physicalShopIds: ['1'],
    publishNew: true,
  });
  console.log(`✓ Step 3: Lightspeed R-Series POS synced 12,000 items in ${sec(tLs)}`);
  console.log(`    • Created canonical variants: ${lsRes.createdVariants.toLocaleString('en-US')} | Staged: ${lsRes.stagedForShopify.toLocaleString('en-US')}`);

  // 5. Phase B: Generate & Auto-Translate 35,000 messy multi-format distributor rows (TSV, Semicolon CSV, Pipe feed)
  const tGen = performance.now();

  // 5a) QBP: 18,000 rows in TAB-delimited TSV (3,500 overlap with LS UPCs incl. 500 MAP violations; 500 MPN-only review; 14,000 brand-new)
  const qbpLines = [
    'Item_Number\tManufacturer\tItem_Description\tMfg_Part_No\tBarcode\tDepartment\tDealer_Net\tMAP_Price\tMSRP\tAvail_Qty\tFrame_Size\tColorway\tModel_Code',
  ];
  for (let i = 1; i <= 18000; i++) {
    let brand, title, mpn, upc, dept, cost, mapStr, msrp, qtyStr, size = '', color = '', modelCode = '';
    if (i <= 3500) {
      // Overlaps with Lightspeed items 1..3500 by valid UPC
      brand = i <= 3000 ? BRANDS[Math.ceil(i / 3) % BRANDS.length] : BRANDS[i % BRANDS.length];
      title = `${brand} Pro Series Component #${i}`;
      mpn = `MPN-CORE-${100000 + i}`;
      upc = makeValidUpc12(100000 + i);
      dept = 'DRIVETRAIN/PARTS';
      cost = (24 + (i % 150)).toFixed(2);
      // Items 1..500 have MAP=$119.99 while LS published price is $90.00 -> MUST trigger MAP Quarantine!
      mapStr = i <= 500 ? '$119.99' : '$0.00';
      msrp = (Math.round(Number(cost) * 1.9) + 0.99).toFixed(2);
      qtyStr = i % 3 === 0 ? '10+' : '18';
    } else if (i <= 4000) {
      // Matches Lightspeed items 10501..11000 by Brand + MPN (NO barcode on either side) -> MUST route to `match_reviews`!
      const lsIdx = 10500 + (i - 3500);
      brand = BRANDS[lsIdx % BRANDS.length];
      title = `${brand} Pro Series Component #${lsIdx}`;
      mpn = `MPN-CORE-${100000 + lsIdx}`;
      upc = '';
      dept = 'PARTS';
      cost = '42.00';
      mapStr = '$0.00';
      msrp = '79.99';
      qtyStr = 'In Stock';
    } else {
      // 14,000 brand-new QBP catalog items (tires, helmets, hydration, tools, parts)
      const cats = [
        ['Continental', 'Grand Prix 5000 S TR Tubeless Tire', 'TIRES/CLINCHER', 52, 0, 94.99],
        ['Giro', 'Aries Spherical MIPS Road Helmet', 'HELMETS', 165, 299.95, 299.95],
        ['Park Tool', 'PCS-10.3 Deluxe Home Mechanic Repair Stand', 'TOOLS/SHOP', 148, 249.95, 259.95],
        ['Skratch', 'Sport Hydration Drink Mix Lemon Lime', 'NUTRITION', 12.5, 0, 23.95],
        ['Shimano', 'Ultegra Di2 RD-R8150 12-Speed Rear Derailleur', 'DRIVETRAIN', 245, 385.00, 414.99],
      ];
      const c = cats[i % cats.length];
      brand = c[0];
      size = ['S', 'M', 'L', '700x28c'][i % 4];
      color = ['Matte Black', 'White/Silver', 'Team Yellow', 'Olive'][i % 4];
      modelCode = `QBP-MAT-${Math.ceil(i / 4)}`;
      title = `${brand} ${c[1]} #${i} - ${size}`;
      mpn = `QBP-MPN-${200000 + i}`;
      upc = makeValidUpc12(300000 + i);
      dept = c[2];
      cost = c[3].toFixed(2);
      mapStr = `$${c[4].toFixed(2)}`;
      msrp = c[5].toFixed(2);
      qtyStr = i % 5 === 0 ? 'Out of Stock' : '15+';
    }
    qbpLines.push(`QBP-${i}\t${brand}\t${title}\t${mpn}\t${upc}\t${dept}\t$${cost}\t${mapStr}\t$${msrp}\t${qtyStr}\t${size}\t${color}\t${modelCode}`);
  }
  const qbpTsv = qbpLines.join('\n');

  // 5b) JBI: 11,000 rows in SEMICOLON-delimited CSV (2,000 overlap with LS UPCs 3501..5500; 9,000 brand-new)
  const jbiLines = [
    'jbi_part;vendor;short_description;manufact_sku;gtin;category_name;wholesale_price;umap;sug_retail;miami_qty',
  ];
  for (let i = 1; i <= 11000; i++) {
    if (i <= 2000) {
      const lsIdx = 3500 + i;
      const brand = BRANDS[lsIdx % BRANDS.length];
      jbiLines.push(`JBI-${i};${brand};"${brand} Pro Series Component #${lsIdx}";MPN-CORE-${100000 + lsIdx};${makeValidUpc12(100000 + lsIdx)};COMPONENTS;23.50;0.00;54.99;22`);
    } else {
      const brand = ['Vittoria', 'Maxxis', 'Kryptonite', 'Topeak', 'CamelBak'][i % 5];
      const cat = ['TIRES', 'TUBES', 'ACCESSORIES', 'HYDRATION', 'HELMETS'][i % 5];
      jbiLines.push(`JBI-${i};${brand};"${brand} Shop Essential Series #${i}";JBI-MPN-${400000 + i};${makeValidUpc12(500000 + i)};${cat};18.75;0.00;39.99;${i % 6 === 0 ? 'Backorder' : '12'}`);
    }
  }
  const jbiCsv = jbiLines.join('\n');

  // 5c) SPECIALIZED: 6,000 rows in PIPE-delimited feed (NO brand column; complete bikes + helmets + e-bikes -> 6,000 brand-new)
  const specLines = [
    'partNumber|productName|ean|productType|dealerPrice|mapPrice|retailPrice|b2bAvailableQty|size|styleCode',
  ];
  for (let i = 1; i <= 6000; i++) {
    const models = [
      ['Turbo Vado 4.0 Step-Through E-Bike', 'Electric Bikes', 2100, 3249.99, 3249.99],
      ['Tarmac SL8 Expert Carbon Road Bike', 'Road Bikes', 3850, 5999.99, 6499.99],
      ['Stumpjumper 15 Comp Alloy MTB', 'Mountain Bikes', 2400, 3799.99, 3999.99],
      ['Sirrus X 3.0 Fitness Hybrid Bike', 'Hybrid Bikes', 580, 949.99, 999.99],
      ['Prevail 3 Vent MIPS Helmet', 'Helmets', 165, 299.99, 299.99],
    ];
    const m = models[i % models.length];
    const sz = ['S2', 'S3', 'S4', 'S5'][i % 4];
    const style = `SPZ-MODEL-${Math.ceil(i / 4)}`;
    specLines.push(`SPZ-${90000 + i}|${m[0]} #${Math.ceil(i / 4)} - ${sz}|${makeValidUpc12(700000 + i)}|${m[1]}|${m[2].toFixed(2)}|${m[3].toFixed(2)}|${m[4].toFixed(2)}|4|${sz}|${style}`);
  }
  const specPipe = specLines.join('\n');

  const tParse = performance.now();
  const parsedQbp = mapFeed(qbpTsv, undefined, { contentLicensed: true, defaultLeadDays: 4 });
  const parsedJbi = mapFeed(jbiCsv, undefined, { contentLicensed: true, defaultLeadDays: 3 });
  const parsedSpec = mapFeed(specPipe, undefined, { contentLicensed: true, defaultLeadDays: 5, defaultBrand: 'Specialized' });
  const totalParsed = parsedQbp.records.length + parsedJbi.records.length + parsedSpec.records.length;

  console.log(`✓ Step 4: Universal Translator parsed ${totalParsed.toLocaleString('en-US')} raw rows (TSV + ';' + '|', 0 manual mappings) in ${ms(tParse)} ms (gen ${ms(tGen)} ms)`);
  console.log(`    • Row errors across 35,000 messy rows: ${parsedQbp.errors.length + parsedJbi.errors.length + parsedSpec.errors.length}`);

  // 6. Bulk DB Ingest of 35,000 Supplier Offers (GTIN auto-matching, MPN review routing, Versioning & MAP Quarantine)
  const tIngest = performance.now();
  const rQbp = await importSupplierRecords(benchCtx, benchCompanyId, 'QBP', parsedQbp.records, 'full_catalog');
  const rJbi = await importSupplierRecords(benchCtx, benchCompanyId, 'JBI', parsedJbi.records, 'full_catalog');
  const rSpec = await importSupplierRecords(benchCtx, benchCompanyId, 'SPECIALIZED', parsedSpec.records, 'full_catalog');
  console.log(`✓ Step 5: Set-based DB ingest of 35,000 vendor offers against 12,000 POS items finished in ${sec(tIngest)}`);
  console.log(`    • QBP (18k)        : autoMatched=${rQbp.autoMatched}, review=${rQbp.review}, unmatched=${rQbp.unmatched}, stagedHeld(MAP)=${rQbp.stagedHeld}`);
  console.log(`    • JBI (11k)        : autoMatched=${rJbi.autoMatched}, review=${rJbi.review}, unmatched=${rJbi.unmatched}, stagedReady=${rJbi.stagedReady}`);
  console.log(`    • SPECIALIZED (6k) : autoMatched=${rSpec.autoMatched}, review=${rSpec.review}, unmatched=${rSpec.unmatched}`);

  // 7. Phase C: Promote all 29,000 unmatched vendor offers into canonical store catalog -> 41,000 total canonical variants!
  const tProm = performance.now();
  const promRes = await promoteUnmatchedOffersJob(benchCtx, benchCompanyId, {
    onlyInStock: false,
    publishStatus: 'published',
    limit: 50000,
  });
  const totalVarsRow = await pool.query(`SELECT count(*)::int AS n FROM variants WHERE company_id = $1`, [benchCompanyId]);
  const totalProdsRow = await pool.query(`SELECT count(*)::int AS n FROM products WHERE company_id = $1`, [benchCompanyId]);
  const totalVariants = totalVarsRow.rows[0].n;
  const totalProducts = totalProdsRow.rows[0].n;

  console.log(`✓ Step 6: Promoted ${promRes.variantsPromoted.toLocaleString('en-US')} unmatched offers into canonical catalog in ${sec(tProm)}`);
  console.log(`    • Canonical Store Size Now: ${totalVariants.toLocaleString('en-US')} variants across ${totalProducts.toLocaleString('en-US')} products!`);

  if (totalVariants < 40000) {
    throw new Error(`Expected >= 40,000 canonical variants, got ${totalVariants}`);
  }

  // 8. Phase D: Benchmark Search, Golden Business Rules, 41K Promotion Evaluation & Self-Chaining Shopify Flush!
  const tSearch = performance.now();
  const searchRes = await listItems(
    pool,
    benchCompanyId,
    { q: 'grand prix 5000 continental', status: 'published' },
    DEFAULT_AVAILABILITY,
    { limit: 50, offset: 0, sort: 'price', dir: 'asc' },
  );
  const searchMs = ms(tSearch);
  console.log(`✓ Step 7: pg_trgm full-catalog search across ${totalVariants.toLocaleString('en-US')} variants returned ${searchRes.total.toLocaleString('en-US')} hits in ${searchMs} ms`);

  // Golden Rule Check 1: Physical Stock & Supplier Stock NEVER Sum!
  const overlapCheck = await pool.query(
    `SELECT ci.sku, ci.physical_qty, ci.offers, oss.shopify_payload
     FROM catalog_items ci
     JOIN outbound_sync_staging oss ON oss.variant_id = ci.id AND oss.company_id = ci.company_id
     WHERE ci.company_id = $1 AND ci.sku = 'UBC-POS-505'
     LIMIT 1`,
    [benchCompanyId],
  );
  const ov = overlapCheck.rows[0];
  const expectedPubQty = Math.max(0, ov.physical_qty - DEFAULT_AVAILABILITY.physicalSafetyQty);
  if (ov.shopify_payload.publishedQty !== expectedPubQty) {
    throw new Error(`Golden rule violation! Expected publishedQty=${expectedPubQty}, got ${ov.shopify_payload.publishedQty}`);
  }
  // Verify shopID "0" (99) was NOT added to physical_qty!
  if (ov.physical_qty >= 90) {
    throw new Error(`Lightspeed shopID "0" leak! physical_qty=${ov.physical_qty}`);
  }
  console.log(`✓ Step 8: Golden Rule Verified on ${ov.sku} — Physical QOH=${ov.physical_qty} (shopID=0 excluded), Vendor Offers=${ov.offers.length} (qty=${ov.offers[0]?.qtyAvailable}), Published to Shopify=${ov.shopify_payload.publishedQty} (NEVER summed!)`);

  // Golden Rule Check 2: Specialized Complete Bike -> Click & Collect Only!
  const specBikeCheck = await pool.query(
    `SELECT v.sku, p.brand, p.category, oss.shopify_payload
     FROM outbound_sync_staging oss
     JOIN variants v ON v.id = oss.variant_id
     JOIN products p ON p.id = v.product_id
     WHERE oss.company_id = $1 AND p.brand = 'Specialized' AND p.category ILIKE '%Bike%'
     LIMIT 1`,
    [benchCompanyId],
  );
  if (!specBikeCheck.rows[0]?.shopify_payload?.clickAndCollectOnly) {
    throw new Error('Specialized complete bike missing clickAndCollectOnly=true!');
  }
  console.log(`✓ Step 9: Specialized Complete Bike Guardrail Verified (${specBikeCheck.rows[0].sku} · ${specBikeCheck.rows[0].category} -> clickAndCollectOnly=true)`);

  // Golden Rule Check 3: MAP Quarantine caught all 500 below-MAP items!
  const heldRow = await pool.query(
    `SELECT count(*)::int AS n FROM outbound_sync_staging
     WHERE company_id = $1 AND decision = 'held_for_review' AND hold_reasons @> '["map_above_published_price"]'::jsonb`,
    [benchCompanyId],
  );
  if (heldRow.rows[0].n < 500) {
    throw new Error(`Expected >= 500 MAP quarantined items, got ${heldRow.rows[0].n}`);
  }
  console.log(`✓ Step 10: MAP Quarantine Guardrail Verified — ${heldRow.rows[0].n} below-MAP items blocked before reaching Shopify`);

  // Benchmark 41,000-SKU Storewide Black Friday 15%-Off Campaign Evaluation!
  const tCamp = performance.now();
  const campEval = await evaluate(
    pool,
    benchCompanyId,
    { status: 'published' },
    { type: 'percent_off', value: 0.15, rounding: 'charm_99' },
    undefined,
    'online',
  );
  console.log(`✓ Step 11: Storewide Campaign Engine evaluated ${campEval.lines.length.toLocaleString('en-US')} SKUs in ${sec(tCamp)}`);
  console.log(`    • Summary: ok=${campEval.summary.ok.toLocaleString('en-US')}, warning=${campEval.summary.warning.toLocaleString('en-US')}, blocked(MAP/Margin)=${campEval.summary.blocked.toLocaleString('en-US')} | Strategy=${campEval.strategy}`);

  // Benchmark Outbound Shopify Flush (`upsertProduct` + Metafields + Inventory + Self-Chaining)!
  const tFlush = performance.now();
  const flushRes = await flushStagedToShopifyJob(benchCtx, benchCompanyId, { limit: 250, chainDepth: 0 });
  console.log(`✓ Step 12: Outbound Shopify Flush checkpoint (250 batch) completed in ${ms(tFlush)} ms`);
  console.log(`    • Pushed=${flushRes.pushed}, Created New Shopify Products=${flushRes.createdProducts}, Self-Chained Next Batch=${flushRes.chainedNext}`);
  if (!flushRes.chainedNext || flushRes.pushed !== 250) {
    throw new Error(`Expected pushed=250 & chainedNext=true, got ${JSON.stringify(flushRes)}`);
  }

  console.log('\n======================================================================');
  console.log(' ALL 12 STRESS BENCHMARKS PASSED AT 41,000 CANONICAL SKUs!');
  console.log('======================================================================\n');
} finally {
  if (benchCompanyId) {
    const tClean = performance.now();
    await pool.query(`DELETE FROM supplier_offer_history WHERE company_id = $1`, [benchCompanyId]);
    await pool.query(`DELETE FROM outbound_sync_staging WHERE company_id = $1`, [benchCompanyId]);
    await pool.query(`DELETE FROM match_reviews WHERE company_id = $1`, [benchCompanyId]);
    await pool.query(`DELETE FROM supplier_offers WHERE company_id = $1`, [benchCompanyId]);
    await pool.query(`DELETE FROM inventory_levels WHERE company_id = $1`, [benchCompanyId]);
    await pool.query(`DELETE FROM external_ids WHERE company_id = $1`, [benchCompanyId]);
    await pool.query(`DELETE FROM variants WHERE company_id = $1`, [benchCompanyId]);
    await pool.query(`DELETE FROM products WHERE company_id = $1`, [benchCompanyId]);
    await pool.query(`DELETE FROM companies WHERE id = $1`, [benchCompanyId]);
    console.log(`✓ Cleanup: Isolated benchmark tenant (scale-test-40k) purged cleanly in ${ms(tClean)} ms. Live twoit-sandbox untouched.\n`);
  }
  await pool.end();
}
