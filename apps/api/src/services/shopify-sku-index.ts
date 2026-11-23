import { audit, logError } from './audit.js';
import type { AppContext } from './context.js';

/**
 * Rebuilds the compact storefront search index (`assets/ubc-sku-index.json`)
 * mapping Lightspeed System SKUs (`2100000...`), Shopify SKUs, and MPNs to
 * `[code, productHandle, numericVariantId]` tuples and pushes it to active UBC themes.
 */
export async function refreshStorefrontSkuIndexJob(ctx: AppContext, companyId: string) {
  if (ctx.config.mode === 'live' && !ctx.config.env.SHOPIFY_WRITES_ENABLED) {
    return { skipped: 'SHOPIFY_WRITES_ENABLED is false' };
  }
  const shop = String(ctx.config.env.SHOPIFY_SHOP_DOMAIN ?? '').toLowerCase();
  const rows = await ctx.pool.query<{
    shopify_product_id: string;
    shopify_variant_id: string;
    sku: string | null;
    mpn: string | null;
  }>(
    `SELECT l.shopify_product_id, l.shopify_variant_id, v.sku, v.mpn
     FROM shopify_variant_links l
     JOIN variants v ON v.id = l.variant_id
     WHERE l.company_id = $1 AND ($2 = '' OR l.shop_domain = $2)`,
    [companyId, shop],
  );

  if (!rows.rows.length) {
    return { indexedTuples: 0, themesUpdated: 0 };
  }

  const hubByVariantId = new Map<string, { sku: string; mpn: string }>();
  const productIds: string[] = [];
  for (const r of rows.rows) {
    productIds.push(r.shopify_product_id);
    hubByVariantId.set(r.shopify_variant_id, {
      sku: String(r.sku || '').trim(),
      mpn: String(r.mpn || '').trim(),
    });
  }

  const products = await ctx.connectors.shopify.fetchLinkedProductsForSkuIndex(productIds);
  const seen = new Set<string>();
  const tuples: [string, string, string][] = [];

  const addTuple = (rawCode: string, handle: string, numericVid: string) => {
    const code = String(rawCode || '').trim();
    if (code.length < 3) return;
    const key = `${code.toLowerCase()}|${handle}`;
    if (seen.has(key)) return;
    seen.add(key);
    tuples.push([code, handle, numericVid]);
  };

  for (const p of products) {
    if (p.status !== 'ACTIVE' || !p.publishedAt) continue;
    for (const sv of p.variants) {
      const numericVid = String(sv.id).replace(/^gid:\/\/shopify\/ProductVariant\//, '');
      const hub = hubByVariantId.get(sv.id);
      if (hub?.sku) addTuple(hub.sku, p.handle, numericVid);
      if (sv.sku && sv.sku !== hub?.sku) addTuple(sv.sku, p.handle, numericVid);
      if (hub?.mpn) addTuple(hub.mpn, p.handle, numericVid);
      if (sv.mpnMeta && sv.mpnMeta !== hub?.mpn) addTuple(sv.mpnMeta, p.handle, numericVid);
    }
  }

  tuples.sort((a, b) => a[0].localeCompare(b[0]));
  const jsonText = JSON.stringify(tuples);

  try {
    const { themesUpdated } = await ctx.connectors.shopify.upsertThemeAsset('assets/ubc-sku-index.json', jsonText);
    const summary = {
      linkedVariants: rows.rows.length,
      publishedProducts: products.filter((p) => p.status === 'ACTIVE' && p.publishedAt).length,
      indexedTuples: tuples.length,
      themesUpdated,
    };
    await audit(ctx.pool, { companyId, action: 'shopify.sku_index_refreshed', detail: summary });
    return summary;
  } catch (err) {
    await logError(ctx.pool, {
      companyId,
      source: 'job:shopify.refresh_sku_index',
      message: (err as Error).message,
    }).catch(() => {});
    throw err;
  }
}
