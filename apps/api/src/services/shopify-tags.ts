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

/** Maps Shopify / Workstand productType to the exact UBC Smart Collection `dept-*` tags. */
const PRODUCT_TYPE_TO_DEPTS: Record<string, string[]> = {
  // Bikes
  electric_bikes: ['dept-bikes', 'dept-electric-bikes'],
  ebikes: ['dept-bikes', 'dept-electric-bikes'],
  electric_bike: ['dept-bikes', 'dept-electric-bikes'],
  road_bikes: ['dept-bikes', 'dept-road-bikes'],
  road_bike: ['dept-bikes', 'dept-road-bikes'],
  gravel_bikes: ['dept-bikes', 'dept-road-bikes'],
  gravel_bike: ['dept-bikes', 'dept-road-bikes'],
  mountain_bikes: ['dept-bikes', 'dept-mountain-bikes'],
  mountain_bike: ['dept-bikes', 'dept-mountain-bikes'],
  hybrid_bikes: ['dept-bikes', 'dept-hybrid-bikes'],
  hybrid_bike: ['dept-bikes', 'dept-hybrid-bikes'],
  urban_bike: ['dept-bikes', 'dept-hybrid-bikes'],
  urban_bikes: ['dept-bikes', 'dept-hybrid-bikes'],
  comfort_bikes: ['dept-bikes', 'dept-hybrid-bikes'],
  cruiser_bikes: ['dept-bikes', 'dept-hybrid-bikes'],
  kids_bikes: ['dept-bikes', 'dept-kids-bikes'],
  childrens_bikes: ['dept-bikes', 'dept-kids-bikes'],
  bmx_bikes: ['dept-bikes', 'dept-kids-bikes'],
  // Helmets, Apparel, Shoes, Eyewear
  helmets: ['dept-helmets'],
  safety_accessories: ['dept-helmets'],
  clothing: ['dept-clothing'],
  apparel: ['dept-clothing'],
  shoes: ['dept-shoes'],
  shoes_parts_and_accessories: ['dept-shoes'],
  eyewear: ['dept-eyewear'],
  sunglasses: ['dept-eyewear'],
  // Tires & Tubes
  tires: ['dept-tires-tubes'],
  tubes: ['dept-tires-tubes', 'dept-tubes'],
  tires_and_tubes_accessories: ['dept-tires-tubes'],
  // Pedals
  pedals: ['dept-pedals'],
  pedal_parts_and_accessories: ['dept-pedals'],
  // Parts, Drivetrain, Cockpit & Wheels
  parts_other: ['dept-parts'],
  cassettes_and_freewheels_parts: ['dept-parts'],
  brake_parts: ['dept-parts'],
  chain_parts: ['dept-parts'],
  bottom_brackets_parts: ['dept-parts'],
  rear_derailleurs_parts: ['dept-parts'],
  front_derailleurs_parts: ['dept-parts'],
  cables: ['dept-parts'],
  crankset_parts: ['dept-parts'],
  crankset_parts_and_accessories: ['dept-parts'],
  stems_parts: ['dept-parts'],
  bike_wheel_parts: ['dept-parts'],
  bike_wheels: ['dept-parts'],
  wheel_hubs: ['dept-parts'],
  seatposts: ['dept-parts'],
  chainring_parts: ['dept-parts'],
  handlebar_tape: ['dept-parts'],
  handlebar_grips: ['dept-parts'],
  handlebars: ['dept-parts'],
  shifters: ['dept-parts'],
  bar_ends: ['dept-parts'],
  headsets: ['dept-parts'],
  group_sets: ['dept-parts'],
  electronic_parts_and_accessories: ['dept-parts'],
  // Hydration & Bottles
  bottles_and_cages: ['dept-hydration', 'dept-bottles-cages'],
  hydration_parts_and_accessories: ['dept-hydration'],
  nutrition: ['dept-hydration'],
  // Tools, Pumps & Bike Care
  lubes_and_cleaners: ['dept-tools'],
  tools_and_workstands: ['dept-tools'],
  pumps: ['dept-tools'],
  // Accessories, Lights, Racks & Locks
  lighting_accessories: ['dept-accessories'],
  lighting_parts_accessories: ['dept-accessories'],
  mirrors: ['dept-accessories'],
  baskets: ['dept-accessories'],
  fenders: ['dept-accessories'],
  bike_locks: ['dept-accessories'],
  u_locks_sets: ['dept-accessories'],
  accessories: ['dept-accessories'],
  racks: ['dept-accessories'],
  indoor_accessories: ['dept-accessories'],
  parts_and_accessories_for_packs_racks_and_baskets: ['dept-accessories'],
  car_rack_parts_and_accessories: ['dept-accessories'],
  car_racks: ['dept-accessories'],
  phone_accessories: ['dept-accessories'],
  electronic_accessories: ['dept-accessories'],
  childrens_bike_accessories: ['dept-accessories'],
  storage_accessories: ['dept-accessories'],
};

export function deptTagsForProductType(productType: string): string[] {
  const key = String(productType || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!key) return [];
  if (PRODUCT_TYPE_TO_DEPTS[key]) return PRODUCT_TYPE_TO_DEPTS[key];
  if (key.includes('helmet')) return ['dept-helmets'];
  if (key.includes('tube')) return ['dept-tires-tubes', 'dept-tubes'];
  if (key.includes('tire')) return ['dept-tires-tubes'];
  if (key.includes('pedal')) return ['dept-pedals'];
  if (key.includes('shoe')) return ['dept-shoes'];
  if (key.includes('eyewear') || key.includes('sunglass')) return ['dept-eyewear'];
  if (key.includes('lube') || key.includes('clean') || key.includes('tool') || key.includes('pump')) return ['dept-tools'];
  if (key.includes('bottle') || key.includes('hydrat') || key.includes('nutrit')) return ['dept-hydration'];
  if (key.includes('part') || key.includes('chain') || key.includes('brake') || key.includes('derailleur') || key.includes('wheel') || key.includes('handlebar')) return ['dept-parts'];
  if (key.includes('accessor') || key.includes('light') || key.includes('lock') || key.includes('rack') || key.includes('bag')) return ['dept-accessories'];
  return [];
}

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
      for (const dt of deptTagsForProductType(p.productType)) {
        if (!have.has(dt)) add.push(dt);
      }
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
