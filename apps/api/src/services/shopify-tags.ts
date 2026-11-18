import { audit, logError } from './audit.js';
import type { AppContext } from './context.js';

/**
 * Keeps the storefront filter tags of the Workstand-owned store in sync with Lightspeed (update_only).
 * The theme's "Shop Location" filter, the In-Stock collections and the card availability label depend on:
 *   ubc-tampa-stock / ubc-alafia-stock  → product has Lightspeed stock in that store
 *   brand-<vendor handle>               → brand filter (in-stock products)
 *   price-under-50 | price-50-200 | price-200-1000 | price-1000-plus → price filter (in-stock products)
 * Only these tags are ever added/removed; every other tag (Workstand's, Carlos's) is left alone.
 * Safety: if more than half of the store tags would be removed at once, removals are skipped and alerted.
 */
export const STORE_TAGS: Record<string, string> = { '1': 'ubc-tampa-stock', '2': 'ubc-alafia-stock' };
const PRICE_TAGS = ['price-under-50', 'price-50-200', 'price-200-1000', 'price-1000-plus'];

export function handleize(str: string): string {
  return String(str || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['"’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function priceTag(cents: number): string | null {
  const p = cents / 100;
  if (!(p > 0)) return null;
  if (p < 50) return 'price-under-50';
  if (p < 200) return 'price-50-200';
  if (p < 1000) return 'price-200-1000';
  return 'price-1000-plus';
}

export async function syncStoreTagsJob(ctx: AppContext, companyId: string) {
  if (ctx.config.env.SHOPIFY_SYNC_MODE !== 'update_only') return { skipped: 'not update_only' };
  const shop = String(ctx.config.env.SHOPIFY_SHOP_DOMAIN ?? '').toLowerCase();

  // Lightspeed stock per Shopify product and store (a product is "in Tampa" if any linked variant has stock there).
  const rows = await ctx.pool.query<{ pid: string; shop_id: string | null; qty: number }>(
    `SELECT l.shopify_product_id AS pid, lo.lightspeed_shop_id AS shop_id, COALESCE(sum(il.on_hand), 0)::int AS qty
     FROM shopify_variant_links l
     LEFT JOIN inventory_levels il ON il.variant_id = l.variant_id
     LEFT JOIN locations lo ON lo.id = il.location_id
     WHERE l.company_id = $1 AND l.shop_domain = $2
     GROUP BY 1, 2`,
    [companyId, shop],
  );
  const stockBy = new Map<string, Record<string, number>>();
  for (const r of rows.rows) {
    const m = stockBy.get(r.pid) ?? {};
    if (r.shop_id) m[r.shop_id] = (m[r.shop_id] ?? 0) + r.qty;
    stockBy.set(r.pid, m);
  }

  const info = await ctx.connectors.shopify.getProductsTagInfo([...stockBy.keys()]);
  const changes: { id: string; add: string[]; remove: string[] }[] = [];
  const wantStoreTag = new Map<string, Set<string>>(); // tag -> products that must have it
  for (const t of Object.values(STORE_TAGS)) wantStoreTag.set(t, new Set());

  for (const p of info) {
    const stock = stockBy.get(p.id) ?? {};
    const have = new Set(p.tags.map((t) => t.toLowerCase()));
    const add: string[] = [];
    const remove: string[] = [];
    let inStock = false;
    for (const [shopId, tag] of Object.entries(STORE_TAGS)) {
      const has = (stock[shopId] ?? 0) > 0;
      if (has) { inStock = true; wantStoreTag.get(tag)!.add(p.id); }
      if (has && !have.has(tag)) add.push(tag);
      if (!has && have.has(tag)) remove.push(tag);
    }
    if (inStock) {
      const brand = handleize(p.vendor);
      if (brand && !have.has(`brand-${brand}`)) add.push(`brand-${brand}`);
      const pt = priceTag(p.minPriceCents);
      if (pt && !have.has(pt)) add.push(pt);
      for (const other of PRICE_TAGS) if (other !== pt && have.has(other)) remove.push(other);
    }
    if (add.length || remove.length) changes.push({ id: p.id, add, remove });
  }

  // Store tags on products that are not linked to Lightspeed at all (stale from an old one-off script).
  let staleRemoved = 0;
  const stale: { id: string; tag: string }[] = [];
  let taggedNow = 0;
  for (const tag of Object.values(STORE_TAGS)) {
    const tagged = await ctx.connectors.shopify.listProductIdsByTag(tag);
    taggedNow += tagged.length;
    for (const id of tagged) if (!stockBy.has(id)) stale.push({ id, tag });
  }
  const storeRemovals = changes.reduce((n, c) => n + c.remove.filter((t) => t.startsWith('ubc-')).length, 0) + stale.length;
  let removalsSkipped = false;
  if (taggedNow > 20 && storeRemovals > taggedNow * 0.5) {
    removalsSkipped = true;
    for (const c of changes) c.remove = c.remove.filter((t) => !t.startsWith('ubc-'));
    await logError(ctx.pool, { companyId, source: 'job:shopify.sync_tags', message: `Would remove ${storeRemovals} of ${taggedNow} store tags (>50%) — removals skipped, please review` }).catch(() => {});
  }

  let updated = 0;
  let failed = 0;
  for (const c of changes) {
    if (!c.add.length && !c.remove.length) continue;
    try { await ctx.connectors.shopify.updateProductTags(c.id, c.add, c.remove); updated++; } catch (err) {
      failed++;
      await logError(ctx.pool, { companyId, source: 'job:shopify.sync_tags', message: (err as Error).message, context: { productId: c.id } }).catch(() => {});
    }
  }
  if (!removalsSkipped) {
    for (const s of stale) {
      try { await ctx.connectors.shopify.updateProductTags(s.id, [], [s.tag]); staleRemoved++; } catch { failed++; }
    }
  }

  const summary = {
    shop, linkedProducts: info.length, productsUpdated: updated, staleStoreTagsRemoved: staleRemoved, failed, removalsSkipped,
    inTampa: wantStoreTag.get('ubc-tampa-stock')!.size, inAlafia: wantStoreTag.get('ubc-alafia-stock')!.size,
  };
  await audit(ctx.pool, { companyId, action: 'shopify.store_tags_synced', detail: summary });
  return summary;
}
