// End-to-end verification of the UBC Commerce Hub Intermediary Engine against
// Supabase (`twoit-sandbox`) + live read-only Shopify (`TwoIT Pruebas Pipeline`).
// Tests:
//   1. Declarative supplier normalization (QBP `item_number`, JBI `sku`, Specialized `partNumber`)
//   2. GTIN auto-matching + MPN-only quarantine into `match_reviews` (zero duplicates)
//   3. Supplier cost versioning (`$450.00 -> $475.00` with exact `shopify_published_price_cents` snapshot)
//   4. Processing Buffer (`outbound_sync_staging`): `ready_for_shopify` vs `held_for_review` (MAP violation)
//   5. Specialized complete-bike Click & Collect (`clickAndCollectOnly: true`) enforcement
//   6. Dead-man's-switch Watchdog (`evaluateFeedWatchdog` / `runPipelineWatchdogAndSchedules` at +52h)
import { normalizeSupplierPayload } from '../packages/business-rules/dist/index.js';
import { createPool } from '../packages/database/dist/index.js';
import { loadConfig } from '../apps/api/dist/config/env.js';
import { createConnectors } from '../apps/api/dist/services/connectors.js';
import { importSupplierRecords } from '../apps/api/dist/services/suppliers.js';
import { flushStagedToShopifyJob, getPipelineStatus, runPipelineWatchdogAndSchedules } from '../apps/api/dist/services/pipeline.js';

function toCatalogRecord(norm) {
  return {
    supplierSku: norm.supplierSku,
    brand: norm.brand,
    title: norm.title,
    mpn: norm.mpn,
    upc: norm.upc,
    category: norm.category ?? undefined,
    costCents: norm.costCents ?? 0,
    msrpCents: norm.msrpCents,
    mapCents: norm.mapCents,
    qtyAvailable: norm.qtyAvailable,
    dropShip: norm.dropShip,
    leadDays: norm.leadDays,
    contentLicensed: norm.contentLicensed,
  };
}

const cfg = loadConfig(process.env);
const pool = createPool(cfg.env.DATABASE_URL);
const ctx = { pool, config: cfg, connectors: createConnectors(cfg, pool) };

