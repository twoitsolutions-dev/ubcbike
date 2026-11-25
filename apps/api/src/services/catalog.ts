import { z } from 'zod';
import type { CatalogItem, ItemFilter } from '@ubc/shared';
import type { AvailabilitySettings } from '@ubc/business-rules';
import type { Pool, PoolClient } from '@ubc/database';

type Q = Pool | PoolClient;

export const itemFilterSchema = z.object({
  q: z.string().max(200).optional(),
  ids: z.array(z.string().uuid()).max(20000).optional(),
  excludeIds: z.array(z.string().uuid()).max(20000).optional(),
  categories: z.array(z.string().max(100)).max(50).optional(),
  brands: z.array(z.string().max(100)).max(200).optional(),
  suppliers: z.array(z.string().max(50)).max(20).optional(),
  priceMinCents: z.number().int().nonnegative().optional(),
  priceMaxCents: z.number().int().nonnegative().optional(),
  marginMinPct: z.number().min(-1).max(1).optional(),
  marginMaxPct: z.number().min(-1).max(1).optional(),
  stock: z.enum(['any', 'physical', 'virtual_only', 'unavailable']).optional(),
  status: z.enum(['published', 'hidden', 'draft', 'any']).optional(),
}).strict();

export const SORTS: Record<string, string> = {
  title: 'lower(title)', brand: 'lower(brand)', price: 'price_cents', updated: 'updated_at',
  margin: '(CASE WHEN cost_cents IS NULL THEN -1 ELSE (price_cents - cost_cents)::numeric / price_cents END)',
  stock: '(physical_qty - reserved_qty)',
};

/** Build a parameterised WHERE clause mirroring business-rules/selection.matchesFilter. */
export function buildWhere(companyId: string, f: ItemFilter, av: AvailabilitySettings): { sql: string; params: unknown[] } {
  const params: unknown[] = [companyId];
  const w: string[] = ['company_id = $1'];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  if (f.ids?.length) w.push(`id = ANY(${p(f.ids)}::uuid[])`);
  if (f.excludeIds?.length) w.push(`NOT (id = ANY(${p(f.excludeIds)}::uuid[]))`);
  if (f.status && f.status !== 'any') w.push(`status = ${p(f.status)}`);
  if (f.categories?.length) w.push(`category = ANY(${p(f.categories)}::text[])`);
  if (f.brands?.length) w.push(`brand = ANY(${p(f.brands)}::text[])`);
  if (f.suppliers?.length) w.push(`EXISTS (SELECT 1 FROM jsonb_array_elements(offers) o WHERE o->>'supplierCode' = ANY(${p(f.suppliers)}::text[]))`);
  if (f.priceMinCents !== undefined) w.push(`price_cents >= ${p(f.priceMinCents)}`);
  if (f.priceMaxCents !== undefined) w.push(`price_cents <= ${p(f.priceMaxCents)}`);
  if (f.marginMinPct !== undefined) w.push(`cost_cents IS NOT NULL AND (price_cents - cost_cents)::numeric / price_cents >= ${p(f.marginMinPct)}`);
  if (f.marginMaxPct !== undefined) w.push(`cost_cents IS NOT NULL AND (price_cents - cost_cents)::numeric / price_cents <= ${p(f.marginMaxPct)}`);
  if (f.q?.trim()) {
    for (const t of f.q.trim().toLowerCase().split(/\s+/).slice(0, 8)) {
      const ph = p(`%${t.replace(/[%_\\]/g, (m) => `\\${m}`)}%`);
      w.push(`(lower(title) LIKE ${ph} OR lower(brand) LIKE ${ph} OR lower(sku) LIKE ${ph} OR coalesce(upc,'') LIKE ${ph} OR lower(coalesce(mpn,'')) LIKE ${ph})`);
    }
  }
  if (f.stock === 'physical' || f.stock === 'virtual_only' || f.stock === 'unavailable') {
    const sellable = `(physical_qty - reserved_qty - ${p(av.physicalSafetyQty)}) > 0`;
    // Only bind the freshness parameters when the expression is actually used.
    const fresh = () => `EXISTS (SELECT 1 FROM jsonb_array_elements(offers) o WHERE (o->>'qtyAvailable')::int > ${p(av.supplierSafetyQty)}
                   AND (o->>'reportedAt')::timestamptz >= now() - (${p(String(av.maxOfferAgeHours))} || ' hours')::interval
                   AND (o->>'reportedAt')::timestamptz <= now())`;
    if (f.stock === 'physical') w.push(sellable);
    if (f.stock === 'virtual_only') w.push(`NOT ${sellable} AND ${fresh()}`);
    if (f.stock === 'unavailable') w.push(`NOT ${sellable} AND NOT ${fresh()}`);
  }
  return { sql: w.join(' AND '), params };
}

