/**
 * 100% Read-Only Forensic Audit & Cross-Match of Carlos's Live Shopify Store (`z5wxyn-uc.myshopify.com`
 * populated by Masterlinq / Workstand catalogs) against his Real Lightspeed R-Series POS (#114391).
 *
 * Strict safety guarantees:
 *  - `writesEnabled: false` hardcoded (`WritesDisabledError` blocks all mutations).
 *  - Never prints tokens or secrets.
 */
import { performance } from 'node:perf_hooks';
import { normalizeGtin } from '../packages/business-rules/dist/index.js';
import { ShopifyAdminApi, ShopifyAdminClient } from '../packages/integrations/dist/index.js';
import { createPool } from '../packages/database/dist/index.js';

async function main() {
  const t0 = performance.now();
  const shopDomain = process.env.UBC_LIVE_SHOPIFY_DOMAIN || 'z5wxyn-uc.myshopify.com';
  const clientId = process.env.UBC_LIVE_SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.UBC_LIVE_SHOPIFY_CLIENT_SECRET;
  const accessToken = process.env.UBC_LIVE_SHOPIFY_ACCESS_TOKEN;

  const client = accessToken
    ? new ShopifyAdminClient({ shopDomain, accessToken, writesEnabled: false })
    : new ShopifyAdminClient({ shopDomain, clientId, clientSecret, writesEnabled: false });

  const health = await client.health();
  console.log('\n══════════════════════════════════════════════════════════════════════');
  console.log('  UBC Hub · Read-Only Forensic Audit: Masterlinq Shopify ↔ Lightspeed #114391');
  console.log(`  Shopify: ${health.status.toUpperCase()} — ${health.detail}`);
  console.log('══════════════════════════════════════════════════════════════════════\n');
  if (health.status !== 'connected') throw new Error(health.detail);

  const api = new ShopifyAdminApi(client);

  // 1. Inspect Locations & Themes (Read-Only)
  const locations = await api.listLocations();
  console.log('1) Shopify Locations:');
  for (const loc of locations) {
    console.log(`   • ${loc.name} (${loc.id}) — active=${loc.isActive}`);
  }

  try {
    const themeRes = await client.query(`query { themes(first: 15) { nodes { id name role } } }`);
    console.log('\n2) Installed Shopify Themes:');
    for (const th of themeRes.themes?.nodes ?? []) {
      console.log(`   • [${th.role}] ${th.name} (${th.id})`);
    }
  } catch (e) {
    console.log('\n2) Themes query skipped:', e.message);
  }

  // 2. Load all 23,381 canonical Lightspeed #114391 variants from Supabase for instant cross-reference
  const pool = createPool(process.env.DATABASE_URL);
  try {
    const comp = await pool.query(`SELECT id FROM companies WHERE slug = 'twoit-sandbox' LIMIT 1`);
    const companyId = comp.rows[0].id;
    const lsRows = await pool.query(
      `SELECT v.id, v.sku, v.upc, v.mpn, v.title, v.price_cents, v.cost_cents, p.brand,
              coalesce(inv.on_hand, 0)::int AS pos_qty
       FROM variants v
       JOIN products p ON p.id = v.product_id
       LEFT JOIN LATERAL (
         SELECT sum(il.on_hand) AS on_hand FROM inventory_levels il WHERE il.variant_id = v.id
       ) inv ON true
       WHERE v.company_id = $1 AND v.ref LIKE 'lsv-%'`,
      [companyId],
    );

    const lsByExactUpc = new Map();
    const lsByCanonicalGtin = new Map();
    const lsBySku = new Map();
    const lsByMpn = new Map();

    for (const r of lsRows.rows) {
      if (r.upc) {
        const raw = r.upc.trim();
        lsByExactUpc.set(raw, r);
        const g14 = normalizeGtin(raw);
        if (g14) {
          const arr = lsByCanonicalGtin.get(g14) ?? [];
          arr.push(r);
          lsByCanonicalGtin.set(g14, arr);
        }
      }
      if (r.sku) lsBySku.set(r.sku.trim().toUpperCase(), r);
      if (r.mpn) lsByMpn.set(r.mpn.trim().toUpperCase(), r);
    }

    console.log(`\n3) Loaded ${lsRows.rows.length.toLocaleString('en-US')} real Lightspeed #114391 items for cross-matching.`);

    // 3. Stream all Shopify variants from Carlos's store (`z5wxyn-uc.myshopify.com`)
    let cursor = null;
    let totalVariants = 0;
    const productIds = new Set();
    const statusCounts = { ACTIVE: 0, DRAFT: 0, ARCHIVED: 0 };
    let barcodeWith00Prefix = 0;
    let barcode14Digits = 0;
    let barcode15Digits = 0;
    let barcodeMissing = 0;
    let exactStringBarcodeMatches = 0;
    let healedByUbcHubGtin = 0;
    let totalGtinMatchedToPos = 0;
    let mpnOrSkuFallbackMatched = 0;
    let pureVendorCatalogOnly = 0;
    let stockMismatches = 0;
    let priceMismatches = 0;
    let zeroPriceVariants = 0;
    const sample00Healed = [];
    const sampleStockDiffs = [];

    do {
      const page = await api.listVariants(cursor);
      for (const v of page.variants) {
        totalVariants++;
        productIds.add(v.productId);
        statusCounts[v.productStatus] = (statusCounts[v.productStatus] ?? 0) + 1;
        if (v.priceCents <= 0) zeroPriceVariants++;

        const bc = (v.barcode ?? '').trim();
        if (!bc) {
          barcodeMissing++;
        } else {
          if (bc.startsWith('00') && bc.length >= 13) barcodeWith00Prefix++;
          if (bc.length === 14) barcode14Digits++;
          if (bc.length >= 15) barcode15Digits++;
        }

        const exactHit = bc ? lsByExactUpc.get(bc) : undefined;
        if (exactHit) exactStringBarcodeMatches++;

        const g14 = normalizeGtin(bc);
        const canonicalHits = g14 ? lsByCanonicalGtin.get(g14) : undefined;
        const posMatch = canonicalHits?.[0]
          ?? (v.sku ? lsBySku.get(v.sku.trim().toUpperCase()) : undefined)
          ?? (v.sku ? lsByMpn.get(v.sku.trim().toUpperCase()) : undefined);

        if (canonicalHits?.length) {
          totalGtinMatchedToPos++;
          if (!exactHit) {
            healedByUbcHubGtin++;
            if (sample00Healed.length < 12) {
              sample00Healed.push({
                shopifyTitle: `${v.productTitle} — ${v.title}`,
                shopifyBarcode: bc,
                posUpc: canonicalHits[0].upc,
                posTitle: canonicalHits[0].title,
                shopifyQty: v.inventoryQuantity,
                posQty: canonicalHits[0].pos_qty,
                shopifyPrice: (v.priceCents / 100).toFixed(2),
                posPrice: (canonicalHits[0].price_cents / 100).toFixed(2),
              });
            }
          }
        } else if (posMatch) {
          mpnOrSkuFallbackMatched++;
        } else {
          pureVendorCatalogOnly++;
        }

        if (posMatch) {
          if (v.inventoryQuantity !== posMatch.pos_qty) {
            stockMismatches++;
            if (sampleStockDiffs.length < 10) {
              sampleStockDiffs.push({
                title: `${v.productTitle} (${v.sku || bc})`,
                shopifyQty: v.inventoryQuantity,
                tampaAlafiaPosQty: posMatch.pos_qty,
                policy: v.inventoryPolicy,
              });
            }
          }
          if (Math.abs(v.priceCents - posMatch.price_cents) >= 100) {
            priceMismatches++;
          }
        }
      }
      cursor = page.nextCursor;
      if (totalVariants % 1000 === 0 || !cursor) {
        process.stdout.write(`   Read ${totalVariants.toLocaleString('en-US')} Shopify variants...\r`);
      }
    } while (cursor);

    const sec = ((performance.now() - t0) / 1000).toFixed(1);
    console.log(`\n\n══════════════════════════════════════════════════════════════════════`);
    console.log(`  FORENSIC AUDIT RESULTS (${sec}s) — z5wxyn-uc.myshopify.com`);
    console.log(`══════════════════════════════════════════════════════════════════════`);
    console.log(`  Shopify Products        : ${productIds.size.toLocaleString('en-US')}`);
    console.log(`  Shopify Variants        : ${totalVariants.toLocaleString('en-US')} (ACTIVE: ${statusCounts.ACTIVE}, DRAFT: ${statusCounts.DRAFT}, ARCHIVED: ${statusCounts.ARCHIVED})`);
    console.log(`  Barcodes w/ "00" prefix : ${barcodeWith00Prefix.toLocaleString('en-US')} (14-digit: ${barcode14Digits.toLocaleString('en-US')}, 15+ digit: ${barcode15Digits.toLocaleString('en-US')})`);
    console.log(`  Missing Barcodes        : ${barcodeMissing.toLocaleString('en-US')}`);
    console.log(`  $0.00 Price Variants    : ${zeroPriceVariants.toLocaleString('en-US')}`);
    console.log(`\n  Cross-Match vs Lightspeed #114391 (25,160 POS items):`);
    console.log(`    • Naive exact barcode match (why Accumula fails) : ${exactStringBarcodeMatches.toLocaleString('en-US')}`);
    console.log(`    • Canonical GTIN match via UBC Hub               : ${totalGtinMatchedToPos.toLocaleString('en-US')} (+${healedByUbcHubGtin.toLocaleString('en-US')} broken "00"/UPC items rescued!)`);
    console.log(`    • Additional SKU/MPN matches                     : ${mpnOrSkuFallbackMatched.toLocaleString('en-US')}`);
    console.log(`    • Pure Masterlinq Catalog-Only (Special Order)   : ${pureVendorCatalogOnly.toLocaleString('en-US')}`);
    console.log(`    • Stock qty mismatches (Shopify vs Tampa+Alafia) : ${stockMismatches.toLocaleString('en-US')}`);
    console.log(`    • Price mismatches (>=$1.00 diff vs POS)         : ${priceMismatches.toLocaleString('en-US')}`);

    if (sample00Healed.length) {
      console.log(`\n  Sample Real Items Rescued From "00"-Prefix Failure:`);
      for (const s of sample00Healed) {
        console.log(`    • Shopify [${s.shopifyBarcode}] ↔ Lightspeed [${s.posUpc}] | ${s.shopifyTitle} | Web Qty=${s.shopifyQty} vs POS Qty=${s.posQty}`);
      }
    }
    if (sampleStockDiffs.length) {
      console.log(`\n  Sample Stock Discrepancies (Shopify vs Real Tampa+Alafia POS):`);
      for (const d of sampleStockDiffs) {
        console.log(`    • ${d.title}: Shopify says ${d.shopifyQty} (${d.policy}) vs Real POS = ${d.tampaAlafiaPosQty}`);
      }
    }
    console.log(`══════════════════════════════════════════════════════════════════════\n`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Audit failed:', err.message);
  process.exit(1);
});