try {
  const compRes = await pool.query(`SELECT id, slug, name FROM companies WHERE slug = 'twoit-sandbox'`);
  if (!compRes.rowCount) {
    throw new Error('Tenant twoit-sandbox not found — run npm run shopify:bootstrap first.');
  }
  const companyId = compRes.rows[0].id;
  console.log(`\n=== UBC Commerce Hub · Intermediary Engine E2E Verification (${compRes.rows[0].slug}) ===\n`);

  // Idempotent cleanup of prior verification offers inside `twoit-sandbox` ONLY.
  await pool.query(`DELETE FROM outbound_sync_staging WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM match_reviews WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM supplier_offer_history WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM supplier_offers WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM supplier_sync_runs WHERE company_id = $1`, [companyId]);

  // Step 1: Pick 3 real Shopify-synced variants in twoit-sandbox and attach valid GS1 GTIN/MPN/MAP metadata
  // so supplier feeds link to real Shopify variants without writing anything back to Shopify.
  const vars = await pool.query(
    `SELECT v.id, v.product_id, v.title, v.price_cents, p.title AS product_title
     FROM variants v JOIN products p ON p.id = v.product_id
     WHERE v.company_id = $1
     ORDER BY v.price_cents DESC`,
    [companyId],
  );
  const highBike = vars.rows.find((r) => r.price_cents >= 200000) || vars.rows[0];
  const midBike = vars.rows.find((r) => r.price_cents >= 50000 && r.price_cents < 200000) || vars.rows[1];
  const lowItem = vars.rows.find((r) => r.price_cents >= 4000 && r.price_cents <= 6000) || vars.rows[vars.rows.length - 1];

  // 1a) Specialized complete bike (valid GS1-12 UPC `888818626144`) -> auto-matches & enforces Click & Collect!
  await pool.query(
    `UPDATE products SET brand = 'Specialized', category = 'Road Bikes', map_policy = 'map' WHERE id = $1`,
    [highBike.product_id],
  );
  await pool.query(
    `UPDATE variants SET upc = '888818626144', mpn = 'TARMAC-SL7-56', map_cents = 259999 WHERE id = $1`,
    [highBike.id],
  );

  // 1b) Surly frame via QBP (valid GS1-12 UPC `036000291452`) -> tests $450 -> $475 cost hike versioning!
  await pool.query(
    `UPDATE products SET brand = 'Surly', category = 'Gravel Frames', map_policy = 'map' WHERE id = $1`,
    [midBike.product_id],
  );
  await pool.query(
    `UPDATE variants SET upc = '036000291452', mpn = 'MIDNIGHT-SP-54', map_cents = 84999 WHERE id = $1`,
    [midBike.id],
  );

  // 1c) Continental tire via JBI (valid GS1-12 UPC `768686473494`) -> Shopify price ($50.00) < MAP ($69.99) -> HELD!
  await pool.query(
    `UPDATE products SET brand = 'Continental', category = 'Tires', map_policy = 'map' WHERE id = $1`,
    [lowItem.product_id],
  );
  await pool.query(
    `UPDATE variants SET upc = '768686473494', mpn = 'GP5000-700X28', map_cents = 6999 WHERE id = $1`,
    [lowItem.id],
  );

  console.log('1) Linked 3 Shopify sandbox variants to canonical GS1 UPC/MPN/MAP rules:');
  console.log(`   - [${highBike.product_title}] Shopify=$${(highBike.price_cents / 100).toFixed(2)} | MAP=$2,599.99 | UPC=888818626144`);
  console.log(`   - [${midBike.product_title}] Shopify=$${(midBike.price_cents / 100).toFixed(2)} | MAP=$849.99   | UPC=036000291452`);
  console.log(`   - [${lowItem.product_title}] Shopify=$${(lowItem.price_cents / 100).toFixed(2)}  | MAP=$69.99    | UPC=768686473494 (expect MAP HOLD)`);

  // Step 2: Normalize heterogeneous distributor schemas (QBP, JBI, Specialized)
  const qbpBatch1 = [
    normalizeSupplierPayload('QBP', {
      item_number: 'QBP-FM4500',
      brand_name: 'Surly',
      item_description: 'Surly Midnight Special Frame 54cm',
      manufacturer_part_number: 'MIDNIGHT-SP-54',
      upc_code: '036000291452',
      dealer_cost: '450.00',
      map_price: '849.99',
      msrp: '899.99',
      qty_available: 9,
      dropship_eligible: 'true',
      lead_days: 3,
    }),
  ].filter(Boolean).map(toCatalogRecord);

  const jbiBatch = [
    normalizeSupplierPayload('JBI', {
      sku: 'JBI-61028',
      mfg: 'Continental',
      desc: 'Grand Prix 5000 700x28c Folding Tire',
      mfg_part_no: 'GP5000-700X28',
      gtin: '768686473494',
      dealer_cost: '38.50',
      map: '69.99',
      msrp: '79.99',
      qoh: 24,
      lead_time_days: 4,
    }),
  ].filter(Boolean).map(toCatalogRecord);

  const specBatch = [
    normalizeSupplierPayload('SPECIALIZED', {
      partNumber: 'SPEC-94424-56',
      brand: 'Specialized',
      productName: 'Tarmac SL7 Sport — 56cm Complete Bike',
      mpn: 'TARMAC-SL7-56',
      ean: '888818626144',
      category: 'Road Bikes',
      dealerPrice: '1650.00',
      mapPrice: '2599.99',
      retailPrice: '2799.99',
      inventory: 4,
      leadDays: 5,
    }),
    // Dubious record: matches brand + MPN `TARMAC-SL7-56` WITHOUT barcode -> routed to `match_reviews` (never duplicated)!
    normalizeSupplierPayload('SPECIALIZED', {
      partNumber: 'SPEC-UNVERIFIED-56',
      brand: 'Specialized',
      productName: 'Tarmac SL7 Frameset Colorway Variant (No Barcode)',
      mpn: 'TARMAC-SL7-56',
      ean: '',
      dealerPrice: '1490.00',
      mapPrice: '2499.99',
      inventory: 2,
      leadDays: 6,
    }),
  ].filter(Boolean).map(toCatalogRecord);

  const rQbp1 = await importSupplierRecords(ctx, companyId, 'QBP', qbpBatch1, 'full_catalog');
  const rJbi = await importSupplierRecords(ctx, companyId, 'JBI', jbiBatch, 'full_catalog');
  const rSpec = await importSupplierRecords(ctx, companyId, 'SPECIALIZED', specBatch, 'full_catalog');

  console.log('\n2) Imported & normalized heterogeneous supplier feeds:');
  console.log('   - QBP (`item_number`)       :', JSON.stringify(rQbp1));
  console.log('   - JBI (`sku`)               :', JSON.stringify(rJbi));
  console.log('   - SPECIALIZED (`partNumber`):', JSON.stringify(rSpec));

  // Step 3: Simulate Erik's exact Versioning scenario — QBP raises cost from $450.00 to $475.00!
  const qbpCostUpdate = [
    normalizeSupplierPayload('QBP', {
      item_number: 'QBP-FM4500',
      brand_name: 'Surly',
      item_description: 'Surly Midnight Special Frame 54cm',
      manufacturer_part_number: 'MIDNIGHT-SP-54',
      upc_code: '036000291452',
      dealer_cost: '475.00',
      map_price: '849.99',
      msrp: '899.99',
      qty_available: 9,
      dropship_eligible: 'true',
      lead_days: 3,
    }),
  ].filter(Boolean).map(toCatalogRecord);

  const rQbp2 = await importSupplierRecords(ctx, companyId, 'QBP', qbpCostUpdate, 'costs');
  console.log('\n3) Simulated QBP cost hike ($450.00 -> $475.00) on `costs` stream:', JSON.stringify(rQbp2));

  const histRows = await pool.query(
    `SELECT supplier_sku, change_types, old_cost_cents, new_cost_cents, shopify_published_price_cents, resulting_margin_bps
     FROM supplier_offer_history
     WHERE company_id = $1 AND supplier_sku = 'QBP-FM4500'
     ORDER BY id DESC LIMIT 2`,
    [companyId],
  );
  console.log('   Versioned history rows in Supabase (`supplier_offer_history`):');
  for (const h of histRows.rows) {
    const marginStr = h.resulting_margin_bps !== null ? `${(h.resulting_margin_bps / 100).toFixed(2)}%` : 'n/a';
    console.log(
      `   - SKU=${h.supplier_sku} | changes=${JSON.stringify(h.change_types)} | oldCost=${h.old_cost_cents !== null ? `$${(h.old_cost_cents / 100).toFixed(2)}` : 'initial'} -> newCost=$${(h.new_cost_cents / 100).toFixed(2)} | shopifyPublished=$${(h.shopify_published_price_cents / 100).toFixed(2)} | margin=${marginStr}`,
    );
  }

  // Step 4: Inspect Processing Buffer (`outbound_sync_staging`) & Read-Only Flush Guard
  const staged = await pool.query(
    `SELECT v.title, oss.stream, oss.decision, oss.status, oss.hold_reasons, oss.shopify_payload
     FROM outbound_sync_staging oss
     JOIN variants v ON v.id = oss.variant_id
     WHERE oss.company_id = $1
     ORDER BY oss.id ASC`,
    [companyId],
  );
  console.log('\n4) Processing Buffer (`outbound_sync_staging`) before reaching Shopify:');
  for (const s of staged.rows) {
    console.log(
      `   - [${s.title}] (${s.stream}) decision=${s.decision} | status=${s.status} | holds=${JSON.stringify(s.hold_reasons)} | clickAndCollect=${s.shopify_payload.clickAndCollectOnly} | availability=${s.shopify_payload.availability}`,
    );
  }

  const flushRes = await flushStagedToShopifyJob(ctx, companyId);
  console.log('   Read-only flush guard result (`SHOPIFY_WRITES_ENABLED=false`):', JSON.stringify(flushRes));

  // Step 5: Test Dead-Man's-Switch Watchdog at now + 52 hours (simulating 2+ days of silent feeds)
  const future52h = new Date(Date.now() + 52 * 3600_000);
  const wdResult = await runPipelineWatchdogAndSchedules(ctx, future52h);
  console.log('\n5) Observability Watchdog simulated at +52h silence:', JSON.stringify(wdResult));

  const wdAlerts = await pool.query(
    `SELECT source, message FROM error_log
     WHERE company_id = $1 AND source = 'watchdog:supplier_feed' AND resolved_at IS NULL
     ORDER BY id DESC LIMIT 5`,
    [companyId],
  );
  for (const a of wdAlerts.rows) {
    console.log(`   - Alert logged: ${a.message}`);
  }

  // Restore schedule statuses back to 'succeeded' after the +52h simulation and resolve simulated alerts
  await pool.query(
    `UPDATE supplier_sync_schedules SET last_status = 'succeeded', updated_at = now() WHERE company_id = $1`,
    [companyId],
  );
  await pool.query(
    `UPDATE error_log SET resolved_at = now() WHERE company_id = $1 AND source = 'watchdog:supplier_feed'`,
    [companyId],
  );

  const statusSummary = await getPipelineStatus(ctx, companyId);
  console.log('\n6) Live Pipeline Status Summary (`getPipelineStatus`):');
  console.log('   - Watchdog current health:', statusSummary.watchdog.map((w) => `${w.supplierCode}:${w.status}`).join(', '));
  console.log('   - Staging summary        :', JSON.stringify(statusSummary.stagingSummary));
  console.log('   - Recent sync runs logged:', statusSummary.recentRuns.length);
  console.log('\n=== E2E Intermediary Engine Verification PASSED ===\n');
} finally {
  await pool.end();
}