interface Row {
  id: string; ref: string; product_id: string; product_ref: string; title: string; brand: string; model: string; category: string;
  sku: string; upc: string | null; mpn: string | null; price_cents: number; compare_at_cents: number | null; cost_cents: number | null;
  map_cents: number | null; map_policy: CatalogItem['mapPolicy']; status: CatalogItem['status']; version: number; updated_at: Date;
  physical_qty: number; reserved_qty: number; offers: CatalogItem['offers']; shopify_variant_id: string | null; lightspeed_item_id: string | null;
}

export function rowToItem(r: Row): CatalogItem & { ref: string; productRef: string } {
  return {
    id: r.id, ref: r.ref, productId: r.product_id, productRef: r.product_ref, title: r.title, brand: r.brand, model: r.model, category: r.category,
    sku: r.sku, upc: r.upc, mpn: r.mpn, priceCents: r.price_cents, compareAtCents: r.compare_at_cents, costCents: r.cost_cents,
    mapCents: r.map_cents, mapPolicy: r.map_policy, status: r.status, physicalQty: r.physical_qty, reservedQty: r.reserved_qty,
    offers: r.offers, shopifyVariantId: r.shopify_variant_id, lightspeedItemId: r.lightspeed_item_id,
    updatedAt: new Date(r.updated_at).toISOString(), version: r.version,
  };
}

export async function listItems(
  db: Q, companyId: string, f: ItemFilter, av: AvailabilitySettings,
  page: { limit: number; offset: number; sort: string; dir: 'asc' | 'desc' },
) {
  const { sql, params } = buildWhere(companyId, f, av);
  const order = `${SORTS[page.sort] ?? SORTS.title} ${page.dir === 'desc' ? 'DESC' : 'ASC'}, id`;
  const [rows, count] = await Promise.all([
    db.query<Row>(`SELECT * FROM catalog_items WHERE ${sql} ORDER BY ${order} LIMIT ${Number(page.limit)} OFFSET ${Number(page.offset)}`, params),
    db.query<{ n: number }>(`SELECT count(*)::int AS n FROM catalog_items WHERE ${sql}`, params),
  ]);
  return { items: rows.rows.map(rowToItem), total: count.rows[0]!.n };
}

export async function loadAllMatching(db: Q, companyId: string, f: ItemFilter, av: AvailabilitySettings, max = 100000) {
  const { sql, params } = buildWhere(companyId, f, av);
  const r = await db.query<Row>(`SELECT * FROM catalog_items WHERE ${sql} ORDER BY id LIMIT ${max + 1}`, params);
  if (r.rows.length > max) throw Object.assign(new Error(`Selection exceeds ${max} items — narrow the filter`), { statusCode: 400, code: 'SELECTION_TOO_LARGE' });
  return r.rows.map(rowToItem);
}

export async function getItem(db: Q, companyId: string, id: string) {
  const r = await db.query<Row>(`SELECT * FROM catalog_items WHERE company_id = $1 AND id = $2`, [companyId, id]);
  return r.rows[0] ? rowToItem(r.rows[0]) : null;
}

export interface BrandingSettings {
  brandName: string;
  subtitle: string;
  logoUrl: string;
  navBg: string;
  accent: string;
  gold: string;
  coral: string;
  surfaceMode: 'slate' | 'warm';
}

export const DEFAULT_BRANDING: BrandingSettings = {
  brandName: 'University Bicycle Center',
  subtitle: 'Commerce Hub · Since 1972',
  logoUrl: 'assets/ubc-logo-white.png',
  navBg: '#14202D',
  accent: '#213549',
  gold: '#CCBB8D',
  coral: '#E04F33',
  surfaceMode: 'slate',
};

export async function getSettings(db: Q, companyId: string) {
  const r = await db.query<{
    campaign_rules: import('@ubc/shared').CampaignRules;
    availability_rules: AvailabilitySettings;
    branding?: Partial<BrandingSettings> | null;
  }>(
    `SELECT campaign_rules, availability_rules, branding FROM company_settings WHERE company_id = $1`, [companyId]);
  if (!r.rows[0]) throw new Error('Company settings missing');
  return {
    campaignRules: r.rows[0].campaign_rules,
    availability: r.rows[0].availability_rules,
    branding: { ...DEFAULT_BRANDING, ...(r.rows[0].branding || {}) },
  };
}
