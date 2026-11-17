import { formatRetailBarcode } from '@ubc/business-rules';
import type { PublishStatus } from '@ubc/shared';
import type { ShopifyVariantRecord } from '@ubc/integrations';
import { withTransaction } from '@ubc/database';
import { audit } from './audit.js';
import type { AppContext } from './context.js';
import { setProgress } from './jobs.js';

function mapProductStatus(s: ShopifyVariantRecord['productStatus']): PublishStatus {
  if (s === 'ACTIVE') return 'published';
  if (s === 'ARCHIVED') return 'hidden';
  return 'draft';
}

function shortShopifyNumericId(gid: string): string {
  const m = /(\d+)$/.exec(gid);
  return m ? m[1]! : gid.replace(/[^A-Za-z0-9_-]/g, '').slice(-24);
}

/**
 * Pulls products, variants, unit costs, compare-at prices, locations and on-hand
 * quantities from Shopify into UBC Commerce Hub's canonical catalog.
 *
 * Works in 100% read-only Shopify mode (`SHOPIFY_WRITES_ENABLED=false`) so UBC
 * can bootstrap its catalog, run promotions/MAP/margin previews, and receive
 * orders with ONLY Shopify connected — before Lightspeed or supplier feeds are
 * enabled. Once Lightspeed R-Series is connected (`inventory_levels.source = 'lightspeed_r'`),
 * Shopify sync never overwrites Lightspeed's physical stock.
 */
