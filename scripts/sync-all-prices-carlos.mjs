/**
 * Implements Carlos Mirabal's 2 exact pricing rules across 100% of UBC Commerce Hub AND Shopify (`z5wxyn-uc.myshopify.com`):
 *  1) Items that sync with Lightspeed (#114391):
 *     - Regular price = Lightspeed `Default` price (never `Online` or supplier catalog price!)
 *     - When Lightspeed `SALE PRICE` > 0 and < `Default`: active price = `SALE PRICE`, compareAtPrice = `Default`!
 *  2) Items in the catalogs that DO NOT sync with Lightspeed (they come from the Workstand app):
 *     - NOT touched. Workstand owns the catalog; Lightspeed (already .99) owns real prices.
 *     - (2026-11-17: the old forced `.99` rounding of catalog-only items was removed — it fought Workstand.)
 *
 * Execution:
 *  - Updates Lightspeed-matched Hub DB variants (`price_cents` + `compare_at_cents`).
 *  - Updates Lightspeed-matched Shopify variants via `productVariantsBulkUpdate`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { normalizeGtin } from '../packages/business-rules/dist/index.js';
import { mapLsItem, ShopifyAdminApi, ShopifyAdminClient } from '../packages/integrations/dist/index.js';
import { createPool } from '../packages/database/dist/index.js';
import { loadConfig } from '../apps/api/dist/config/env.js';
import { createConnectors } from '../apps/api/dist/services/connectors.js';

const SHOP_DOMAIN = process.env.UBC_LIVE_SHOPIFY_DOMAIN || 'z5wxyn-uc.myshopify.com';
const ACCESS_TOKEN = process.env.UBC_LIVE_SHOPIFY_ACCESS_TOKEN;
const ENV_PATH = path.resolve(process.cwd(), '.env');

function syncLocalEnvRefreshToken(newRefreshToken) {
  if (!newRefreshToken || !fs.existsSync(ENV_PATH)) return;
  const raw = fs.readFileSync(ENV_PATH, 'utf8');
  if (!/^LIGHTSPEED_R_REFRESH_TOKEN=/m.test(raw)) return;
  const updated = raw.replace(/^LIGHTSPEED_R_REFRESH_TOKEN=.*$/m, `LIGHTSPEED_R_REFRESH_TOKEN=${newRefreshToken}`);
  if (updated !== raw) fs.writeFileSync(ENV_PATH, updated, 'utf8');
}

const centsToStr = (c) => (c / 100).toFixed(2);

async function submitBulkMutationJsonl(client, jsonlString) {
  const staged = await client.mutate(
    `mutation($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          resourceUrl
          parameters { name value }
        }
        userErrors { field message }
      }
    }`,
    {
      input: [
        {
          resource: 'BULK_MUTATION_VARIABLES',
          filename: 'ubc-catalog-99.jsonl',
          mimeType: 'text/jsonl',
          httpMethod: 'POST',
        },
      ],
    },
  );
  const errs = staged.stagedUploadsCreate.userErrors ?? [];
  if (errs.length) throw new Error(`stagedUploadsCreate failed: ${JSON.stringify(errs)}`);

  const target = staged.stagedUploadsCreate.stagedTargets[0];
  const form = new FormData();
  let keyParam = null;
  for (const p of target.parameters) {
    form.append(p.name, p.value);
    if (p.name === 'key') keyParam = p.value;
  }
  form.append('file', new Blob([jsonlString], { type: 'text/jsonl' }), 'ubc-catalog-99.jsonl');

  const upRes = await fetch(target.url, { method: 'POST', body: form });
  if (!upRes.ok && upRes.status !== 201 && upRes.status !== 204) {
    const txt = await upRes.text();
    throw new Error(`Bulk JSONL upload failed (${upRes.status}): ${txt.slice(0, 300)}`);
  }

  const run = await client.mutate(
    `mutation($mutation: String!, $stagedUploadPath: String!) {
      bulkOperationRunMutation(mutation: $mutation, stagedUploadPath: $stagedUploadPath) {
        bulkOperation { id status }
        userErrors { code field message }
      }
    }`,
    {
      mutation: `mutation call($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          userErrors { field message }
        }
      }`,
      stagedUploadPath: keyParam,
    },
  );
  return run.bulkOperationRunMutation;
}

async function main() {
  const t0 = performance.now();
  const cfg = loadConfig(process.env);
  const pool = createPool(cfg.env.DATABASE_URL);
  const shopClient = new ShopifyAdminClient({ shopDomain: SHOP_DOMAIN, accessToken: ACCESS_TOKEN, writesEnabled: true });
  const shopApi = new ShopifyAdminApi(shopClient);

  try {
    const companyId = (await pool.query(`SELECT id FROM companies WHERE slug = 'twoit-sandbox' LIMIT 1`)).rows[0].id;
    const connectors = createConnectors(cfg, pool, companyId);

    // 1. Load Hub Lightspeed external_ids -> variant_id
    const extRows = await pool.query(
      `SELECT external_id AS ls_id, entity_id AS vid
       FROM external_ids
       WHERE company_id = $1 AND system = 'lightspeed_r' AND entity_type = 'variant'`,
      [companyId],
    );
    const lsToVid = new Map(extRows.rows.map((r) => [String(r.ls_id), r.vid]));

    console.log(`1) Reading all 25,160 Lightspeed #114391 items (Default price + SALE PRICE)...`);
    const hubUpdates = [];
    const lsPriceByGtin = new Map();
    let lsSaleCount = 0;
    let seenLs = 0;

    for await (const page of connectors.lightspeed.iterateItems()) {
      for (const raw of page) {
        seenLs++;
        const m = mapLsItem(raw, ['1', '2']);
        if (m.salePriceCents !== null) lsSaleCount++;

        const vid = lsToVid.get(String(m.lightspeedItemId));
        if (vid && m.priceCents !== null && m.priceCents > 0) {
          hubUpdates.push({
            vid,
            price: m.priceCents,
            compare_at: m.compareAtCents,
          });
        }

        const g14 = normalizeGtin(m.upc);
        if (g14 && m.priceCents !== null && m.priceCents > 0) {
          const prev = lsPriceByGtin.get(g14);
          // Prefer stocked item or newer itemID if duplicate UPC exists in POS
          if (
            !prev ||
            (m.physicalQty > 0 && prev.physicalQty === 0) ||
            (m.physicalQty === prev.physicalQty && Number(m.lightspeedItemId) > Number(prev.lightspeedItemId))
          ) {
            lsPriceByGtin.set(g14, {
              lightspeedItemId: m.lightspeedItemId,
              priceCents: m.priceCents,
              compareAtCents: m.compareAtCents,
              physicalQty: m.physicalQty,
            });
          }
        }
      }
      if (seenLs % 5000 === 0) {
        console.log(`   • Read ${seenLs.toLocaleString('en-US')} / 25,160 Lightspeed items...`);
      }
    }

    const tokRow = await pool.query(`SELECT value FROM app_settings WHERE company_id = $1 AND key = 'lightspeed_oauth' LIMIT 1`, [companyId]).catch(() => ({ rows: [] }));
    if (tokRow.rows[0]?.value?.refreshToken) syncLocalEnvRefreshToken(tokRow.rows[0].value.refreshToken);

    console.log(`   ✓ Found ${lsSaleCount.toLocaleString('en-US')} Lightspeed items with active SALE PRICE (< Default).`);
    console.log(`   • Updating Hub DB variants with exact Lightspeed Default & SALE PRICE...`);

    for (let i = 0; i < hubUpdates.length; i += 2500) {
      const slice = hubUpdates.slice(i, i + 2500);
      await pool.query(
        `UPDATE variants AS v
         SET price_cents = r.price,
             compare_at_cents = r.compare_at,
             updated_at = now()
         FROM jsonb_to_recordset($2::jsonb) AS r(vid uuid, price int, compare_at int)
         WHERE v.company_id = $1 AND v.id = r.vid AND (v.price_cents IS DISTINCT FROM r.price OR v.compare_at_cents IS DISTINCT FROM r.compare_at)`,
        [companyId, JSON.stringify(slice)],
      );
    }

    // Non-Lightspeed catalog variants (Workstand) are NOT touched: their price stays as the catalog sends it.
    console.log(`   ✓ Hub DB updated (${hubUpdates.length.toLocaleString('en-US')} LS items synced; Workstand catalog-only items left untouched)!`);

    // 2. Scan all 167,421 Shopify variants -> compute exact synced LS prices (Rule 1) (catalog-only Workstand items untouched)
    console.log(`\n2) Scanning all 167,421 Shopify variants to align Lightspeed-matched prices...`);
    let vCur = null;
    const byProduct = new Map(); // productId -> { priority: boolean, inStock: boolean, minPriceCents: number, updates: [] }
    let syncedVariantsUpdated = 0;
    let syncedOnSaleVariants = 0;
    let nonSyncedCharm99Updated = 0;
    let alreadyExact = 0;

    do {
      const page = await shopApi.listVariants(vCur);
      for (const sv of page.variants) {
        const g14 = sv.barcode ? normalizeGtin(sv.barcode) : null;
        const ls = g14 ? lsPriceByGtin.get(g14) : null;

        let targetPrice = sv.priceCents;
        let targetCompareAt = sv.compareAtCents;

        // Only items that match Lightspeed get repriced (Default + SALE PRICE, already .99 in Carlos's POS).
        // Catalog-only variants (Workstand) keep their price exactly as Workstand sets it.
        if (ls && ls.priceCents > 0) {
          targetPrice = ls.priceCents;
          targetCompareAt = ls.compareAtCents;
        }

        let entry = byProduct.get(sv.productId);
        if (!entry) {
          entry = { priority: false, inStock: false, minPriceCents: Infinity, updates: [] };
          byProduct.set(sv.productId, entry);
        }
        if ((sv.inventoryQuantity ?? 0) > 0) {
          entry.priority = true;
          entry.inStock = true;
          if (targetPrice > 0 && targetPrice < entry.minPriceCents) entry.minPriceCents = targetPrice;
        }
        if (ls) entry.priority = true;

        if (targetPrice !== sv.priceCents || (targetCompareAt ?? null) !== (sv.compareAtCents ?? null)) {
          entry.updates.push({
            variantId: sv.variantId,
            priceCents: targetPrice,
            compareAtCents: targetCompareAt ?? null,
          });
          if (ls) {
            syncedVariantsUpdated++;
            if (targetCompareAt && targetCompareAt > targetPrice) syncedOnSaleVariants++;
          } else {
            nonSyncedCharm99Updated++;
          }
        } else {
          alreadyExact++;
        }
      }
      vCur = page.nextCursor;
    } while (vCur);

    const priorityProducts = [];
    const bulkCatalogProducts = [];
    for (const [productId, info] of byProduct.entries()) {
      if (!info.updates.length) continue;
      if (info.priority) priorityProducts.push([productId, info]);
      else bulkCatalogProducts.push([productId, info]);
    }

    console.log(`   • Synced Lightspeed variants needing price/sale update : ${syncedVariantsUpdated.toLocaleString('en-US')} (${syncedOnSaleVariants} on active Sale!)`);
    console.log(`   • Non-synced catalog variants (must be 0, untouched)    : ${nonSyncedCharm99Updated.toLocaleString('en-US')}`);
    console.log(`   • Variants already exact                               : ${alreadyExact.toLocaleString('en-US')}`);
    console.log(`   • Priority products (in-stock + LS-matched)            : ${priorityProducts.length.toLocaleString('en-US')}`);
    console.log(`   • Non-synced catalog products for Shopify BulkOp       : ${bulkCatalogProducts.length.toLocaleString('en-US')}`);

    // 3. Phase 1: Immediately update ALL priority products (in-stock + LS-matched) so Carlos sees exact prices NOW!
    console.log(`\n3) Updating all ${priorityProducts.length.toLocaleString('en-US')} in-stock & Lightspeed-matched products on Shopify NOW...`);
    let pIdx = 0;
    let pDone = 0;
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        while (pIdx < priorityProducts.length) {
          const [productId, info] = priorityProducts[pIdx++];
          // productVariantsBulkUpdate handles up to 250 variants per product
          for (let k = 0; k < info.updates.length; k += 200) {
            const slice = info.updates.slice(k, k + 200);
            await shopApi.updateVariantPrices(productId, slice);
          }
          pDone++;
          if (pDone % 100 === 0 || pDone === priorityProducts.length) {
            console.log(`   • Priority Shopify price sync: ${pDone}/${priorityProducts.length} products updated...`);
          }
        }
      }),
    );

    // Refresh price-* filter tags on in-stock products whose bracket changed
    const inStockEntries = [...byProduct.entries()].filter(([, info]) => info.inStock && Number.isFinite(info.minPriceCents));
    console.log(`   • Refreshing price bracket filter tags across ${inStockEntries.length} in-stock products...`);
    let tIdx = 0;
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        while (tIdx < inStockEntries.length) {
          const [pid, info] = inStockEntries[tIdx++];
          const pr = info.minPriceCents / 100;
          const correctTag = pr < 50 ? 'price-under-50' : pr < 200 ? 'price-50-200' : pr < 1000 ? 'price-200-1000' : 'price-1000-plus';
          const wrongTags = ['price-under-50', 'price-50-200', 'price-200-1000', 'price-1000-plus'].filter((t) => t !== correctTag);
          await shopClient.mutate(`mutation($id: ID!, $tags: [String!]!) { tagsRemove(id: $id, tags: $tags) { userErrors { message } } }`, { id: pid, tags: wrongTags }).catch(() => {});
          await shopClient.mutate(`mutation($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`, { id: pid, tags: [correctTag] }).catch(() => {});
        }
      }),
    );

    // 4. Phase 2: Submit native Shopify Bulk Mutation for ALL remaining ~23,000 products (should be none now)
    if (bulkCatalogProducts.length > 0) {
      console.log(`\n4) Submitting Shopify bulkOperationRunMutation for all ${bulkCatalogProducts.length.toLocaleString('en-US')} remaining products...`);
      const lines = [];
      for (const [productId, info] of bulkCatalogProducts) {
        for (let k = 0; k < info.updates.length; k += 250) {
          const slice = info.updates.slice(k, k + 250);
          lines.push(
            JSON.stringify({
              productId,
              variants: slice.map((u) => ({
                id: u.variantId,
                price: centsToStr(u.priceCents),
                compareAtPrice: u.compareAtCents !== null ? centsToStr(u.compareAtCents) : null,
              })),
            }),
          );
        }
      }
      const bulkRes = await submitBulkMutationJsonl(shopClient, lines.join('\n') + '\n');
      console.log(`   ✓ Bulk Mutation submitted:`, JSON.stringify(bulkRes));
    }

    const sec = ((performance.now() - t0) / 1000).toFixed(1);
    console.log(`\n══════════════════════════════════════════════════════════════════════`);
    console.log(`  ✓ LIGHTSPEED DEFAULT/SALE PRICES SYNCED (${sec}s)!`);
    console.log(`══════════════════════════════════════════════════════════════════════\n`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Price sync failed:', err);
  process.exit(1);
});