export async function syncFromShopifyJob(ctx: AppContext, companyId: string, jobId?: number) {
  const locations = await ctx.connectors.shopify.listLocations();
  const preferredLocId = ctx.config.env.SHOPIFY_PHYSICAL_LOCATION_ID
    || locations.find((l) => l.isActive)?.id
    || locations[0]?.id
    || null;

  const locRow = await ctx.pool.query<{ id: string; shopify_location_id: string | null }>(
    `SELECT id, shopify_location_id FROM locations WHERE company_id = $1 AND kind = 'physical' ORDER BY name LIMIT 1`,
    [companyId],
  );
  const physicalLocationId = locRow.rows[0]?.id ?? null;
  if (physicalLocationId && preferredLocId && !locRow.rows[0]?.shopify_location_id) {
    await ctx.pool.query(`UPDATE locations SET shopify_location_id = $2 WHERE id = $1`, [physicalLocationId, preferredLocId]);
  }
  if (ctx.config.env.SHOPIFY_SHOP_DOMAIN) {
    await ctx.pool.query(
      `UPDATE stores SET shopify_shop_domain = COALESCE(shopify_shop_domain, $2) WHERE company_id = $1`,
      [companyId, ctx.config.env.SHOPIFY_SHOP_DOMAIN],
    );
  }

  let cursor: string | null = null;
  let seen = 0;
  let createdVariants = 0;
  let linkedExisting = 0;
  let updatedVariants = 0;

  do {
    const page = await ctx.connectors.shopify.listVariants(cursor);
    cursor = page.nextCursor;
    if (!page.variants.length) break;

    await withTransaction(ctx.pool, async (c) => {
      for (const sv of page.variants) {
        seen++;
        const status = mapProductStatus(sv.productStatus);
        const safePriceCents = Math.max(1, sv.priceCents || 100);
        const safeCompareCents = sv.compareAtCents && sv.compareAtCents > 0 ? sv.compareAtCents : null;
        const validUpc = formatRetailBarcode(sv.barcode);

        // 1. Resolve or create canonical product.
        const existingProdExt = await c.query<{ entity_id: string }>(
          `SELECT entity_id FROM external_ids
           WHERE company_id = $1 AND system = 'shopify' AND entity_type = 'product' AND external_id = $2`,
          [companyId, sv.productId],
        );
        let productId = existingProdExt.rows[0]?.entity_id ?? null;

        // Check if an existing variant matches by SKU or UPC so we reuse its product_id cleanly.
        const candidateVariant = await c.query<{ id: string; product_id: string; price_cents: number }>(
          `SELECT v.id, v.product_id, v.price_cents
           FROM variants v
           LEFT JOIN external_ids ev ON ev.company_id = v.company_id AND ev.system = 'shopify' AND ev.entity_type = 'variant' AND ev.entity_id = v.id
           WHERE v.company_id = $1
             AND (
               ev.external_id = $2
               OR ($3::text IS NOT NULL AND v.sku = $3)
               OR ($4::text IS NOT NULL AND v.upc IS NOT NULL AND ltrim(v.upc, '0') = ltrim($4, '0'))
             )
           ORDER BY (ev.external_id = $2) DESC NULLS LAST
           LIMIT 1`,
          [companyId, sv.variantId, sv.sku?.trim() || null, validUpc],
        );

        if (!productId && !candidateVariant.rows[0] && sv.productStatus === 'ARCHIVED') {
          continue;
        }

        if (!productId && candidateVariant.rows[0]) {
          productId = candidateVariant.rows[0].product_id;
          await c.query(
            `INSERT INTO external_ids (company_id, entity_type, entity_id, system, external_id)
             VALUES ($1, 'product', $2, 'shopify', $3)
             ON CONFLICT DO NOTHING`,
            [companyId, productId, sv.productId],
          );
        }

        if (!productId) {
          const prodRef = `sp-${shortShopifyNumericId(sv.productId)}`;
          const insProd = await c.query<{ id: string }>(
            `INSERT INTO products (company_id, ref, brand, model, category, title, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (company_id, ref) DO UPDATE SET
               title = EXCLUDED.title,
               brand = EXCLUDED.brand,
               category = EXCLUDED.category,
               status = EXCLUDED.status,
               updated_at = now()
             RETURNING id`,
            [
              companyId,
              prodRef,
              sv.vendor.trim() || 'Generic',
              sv.productTitle.trim() || 'Model',
              sv.productType.trim() || 'Uncategorized',
              sv.productTitle.trim() || sv.title,
              status,
            ],
          );
          productId = insProd.rows[0]!.id;
          await c.query(
            `INSERT INTO external_ids (company_id, entity_type, entity_id, system, external_id)
             VALUES ($1, 'product', $2, 'shopify', $3)
             ON CONFLICT DO NOTHING`,
            [companyId, productId, sv.productId],
          );
        }

        // 2. Resolve, link, or create canonical variant.
        let variantId: string;
        if (candidateVariant.rows[0]) {
          variantId = candidateVariant.rows[0].id;
          const oldPrice = candidateVariant.rows[0].price_cents;
          await c.query(
            `UPDATE variants
             SET price_cents = $2,
                 compare_at_cents = $3,
                 cost_cents = COALESCE(cost_cents, $4),
                 upc = COALESCE(upc, $5),
                 status = $6,
                 version = version + 1,
                 updated_at = now()
             WHERE id = $1`,
            [variantId, safePriceCents, safeCompareCents, sv.unitCostCents, validUpc, status],
          );
          if (oldPrice !== safePriceCents) {
            await c.query(
              `INSERT INTO price_history (company_id, variant_id, old_price_cents, new_price_cents, source)
               VALUES ($1, $2, $3, $4, 'sync')`,
              [companyId, variantId, oldPrice, safePriceCents],
            );
          }
          linkedExisting++;
          updatedVariants++;
        } else {
          const varNum = shortShopifyNumericId(sv.variantId);
          const varRef = `sv-${varNum}`;
          const fallbackSku = sv.sku?.trim() || `SHP-${varNum}`;
          const insVar = await c.query<{ id: string }>(
            `INSERT INTO variants (
               company_id, product_id, ref, title, sku, upc, price_cents, compare_at_cents, cost_cents, status
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (company_id, sku) DO UPDATE SET
               price_cents = EXCLUDED.price_cents,
               compare_at_cents = EXCLUDED.compare_at_cents,
               cost_cents = COALESCE(variants.cost_cents, EXCLUDED.cost_cents),
               updated_at = now()
             RETURNING id`,
            [
              companyId,
              productId,
              varRef,
              sv.title.trim() || sv.productTitle,
              fallbackSku,
              validUpc,
              safePriceCents,
              safeCompareCents,
              sv.unitCostCents,
              status,
            ],
          );
          variantId = insVar.rows[0]!.id;
          createdVariants++;
        }

        await c.query(
          `INSERT INTO external_ids (company_id, entity_type, entity_id, system, external_id)
           VALUES ($1, 'variant', $2, 'shopify', $3)
           ON CONFLICT (company_id, system, entity_type, entity_id) DO UPDATE SET external_id = EXCLUDED.external_id`,
          [companyId, variantId, sv.variantId],
        );
        if (sv.inventoryItemId) {
          await c.query(
            `INSERT INTO external_ids (company_id, entity_type, entity_id, system, external_id)
             VALUES ($1, 'variant', $2, 'shopify_inventory_item', $3)
             ON CONFLICT (company_id, system, entity_type, entity_id) DO UPDATE SET external_id = EXCLUDED.external_id`,
            [companyId, variantId, sv.inventoryItemId],
          );
        }

        // 3. Seed/update physical stock ONLY if Lightspeed R-Series is not yet the active source.
        if (physicalLocationId) {
          await c.query(
            `INSERT INTO inventory_levels (variant_id, location_id, company_id, on_hand, reserved, source, updated_at)
             VALUES ($1, $2, $3, $4, 0, 'shopify', now())
             ON CONFLICT (variant_id, location_id) DO UPDATE SET
               on_hand = EXCLUDED.on_hand,
               source = 'shopify',
               updated_at = now()
             WHERE inventory_levels.source <> 'lightspeed_r'`,
            [variantId, physicalLocationId, companyId, sv.inventoryQuantity],
          );
        }
      }
    });

    if (jobId) {
      await setProgress(ctx.pool, jobId, { seen, createdVariants, linkedExisting, hasMore: !!cursor });
    }
  } while (cursor);

  const summary = {
    seen,
    createdVariants,
    linkedExisting,
    updatedVariants,
    shopifyLocationId: preferredLocId,
  };
  await audit(ctx.pool, { companyId, action: 'shopify.catalog_synced', detail: summary });
  return summary;
}
