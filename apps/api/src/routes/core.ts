import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { computeAvailability, evaluateLine } from '@ubc/business-rules';
import { DEMO_NOTICE } from '@ubc/demo-data';
import { ROLE_PERMISSIONS, type ItemFilter } from '@ubc/shared';
import { withTransaction } from '@ubc/database';
import { login, logout, requireAuth } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { buildWhere, getItem, getSettings, itemFilterSchema, listItems, loadAllMatching } from '../services/catalog.js';
import { conflict, HttpError, notFound, type AppContext } from '../services/context.js';
import { enqueue } from '../services/jobs.js';
import { rulesSchema } from '../services/campaigns.js';
import {
  addManualReview,
  deleteReview,
  getReviewsState,
  manualReviewSchema,
  publishReviewsToShopify,
  reviewSourcesUpdateSchema,
  syncGoogleReviews,
  toggleReviewSchema,
  updateReviewFlags,
  updateReviewSources,
} from '../services/google-reviews.js';
import { generatePhoneGreetingAudio, getVoiceClip, saveVoiceClip, voiceGenerateSchema } from '../services/phone-voice.js';
import { syncLightspeedLastSalesJob } from '../services/lightspeed-sync.js';
import { getUnlinkedUpcReport } from '../services/shopify-links.js';

const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  sort: z.enum(['title', 'brand', 'price', 'margin', 'stock', 'updated']).default('title'),
  dir: z.enum(['asc', 'desc']).default('asc'),
});

/** Query-string filters arrive as comma lists; normalise them into an ItemFilter. */
export function filterFromQuery(q: Record<string, unknown>): ItemFilter {
  const list = (v: unknown) => (typeof v === 'string' && v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);
  const num = (v: unknown) => (v === undefined || v === '' ? undefined : Number(v));
  return itemFilterSchema.parse({
    q: typeof q.q === 'string' && q.q ? q.q : undefined,
    ids: list(q.ids),
    excludeIds: list(q.excludeIds),
    categories: list(q.categories), brands: list(q.brands), suppliers: list(q.suppliers),
    priceMinCents: num(q.priceMinCents), priceMaxCents: num(q.priceMaxCents),
    marginMinPct: num(q.marginMinPct), marginMaxPct: num(q.marginMaxPct),
    stock: q.stock || undefined, status: q.status || undefined,
  });
}

const dashboardCache = new Map<string, { at: number; v: unknown }>();

/** Lightspeed ↔ Shopify (Workstand store) coverage for the dashboard. Cached 60 s per company. */
const syncStatsCache = new Map<string, { at: number; v: unknown }>();
async function shopifySyncStats(ctx: AppContext, companyId: string) {
  const hit = syncStatsCache.get(companyId);
  if (hit && Date.now() - hit.at < 60_000) return hit.v;
  const shop = String(ctx.config.env.SHOPIFY_SHOP_DOMAIN ?? '').toLowerCase();
  const r = await ctx.pool.query<Record<string, number>>(
    `WITH q AS (SELECT variant_id, sum(on_hand) AS qty FROM inventory_levels WHERE company_id = $1 GROUP BY variant_id),
     lk AS (SELECT DISTINCT variant_id FROM shopify_variant_links WHERE company_id = $1 AND shop_domain = $2),
     ls AS (
       SELECT v.id, COALESCE(v.upc ~ '^[0-9]{8,14}$', false) AS has_upc, COALESCE(q.qty, 0) AS qty, (lk.variant_id IS NOT NULL) AS linked
       FROM variants v
       JOIN products p ON p.id = v.product_id
       JOIN external_ids e ON e.company_id = v.company_id AND e.entity_type = 'variant' AND e.entity_id = v.id AND e.system = 'lightspeed_r'
       LEFT JOIN q ON q.variant_id = v.id
       LEFT JOIN lk ON lk.variant_id = v.id
       WHERE v.company_id = $1 AND p.status <> 'hidden')
     SELECT count(*)::int AS ls_items,
            count(*) FILTER (WHERE has_upc)::int AS ls_with_upc,
            count(*) FILTER (WHERE linked)::int AS linked_items,
            count(*) FILTER (WHERE qty > 0)::int AS in_stock,
            count(*) FILTER (WHERE qty > 0 AND linked)::int AS in_stock_linked,
            count(*) FILTER (WHERE qty > 0 AND NOT linked AND has_upc)::int AS in_stock_missing,
            count(*) FILTER (WHERE qty > 0 AND NOT has_upc)::int AS in_stock_no_upc,
            count(*) FILTER (WHERE qty = 1)::int AS qty1_total,
            count(*) FILTER (WHERE qty = 1 AND linked)::int AS qty1_linked,
            count(*) FILTER (WHERE qty = 1 AND NOT linked AND has_upc)::int AS qty1_missing,
            count(*) FILTER (WHERE qty = 1 AND NOT linked AND NOT has_upc)::int AS qty1_no_upc,
            count(*) FILTER (WHERE qty >= 2)::int AS qty2_total,
            count(*) FILTER (WHERE qty >= 2 AND linked)::int AS qty2_linked,
            count(*) FILTER (WHERE qty >= 2 AND NOT linked AND has_upc)::int AS qty2_missing,
            count(*) FILTER (WHERE qty >= 2 AND NOT linked AND NOT has_upc)::int AS qty2_no_upc,
            COALESCE(sum(qty) FILTER (WHERE qty > 0), 0)::int AS units,
            COALESCE(sum(qty) FILTER (WHERE qty > 0 AND linked), 0)::int AS units_linked,
            (SELECT count(*) FROM shopify_variant_links WHERE company_id = $1 AND shop_domain = $2)::int AS linked_variants
     FROM ls`,
    [companyId, shop],
  );
  const last = async (action: string) => (await ctx.pool.query<{ created_at: Date; detail: Record<string, unknown> }>(
    `SELECT created_at, detail FROM audit_log WHERE company_id = $1 AND action = $2 ORDER BY created_at DESC LIMIT 1`, [companyId, action])).rows[0] ?? null;
  const [match, reconcile, lsSync] = await Promise.all([
    last('shopify.upc_links_proposed'), last('pipeline.shopify_prices_reconciled'), last('lightspeed.catalog_synced'),
  ]);
  const fixed24h = (await ctx.pool.query<{ prices: number; stock: number }>(
    `SELECT COALESCE(sum((detail->>'drifted')::int), 0)::int AS prices, COALESCE(sum((detail->>'stockDrifted')::int), 0)::int AS stock
     FROM audit_log WHERE company_id = $1 AND action = 'pipeline.shopify_prices_reconciled' AND created_at > now() - interval '24 hours'`, [companyId])).rows[0];
  const dups = await ctx.pool.query<{
    id: string; title: string; sku: string; upc: string | null; variants: number; product_ids: string[];
  }>(
    `SELECT v.id, v.title, v.sku, v.upc, count(*)::int AS variants,
            array_agg(DISTINCT l.shopify_product_id) AS product_ids
     FROM shopify_variant_links l
     JOIN variants v ON v.id = l.variant_id
     WHERE l.company_id = $1 AND l.shop_domain = $2
     GROUP BY v.id, v.title, v.sku, v.upc
     HAVING count(*) > 1
     ORDER BY v.title
     LIMIT 30`,
    [companyId, shop],
  );
  const v = {
    shop,
    ...r.rows[0],
    storeVariants: match ? Number(match.detail.storeVariants) || null : null,
    lastMatchAt: match?.created_at ?? null,
    lastReconcileAt: reconcile?.created_at ?? null,
    lastLightspeedSyncAt: lsSync?.created_at ?? null,
    overwrittenFixed24h: fixed24h,
    duplicate_links: dups.rows,
  };
  syncStatsCache.set(companyId, { at: Date.now(), v });
  return v;
}

export function registerCoreRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/health', async () => ({ ok: true }));

  app.get('/privacy', async (_req, reply) => {
    reply.header('Content-Type', 'text/html; charset=utf-8');
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Privacy Policy · BikeShop Sync by TwoIT Solutions LLC</title>
  <style>
    body{margin:0;background:#FAF9F4;color:#14202D;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.6}
    main{max-width:760px;margin:40px auto;padding:32px;background:#fff;border:1px solid rgba(20,32,45,.1);border-radius:16px}
    .brand{display:flex;align-items:center;gap:10px;margin-bottom:18px;font-weight:700;font-size:15px}
    h1{margin:0 0 8px;font-size:26px}
    h2{margin:24px 0 8px;font-size:18px;color:#14202D}
    .muted{color:#475569;font-size:14px}
    ul{padding-left:20px}
    a{color:#14202D}
  </style>
</head>
<body>
  <main>
    <div class="brand">
      <svg width="24" height="24" viewBox="0 0 32 32" fill="none" aria-hidden="true" style="border-radius:6px">
        <rect width="32" height="32" rx="7" fill="#0F172A"/>
        <path d="M8.5 9.5L15.5 15.5L8.5 21.5" stroke="#F1F5F9" stroke-width="3.2" stroke-linecap="square"/>
        <rect x="16.5" y="19.5" width="7.5" height="3.2" fill="#FBBF24"/>
      </svg>
      <span>BikeShop Sync · TwoIT Solutions LLC</span>
    </div>
    <h1>Privacy Policy</h1>
    <p class="muted">Effective date: November 24, 2026</p>
    <p><strong>TwoIT Solutions LLC</strong> operates <strong>BikeShop Sync</strong>, a retail operations hub connecting Shopify stores with point-of-sale systems (Lightspeed R-Series) and cycling suppliers.</p>
    <h2>1. Customer Data Processed</h2>
    <ul>
      <li><strong>Order identification only:</strong> When processing Shopify orders for special-order and pickup fulfillment, the Hub stores only the customer's <strong>first and last name</strong> alongside order totals and line items.</li>
      <li><strong>No sensitive contact or payment data stored:</strong> The Hub does not store customer email addresses, phone numbers, street addresses, or payment card details from Shopify.</li>
    </ul>
    <h2>2. Purpose &amp; Sharing</h2>
    <p>Data is used solely to synchronize inventory, pricing, and order fulfillment for the merchant. TwoIT Solutions LLC never sells, rents, or shares customer data with third parties or advertising networks.</p>
    <h2>3. Security &amp; Encryption</h2>
    <ul>
      <li>All traffic is encrypted in transit via <strong>HTTPS / TLS</strong>.</li>
      <li>Database records and backups are encrypted at rest (<strong>AES-256</strong>) in PostgreSQL (Supabase), with strict multi-tenant isolation by merchant (<code>company_id</code>).</li>
      <li>Staff access requires authenticated accounts with minimum 12-character <code>scrypt</code>-hashed passwords, CSRF protection, role-based access control (RBAC), and audit logging of order views and state changes.</li>
    </ul>
    <h2>4. Retention &amp; Deletion</h2>
    <p>Merchant and order data is retained only while the merchant account is active and is deleted upon merchant request or store disconnection.</p>
    <h2>5. Contact</h2>
    <p>For privacy or data deletion requests, contact <a href="https://www.twoitsolutions.com" target="_blank" rel="noopener">TwoIT Solutions LLC</a>.</p>
  </main>
</body>
</html>`;
  });

  app.get('/api/system', async () => {
    let dbLsActive = false;
    try {
      const r = await ctx.pool.query<{ active: string | null }>(
        `SELECT availability_rules->>'lightspeedWritesActive' AS active FROM company_settings LIMIT 1`,
      );
      dbLsActive = r.rows[0]?.active === 'true';
    } catch {}
    return {
      mode: ctx.config.mode,
      demoNotice: ctx.config.mode === 'demo' ? DEMO_NOTICE : null,
      posEventWritesEnabled: !!ctx.config.env.LIGHTSPEED_R_POS_EVENT_WRITES_ENABLED || dbLsActive,
      lightspeedWritesEnabled: !!ctx.config.env.LIGHTSPEED_WRITES_ENABLED || dbLsActive,
      version: '0.1.0',
    };
  });

  app.post('/api/auth/login', { config: { rawBody: false } }, async (req, reply) => {
    const body = z.object({ email: z.string().trim().min(2).max(200), password: z.string().min(1).max(200) }).parse(req.body);
    return login(ctx, req, reply, body.email, body.password);
  });

  app.get('/api/auth/me', { preHandler: requireAuth(ctx) }, async (req) => {
    const s = req.session!;
    return { user: { id: s.userId, name: s.name, email: s.email, role: s.role }, permissions: ROLE_PERMISSIONS[s.role], csrfToken: s.csrfToken, mode: ctx.config.mode };
  });

  app.post('/api/auth/logout', { preHandler: requireAuth(ctx) }, async (req, reply) => {
    await logout(ctx, req, reply);
    return { ok: true };
  });

  app.get('/api/dashboard', { preHandler: requireAuth(ctx, 'catalog.read') }, async (req) => {
    const c = req.session!.companyId;
    // The dashboard is requested twice on load (page + menu badges): serve the second from a 20 s cache.
    const cached = dashboardCache.get(c);
    if (cached && Date.now() - cached.at < 20_000) return cached.v;
    const { availability } = await getSettings(ctx.pool, c);
    // Count in SQL with the same filters as Item Search instead of loading the whole catalog (~30k rows).
    const countWhere = async (f: Record<string, unknown>) => {
      const { sql, params } = buildWhere(c, f as never, availability);
      return (await ctx.pool.query<{ n: number }>(`SELECT count(*)::int n FROM catalog_items WHERE ${sql}`, params)).rows[0]!.n;
    };
    const [total, published, physical, virtualOnly, unavailable] = await Promise.all([
      countWhere({}), countWhere({ status: 'published' }), countWhere({ stock: 'physical' }),
      countWhere({ stock: 'virtual_only' }), countWhere({ stock: 'unavailable' }),
    ]);
    const counts = { published, physical, virtualOnly, unavailable, total };
    const q = (sql: string) => ctx.pool.query<{ n: number }>(sql, [c]).then((r) => r.rows[0]!.n);
    const [orders, pendingSpecial, awaitingApproval, activeCampaigns, openErrors, deadJobs, reviews, upcReview] = await Promise.all([
      q(`SELECT count(*)::int n FROM orders WHERE company_id = $1`),
      q(`SELECT count(*)::int n FROM orders WHERE company_id = $1 AND is_special_order AND internal_status NOT IN ('completed','cancelled')`),
      q(`SELECT count(*)::int n FROM orders WHERE company_id = $1 AND internal_status = 'awaiting_approval'`),
      q(`SELECT count(*)::int n FROM campaigns WHERE company_id = $1 AND status IN ('active','scheduled','applying')`),
      q(`SELECT count(*)::int n FROM error_log WHERE company_id = $1 AND resolved_at IS NULL`),
      // Failed jobs that are still a problem: a dead recurring sync stops counting once a later run of it succeeded.
      q(`SELECT count(*)::int n FROM jobs d WHERE d.company_id = $1 AND d.status = 'dead'
          AND NOT (d.type = ANY('{lightspeed.sync_catalog,lightspeed.sync_special_orders,pipeline.flush_shopify,shopify.reconcile_links,shopify.link_store,shopify.sync_tags,shopify.sync_catalog,pipeline.watchdog}'::text[])
                   AND EXISTS (SELECT 1 FROM jobs s WHERE s.company_id = d.company_id AND s.type = d.type AND s.status = 'succeeded' AND s.created_at > d.created_at))`),
      q(`SELECT count(*)::int n FROM match_reviews WHERE company_id = $1 AND status = 'pending'`),
      q(`SELECT count(*)::int n FROM upc_link_proposals WHERE company_id = $1 AND status = 'pending'`).catch(() => 0),
    ]);
    const syncs = await ctx.pool.query(`SELECT type, status, finished_at, created_at FROM jobs WHERE company_id = $1 ORDER BY created_at DESC LIMIT 8`, [c]);
    const shopifySync = ctx.config.env.SHOPIFY_SYNC_MODE === 'update_only' ? await shopifySyncStats(ctx, c).catch(() => null) : null;
    const healthRes = await ctx.pool.query<{ negative_margin: number; map_violations: number; missing_cost: number }>(
      `SELECT
         count(*) FILTER (WHERE c.cost_cents > 0 AND c.price_cents < c.cost_cents)::int AS negative_margin,
         count(*) FILTER (
           WHERE c.map_cents > 0 AND c.price_cents < c.map_cents
             AND NOT EXISTS (SELECT 1 FROM map_exceptions me WHERE me.company_id = c.company_id AND me.variant_id = c.id AND me.valid_until > now())
         )::int AS map_violations,
         count(*) FILTER (WHERE c.cost_cents IS NULL OR c.cost_cents <= 0)::int AS missing_cost
       FROM catalog_items c
       WHERE c.company_id = $1 AND c.physical_qty > 0`,
      [c],
    ).catch(() => ({ rows: [{ negative_margin: 0, map_violations: 0, missing_cost: 0 }] }));
    const hRow = healthRes.rows[0] || { negative_margin: 0, map_violations: 0, missing_cost: 0 };
    const payload = {
      shopifySync,
      catalogHealth: {
        negativeMargin: hRow.negative_margin,
        mapViolations: hRow.map_violations,
        missingCost: hRow.missing_cost,
      },
      storeUrl: ctx.config.env.SHOPIFY_STORE_URL || (ctx.config.env.SHOPIFY_SHOP_DOMAIN ? `https://${ctx.config.env.SHOPIFY_SHOP_DOMAIN}` : null),
      counts: { ...counts, orders, pendingSpecial, awaitingApproval, activeCampaigns, openErrors, deadJobs, pendingMatchReviews: reviews, upcReview },
      recentJobs: syncs.rows,
      shopifySales: ctx.config.mode === 'demo' ? { available: false, reason: 'Shopify not connected (DEMO)' } : { available: false, reason: 'Requires authorised Shopify connection' },
    };
    dashboardCache.set(c, { at: Date.now(), v: payload });
    return payload;
  });

  // ---------- Catalog ----------
  app.get('/api/items', { preHandler: requireAuth(ctx, 'catalog.read') }, async (req) => {
    const q = req.query as Record<string, unknown>;
    const page = pageSchema.parse(q);
    const c = req.session!.companyId;
    const { availability } = await getSettings(ctx.pool, c);
    const { items, total } = await listItems(ctx.pool, c, filterFromQuery(q), availability, page);
    return { total, items: items.map((i) => ({ ...i, availability: computeAvailability(i, availability) })) };
  });

  const getLsWritesActive = async (companyId: string): Promise<boolean> => {
    const r = await ctx.pool.query<{ ls_active: string | null }>(
      `SELECT availability_rules->>'lightspeedWritesActive' AS ls_active FROM company_settings WHERE company_id = $1`,
      [companyId],
    );
    const val = r.rows[0]?.ls_active;
    if (val === 'true') return true;
    if (val === 'false') return false;
    return !!ctx.config.env.LIGHTSPEED_WRITES_ENABLED;
  };

  app.get('/api/lightspeed/sheet', { preHandler: requireAuth(ctx, 'catalog.read') }, async (req) => {
    const q = req.query as Record<string, unknown>;
    const page = pageSchema.parse(q);
    const c = req.session!.companyId;
    const { availability } = await getSettings(ctx.pool, c);
    const writesEnabled = await getLsWritesActive(c);
    const filter = filterFromQuery(q);
    if (!q.stock) filter.stock = 'physical';
    else if (q.stock === 'any') delete filter.stock;
    const hasMinDays = q.minDays !== undefined && q.minDays !== '';
    const minDays = hasMinDays ? Math.max(0, Math.min(3650, Math.floor(Number(q.minDays) || 0))) : null;
    if (minDays !== null && minDays > 0) {
      const agingRes = await ctx.pool.query<{ id: string }>(
        `WITH hub_sale AS (
           SELECT ol.variant_id, max(o.created_at) AS last_sold_at
           FROM order_lines ol
           JOIN orders o ON o.id = ol.order_id
           WHERE o.company_id = $1 AND o.internal_status <> 'cancelled' AND ol.variant_id IS NOT NULL
           GROUP BY ol.variant_id
         ),
         eff AS (
           SELECT v.id,
             CASE
               WHEN v.last_sold_at IS NULL THEN hs.last_sold_at
               WHEN hs.last_sold_at IS NULL THEN v.last_sold_at
               ELSE GREATEST(v.last_sold_at, hs.last_sold_at)
             END AS last_sold_at
           FROM variants v
           LEFT JOIN hub_sale hs ON hs.variant_id = v.id
           WHERE v.company_id = $1
         )
         SELECT id::text AS id
         FROM eff
         WHERE last_sold_at IS NULL OR last_sold_at <= now() - make_interval(days => $2)`,
        [c, minDays],
      );
      const agingSet = new Set(agingRes.rows.map((r) => r.id));
      filter.ids = filter.ids ? filter.ids.filter((id) => agingSet.has(id)) : Array.from(agingSet);
      if (!filter.ids.length) {
        return { total: 0, writesEnabled, items: [] };
      }
    }
    const { items, total } = await listItems(ctx.pool, c, filter, availability, page);
    const tagFilter = typeof q.tag === 'string' ? q.tag.trim().toLowerCase() : '';
    const includeHidden = q.status === 'hidden' || q.includeHidden === '1';
    const visibleItems = items.filter((i) => includeHidden || i.status !== 'hidden');

    const daysNoSaleByVariant = new Map<string, number | null>();
    if (visibleItems.length) {
      const vids = visibleItems.map((i) => i.id);
      const dRes = await ctx.pool.query<{ variant_id: string; days_without_sale: number | null }>(
        `WITH hub_sale AS (
           SELECT ol.variant_id, max(o.created_at) AS last_sold_at
           FROM order_lines ol
           JOIN orders o ON o.id = ol.order_id
           WHERE o.company_id = $1 AND o.internal_status <> 'cancelled' AND ol.variant_id = ANY($2::uuid[])
           GROUP BY ol.variant_id
         ),
         eff AS (
           SELECT v.id,
             CASE
               WHEN v.last_sold_at IS NULL THEN hs.last_sold_at
               WHEN hs.last_sold_at IS NULL THEN v.last_sold_at
               ELSE GREATEST(v.last_sold_at, hs.last_sold_at)
             END AS last_sold_at
           FROM variants v
           LEFT JOIN hub_sale hs ON hs.variant_id = v.id
           WHERE v.company_id = $1 AND v.id = ANY($2::uuid[])
         )
         SELECT id::text AS variant_id,
                CASE WHEN last_sold_at IS NULL THEN NULL ELSE EXTRACT(DAY FROM (now() - last_sold_at))::int END AS days_without_sale
         FROM eff`,
        [c, vids],
      );
      for (const r of dRes.rows) daysNoSaleByVariant.set(r.variant_id, r.days_without_sale);
    }

    // Hydrate exact live Lightspeed fields (`customSku`, `Tags`, all 4 `Prices`, `defaultCost`, `reorderPoint`, `desiredLevel`) for visible rows.
    const lsDetailsByVariant = new Map<string, Awaited<ReturnType<NonNullable<typeof ctx.connectors.lightspeed>['fetchSheetDetailsByIds']>> extends Map<string, infer V> ? V : never>();
    if (visibleItems.length && ctx.connectors.lightspeed) {
      try {
        const vids = visibleItems.map((i) => i.id);
        const extRes = await ctx.pool.query<{ entity_id: string; external_id: string }>(
          `SELECT entity_id, external_id FROM external_ids WHERE company_id = $1 AND system = 'lightspeed_r' AND entity_id = ANY($2::uuid[])`,
          [c, vids],
        );
        const shopId = (ctx.config.env.LIGHTSPEED_R_PHYSICAL_SHOP_ID || '1').split(',')[0]?.trim() || '1';
        const lsMap = await ctx.connectors.lightspeed.fetchSheetDetailsByIds(
          extRes.rows.map((r) => r.external_id),
          shopId,
        );
        for (const r of extRes.rows) {
          const det = lsMap.get(r.external_id);
          if (det) lsDetailsByVariant.set(r.entity_id, det);
        }
      } catch (err) {
        req.log.warn({ err }, 'Live Lightspeed sheet hydration skipped; falling back to DB values');
      }
    }

    const mapped = visibleItems
      .map((i) => {
        const raw = i as unknown as Record<string, unknown>;
        const ls = lsDetailsByVariant.get(i.id);
        const tags = ls ? ls.tags : Array.isArray(raw.tags) ? (raw.tags as string[]) : [];
        return {
          id: i.id,
          sku: i.sku,
          mpn: ls?.mpn || (raw.mpn as string) || '',
          upc: ls?.upc || i.upc || '',
          description: ls?.description || i.title,
          customSku: ls ? ls.customSku : (raw.customSku as string) || '',
          brand: i.brand || '',
          category: i.category || '',
          tags,
          defaultPriceCents: ls?.defaultPriceCents ?? i.priceCents,
          msrpCents: ls ? ls.msrpCents : (raw.msrpCents as number | null) ?? null,
          salePriceCents: ls ? ls.salePriceCents : (raw.salePriceCents as number | null) ?? null,
          onlinePriceCents: ls ? ls.onlinePriceCents : (raw.onlinePriceCents as number | null) ?? null,
          defaultCostCents: ls ? ls.defaultCostCents : i.costCents ?? null,
          reorderPoint: ls ? ls.reorderPoint : (raw.reorderPoint as number | null) ?? 0,
          desiredLevel: ls ? ls.desiredLevel : (raw.desiredLevel as number | null) ?? 0,
          physicalQty: i.physicalQty ?? 0,
          daysWithoutSale: daysNoSaleByVariant.has(i.id) ? daysNoSaleByVariant.get(i.id)! : null,
          version: i.version,
        };
      })
      .filter((row) => !tagFilter || row.tags.some((t) => String(t).toLowerCase().includes(tagFilter)));
    return {
      total: tagFilter ? mapped.length : total,
      writesEnabled,
      items: mapped,
    };
  });

  app.post('/api/lightspeed/mode', { preHandler: requireAuth(ctx, 'catalog.write') }, async (req, reply) => {
    const s = req.session!;
    if (!['owner', 'admin'].includes(s.role)) {
      return reply.code(403).send({ error: 'FORBIDDEN', message: 'Only owner or admin can change Lightspeed write mode.' });
    }
    const { paused } = z.object({ paused: z.boolean() }).parse(req.body);
    const enabled = !paused;
    await ctx.pool.query(
      `UPDATE company_settings
       SET availability_rules = COALESCE(availability_rules, '{}'::jsonb) || jsonb_build_object('lightspeedWritesActive', $1::boolean)
       WHERE company_id = $2`,
      [enabled, s.companyId],
    );
    await audit(ctx.pool, {
      companyId: s.companyId,
      userId: s.userId,
      action: 'lightspeed.mode_changed',
      entityType: 'company',
      entityId: s.companyId,
      detail: { writesEnabled: enabled },
    });
    return {
      ok: true,
      writesEnabled: enabled,
    };
  });

  const lsBulkChangeSchema = z.object({
    id: z.string().min(1),
    description: z.string().min(1).max(300).optional(),
    customSku: z.string().max(120).optional(),
    tags: z.array(z.string().max(64)).max(50).optional(),
    defaultPriceCents: z.number().int().nonnegative().optional(),
    msrpCents: z.number().int().nonnegative().nullable().optional(),
    salePriceCents: z.number().int().nonnegative().nullable().optional(),
    onlinePriceCents: z.number().int().nonnegative().nullable().optional(),
    defaultCostCents: z.number().int().nonnegative().nullable().optional(),
    reorderPoint: z.number().int().nonnegative().optional(),
    desiredLevel: z.number().int().nonnegative().optional(),
  });

  app.post('/api/lightspeed/bulk-update', { preHandler: requireAuth(ctx, 'catalog.write') }, async (req, reply) => {
    const s = req.session!;
    if (!['owner', 'admin', 'purchasing'].includes(s.role)) {
      return reply.code(403).send({
        error: 'FORBIDDEN',
        message: 'Only owner, admin, or purchasing accounts can push bulk updates to Lightspeed.',
      });
    }
    const body = z.object({ changes: z.array(lsBulkChangeSchema).min(1).max(100) }).parse(req.body);
    const active = await getLsWritesActive(s.companyId);
    if (!active) {
      return reply.code(403).send({
        error: 'LIGHTSPEED_READ_ONLY',
        message: 'Lightspeed Sheet is in Read-Only mode. Click "Enable Live Writes" at the top of the sheet first.',
      });
    }

    const ids = body.changes.map((c) => c.id);
    const linkRes = await ctx.pool.query<{
      variant_id: string;
      product_id: string;
      lightspeed_item_id: string;
    }>(
      `SELECT pv.id AS variant_id, pv.product_id, ei.external_id AS lightspeed_item_id
       FROM variants pv
       JOIN external_ids ei ON ei.entity_id = pv.id AND ei.company_id = pv.company_id AND ei.system = 'lightspeed_r'
       WHERE pv.company_id = $1 AND pv.id = ANY($2::uuid[])`,
      [s.companyId, ids],
    );
    const lsByVariant = new Map(linkRes.rows.map((r) => [r.variant_id, r]));
    const shopId = (ctx.config.env.LIGHTSPEED_R_PHYSICAL_SHOP_ID || '1').split(',')[0]?.trim() || '1';

    const updates = [];
    const skipped: string[] = [];
    for (const ch of body.changes) {
      const link = lsByVariant.get(ch.id);
      if (!link) {
        skipped.push(ch.id);
        continue;
      }
      updates.push({
        lightspeedItemId: link.lightspeed_item_id,
        description: ch.description,
        customSku: ch.customSku,
        tags: ch.tags,
        defaultPriceCents: ch.defaultPriceCents,
        msrpCents: ch.msrpCents,
        salePriceCents: ch.salePriceCents,
        onlinePriceCents: ch.onlinePriceCents,
        defaultCostCents: ch.defaultCostCents,
        reorderPoint: ch.reorderPoint,
        desiredLevel: ch.desiredLevel,
        physicalShopId: shopId,
      });
    }

    if (!ctx.connectors.lightspeed) {
      return reply.code(400).send({ error: 'NOT_CONFIGURED', message: 'Lightspeed connector is not configured.' });
    }
    const results = updates.length ? await ctx.connectors.lightspeed.bulkUpdateItems(updates, { authorizedByOwner: true }) : [];
    for (const ch of body.changes) {
      const link = lsByVariant.get(ch.id);
      if (!link) continue;
      const resRow = results.find((r) => r.lightspeedItemId === link.lightspeed_item_id);
      await audit(ctx.pool, {
        companyId: s.companyId,
        userId: s.userId,
        action: 'lightspeed.bulk_sheet_updated',
        entityType: 'variant',
        entityId: ch.id,
        detail: { lightspeedItemId: link.lightspeed_item_id, changes: ch, before: resRow?.before ?? null },
      });
      if (ch.description !== undefined) {
        await ctx.pool.query(`UPDATE products SET title = $1, updated_at = NOW() WHERE id = $2 AND company_id = $3`, [ch.description, link.product_id, s.companyId]);
        await ctx.pool.query(`UPDATE variants SET title = $1, updated_at = NOW() WHERE id = $2 AND company_id = $3`, [ch.description, ch.id, s.companyId]);
        const hubShopProd = await ctx.pool.query<{ shopify_product_id: string }>(
          `SELECT shopify_product_id FROM shopify_variant_links
           WHERE company_id = $1 AND variant_id = $2 AND match_method = 'created_in_hub'
             AND (SELECT count(*) FROM shopify_variant_links x WHERE x.company_id = $1 AND x.shopify_product_id = shopify_variant_links.shopify_product_id) = 1
           LIMIT 1`,
          [s.companyId, ch.id],
        );
        if (hubShopProd.rows[0]?.shopify_product_id) {
          await ctx.connectors.shopify.updateProductTitle(hubShopProd.rows[0].shopify_product_id, ch.description).catch((err) => {
            req.log.warn({ err }, 'Could not sync HUB-created Shopify product title');
          });
        }
      }
      if (ch.defaultPriceCents !== undefined || ch.salePriceCents !== undefined || ch.defaultCostCents !== undefined) {
        const beforePricesRaw = (resRow?.before?.Prices as { ItemPrice?: unknown } | undefined)?.ItemPrice;
        const beforePrices = (Array.isArray(beforePricesRaw) ? beforePricesRaw : beforePricesRaw ? [beforePricesRaw] : []) as {
          amount?: string;
          useTypeID?: string;
        }[];
        const parsePosCents = (v: unknown): number | null => {
          if (v === undefined || v === null || v === '') return null;
          const n = Math.round(Number(v) * 100);
          return Number.isFinite(n) && n > 0 ? n : null;
        };
        const prevDefault = parsePosCents(beforePrices.find((p) => String(p.useTypeID) === '1')?.amount);
        const prevSale = parsePosCents(beforePrices.find((p) => String(p.useTypeID) === '3')?.amount);
        const effDefault = ch.defaultPriceCents !== undefined ? (ch.defaultPriceCents > 0 ? ch.defaultPriceCents : null) : prevDefault;
        const effSale = ch.salePriceCents !== undefined ? (ch.salePriceCents && ch.salePriceCents > 0 ? ch.salePriceCents : null) : prevSale;
        const hasSale = effSale !== null && effDefault !== null && effSale < effDefault;
        const nextPrice = hasSale ? effSale : effDefault;
        const nextCompare = hasSale ? effDefault : null;
        const prevAvgCost = parsePosCents(resRow?.before?.avgCost);
        const effCost = prevAvgCost ?? (ch.defaultCostCents !== undefined ? (ch.defaultCostCents && ch.defaultCostCents > 0 ? ch.defaultCostCents : null) : undefined);

        await ctx.pool.query(
          `UPDATE variants
           SET price_cents = COALESCE($1, price_cents),
               compare_at_cents = CASE WHEN $5::boolean THEN $2 ELSE compare_at_cents END,
               cost_cents = CASE WHEN $6::boolean THEN $3 ELSE cost_cents END,
               updated_at = NOW()
           WHERE id = $4 AND company_id = $7`,
          [
            nextPrice,
            nextCompare,
            effCost ?? null,
            ch.id,
            ch.defaultPriceCents !== undefined || ch.salePriceCents !== undefined,
            effCost !== undefined,
            s.companyId,
          ],
        );
        if (ch.defaultPriceCents !== undefined || ch.salePriceCents !== undefined) {
          await ctx.pool.query(
            `INSERT INTO outbound_sync_staging (company_id, variant_id, stream, decision, hold_reasons, shopify_payload, status, updated_at)
             VALUES ($1, $2, 'availability', 'ready_for_shopify', '[]'::jsonb, '{"trigger":"lightspeed_sheet"}'::jsonb, 'pending', now())
             ON CONFLICT (company_id, variant_id, stream) DO UPDATE SET decision = 'ready_for_shopify', hold_reasons = '[]'::jsonb, status = 'pending', last_error = NULL, updated_at = now()`,
            [s.companyId, ch.id],
          );
        }
      }
    }
    if (body.changes.some((c) => c.defaultPriceCents !== undefined || c.salePriceCents !== undefined)) {
      await enqueue(ctx.pool, { companyId: s.companyId, type: 'pipeline.flush_shopify', payload: { trigger: 'lightspeed_sheet' } });
    }

    return { ok: true, updated: results.length, skipped };
  });

  const collectionsGapCache = new Map<string, { at: number; data: unknown }>();
  const GENERAL_HANDLES = new Set(['all', 'in-stock-tampa', 'in-stock-alafia']);

  app.get('/api/reports/collections-gap', { preHandler: requireAuth(ctx, 'catalog.read') }, async (req) => {
    const companyId = req.session!.companyId;
    const refresh = (req.query as { refresh?: string })?.refresh === '1';
    const hit = collectionsGapCache.get(companyId);
    if (!refresh && hit && Date.now() - hit.at < 3 * 60_000) return hit.data;

    const shop = String(ctx.config.env.SHOPIFY_SHOP_DOMAIN ?? '').toLowerCase();
    const raw = await ctx.connectors.shopify.listActiveStockCollectionCoverage();

    const outsideDept: {
      id: string;
      numericId: string;
      adminUrl: string;
      title: string;
      vendor: string;
      productType: string;
      totalInventory: number;
      tags: string[];
      missingTags: string[];
      deptTags: string[];
      collections: { handle: string; title: string }[];
      gapType: 'no_collections' | 'no_department';
      reason: string;
    }[] = [];

    const byType = new Map<string, number>();
    let inDeptCount = 0;
    let outsideAllCount = 0;
    const noPhotoItems: {
      id: string;
      numericId: string;
      adminUrl: string;
      title: string;
      vendor: string;
      productType: string;
      totalInventory: number;
    }[] = [];

    for (const p of raw) {
      const numericId = p.id.split('/').pop() || '';
      const adminUrl = shop ? `https://${shop}/admin/products/${numericId}` : '';
      const pt = (p.productType || '').trim() || '(empty)';
      if (!p.hasPhoto) {
        noPhotoItems.push({
          id: p.id,
          numericId,
          adminUrl,
          title: p.title,
          vendor: p.vendor,
          productType: pt,
          totalInventory: p.totalInventory,
        });
      }
      const deptCols = p.collections.filter((c) => !GENERAL_HANDLES.has(c.handle));
      if (deptCols.length > 0) {
        inDeptCount++;
        continue;
      }
      const gapType = p.collections.length === 0 ? 'no_collections' : 'no_department';
      if (gapType === 'no_collections') outsideAllCount++;
      const deptTags = p.tags.filter((t) => t.startsWith('dept-'));
      const missingTags: string[] = [];
      if (!deptTags.length) missingTags.push('dept-*');
      if (!p.tags.includes('ubc-tampa-stock') && !p.tags.includes('ubc-alafia-stock')) {
        missingTags.push('ubc-tampa-stock / ubc-alafia-stock');
      }
      const vendorSlug = (p.vendor || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (vendorSlug && !p.tags.some((t) => t.startsWith('brand-'))) {
        missingTags.push(`brand-${vendorSlug}`);
      }
      if (!p.tags.some((t) => t.startsWith('price-'))) {
        missingTags.push('price-*');
      }
      byType.set(pt, (byType.get(pt) ?? 0) + 1);
      const reason = gapType === 'no_collections'
        ? 'Not in ANY collection (even general/store)'
        : (deptTags.length ? `Has ${deptTags.join(', ')} but not matched to a dept collection` : `No dept-* tag & productType "${pt}" has no collection rule`);
      outsideDept.push({
        id: p.id,
        numericId,
        adminUrl,
        title: p.title,
        vendor: p.vendor,
        productType: pt,
        totalInventory: p.totalInventory,
        tags: p.tags,
        missingTags,
        deptTags,
        collections: p.collections,
        gapType,
        reason,
      });
    }

    const typeBreakdown = Array.from(byType.entries())
      .map(([productType, count]) => ({ productType, count }))
      .sort((a, b) => b.count - a.count || a.productType.localeCompare(b.productType));

    const data = {
      generatedAt: new Date().toISOString(),
      summary: {
        totalActiveInStock: raw.length,
        inDeptCollections: inDeptCount,
        outsideDeptCollections: outsideDept.length,
        outsideAllCollections: outsideAllCount,
        withoutPhotos: noPhotoItems.length,
      },
      typeBreakdown,
      items: outsideDept,
      noPhotoItems,
    };
    collectionsGapCache.set(companyId, { at: Date.now(), data });
    return data;
  });

  app.get('/api/reports/no-upc', { preHandler: requireAuth(ctx, 'catalog.read') }, async (req) => {
    const companyId = req.session!.companyId;
    const shop = String(ctx.config.env.SHOPIFY_SHOP_DOMAIN ?? '').toLowerCase();
    const [totals, rows] = await Promise.all([
      ctx.pool.query<{ total_in_stock: number; missing_upc: number; total_units: number }>(
        `SELECT count(*)::int AS total_in_stock,
                count(*) FILTER (WHERE c.upc IS NULL OR trim(c.upc) = '')::int AS missing_upc,
                COALESCE(sum(c.physical_qty) FILTER (WHERE c.upc IS NULL OR trim(c.upc) = ''), 0)::int AS total_units
         FROM catalog_items c
         WHERE c.company_id = $1 AND c.physical_qty > 0
           AND EXISTS (
             SELECT 1 FROM shopify_variant_links svl
             WHERE svl.company_id = c.company_id AND svl.variant_id = c.id
               AND ($2 = '' OR svl.shop_domain = $2)
           )`,
        [companyId, shop],
      ),
      ctx.pool.query<{
        id: string; title: string; brand: string; category: string; sku: string; mpn: string | null; price_cents: number; physical_qty: number; shopify_product_id: string | null;
      }>(
        `SELECT c.id, c.title, c.brand, c.category, c.sku, c.mpn, c.price_cents, c.physical_qty,
                (SELECT svl.shopify_product_id FROM shopify_variant_links svl
                 WHERE svl.company_id = c.company_id AND svl.variant_id = c.id
                   AND ($2 = '' OR svl.shop_domain = $2)
                 LIMIT 1) AS shopify_product_id
         FROM catalog_items c
         WHERE c.company_id = $1 AND c.physical_qty > 0
           AND (c.upc IS NULL OR trim(c.upc) = '')
           AND EXISTS (
             SELECT 1 FROM shopify_variant_links svl
             WHERE svl.company_id = c.company_id AND svl.variant_id = c.id
               AND ($2 = '' OR svl.shop_domain = $2)
           )
         ORDER BY c.physical_qty DESC, c.title ASC
         LIMIT 1000`,
        [companyId, shop],
      ),
    ]);
    const t = totals.rows[0] || { total_in_stock: 0, missing_upc: 0, total_units: 0 };
    return {
      generatedAt: new Date().toISOString(),
      summary: {
        totalInStock: t.total_in_stock,
        missingUpc: t.missing_upc,
        totalUnits: t.total_units,
      },
      items: rows.rows.map((r) => {
        const numId = r.shopify_product_id ? r.shopify_product_id.split('/').pop() : '';
        return {
          id: r.id,
          title: r.title,
          brand: r.brand,
          category: r.category,
          sku: r.sku,
          mpn: r.mpn || '',
          priceCents: r.price_cents,
          physicalQty: r.physical_qty,
          adminUrl: shop && numId ? `https://${shop}/admin/products/${numId}` : '',
        };
      }),
    };
  });

  app.get('/api/reports/unlinked-upc', { preHandler: requireAuth(ctx, 'catalog.read') }, async (req) => {
    return getUnlinkedUpcReport(ctx, req.session!.companyId);
  });

  app.post('/api/reports/unlinked-upc/scan', { preHandler: requireAuth(ctx, 'catalog.write') }, async (req) => {
    const companyId = req.session!.companyId;
    await enqueue(ctx.pool, { companyId, type: 'shopify.link_store', payload: { trigger: 'unlinked_upc_report' } });
    return { queued: true };
  });

  app.get('/api/reports/margin-issues', { preHandler: requireAuth(ctx, 'catalog.read') }, async (req) => {
    const companyId = req.session!.companyId;
    const shop = String(ctx.config.env.SHOPIFY_SHOP_DOMAIN ?? '').toLowerCase();
    const [totals, rows] = await Promise.all([
      ctx.pool.query<{ no_cost: number; neg_margin: number; map_violation: number }>(
        `SELECT count(*) FILTER (WHERE c.cost_cents IS NULL OR c.cost_cents <= 0)::int AS no_cost,
                count(*) FILTER (WHERE c.cost_cents > 0 AND c.price_cents < c.cost_cents)::int AS neg_margin,
                count(*) FILTER (
                  WHERE c.map_cents > 0 AND c.price_cents < c.map_cents
                    AND NOT EXISTS (SELECT 1 FROM map_exceptions me WHERE me.company_id = c.company_id AND me.variant_id = c.id AND me.valid_until > now())
                )::int AS map_violation
         FROM catalog_items c
         WHERE c.company_id = $1 AND c.physical_qty > 0`,
        [companyId],
      ),
      ctx.pool.query<{
        id: string; title: string; brand: string; category: string; sku: string;
        price_cents: number; cost_cents: number | null; map_cents: number | null; physical_qty: number;
        shopify_product_id: string | null; has_map_exc: boolean;
      }>(
        `SELECT c.id, c.title, c.brand, c.category, c.sku, c.price_cents, c.cost_cents, c.map_cents, c.physical_qty,
                EXISTS (SELECT 1 FROM map_exceptions me WHERE me.company_id = c.company_id AND me.variant_id = c.id AND me.valid_until > now()) AS has_map_exc,
                (SELECT svl.shopify_product_id FROM shopify_variant_links svl
                 WHERE svl.company_id = c.company_id AND svl.variant_id = c.id
                   AND ($2 = '' OR svl.shop_domain = $2)
                 LIMIT 1) AS shopify_product_id
         FROM catalog_items c
         WHERE c.company_id = $1 AND c.physical_qty > 0
           AND (
             (c.cost_cents > 0 AND c.price_cents < c.cost_cents)
             OR (c.map_cents > 0 AND c.price_cents < c.map_cents AND NOT EXISTS (SELECT 1 FROM map_exceptions me WHERE me.company_id = c.company_id AND me.variant_id = c.id AND me.valid_until > now()))
             OR c.cost_cents IS NULL OR c.cost_cents <= 0
           )
         ORDER BY
           (CASE
             WHEN c.cost_cents > 0 AND c.price_cents < c.cost_cents THEN 0
             WHEN c.map_cents > 0 AND c.price_cents < c.map_cents THEN 1
             ELSE 2
           END),
           c.physical_qty DESC,
           c.title ASC
         LIMIT 1200`,
        [companyId, shop],
      ),
    ]);
    const t = totals.rows[0] || { no_cost: 0, neg_margin: 0, map_violation: 0 };
    return {
      generatedAt: new Date().toISOString(),
      summary: {
        totalIssues: t.no_cost + t.neg_margin + t.map_violation,
        noCostCount: t.no_cost,
        negativeMarginCount: t.neg_margin,
        mapViolationCount: t.map_violation,
      },
      items: rows.rows.map((r) => {
        const hasCost = r.cost_cents !== null && r.cost_cents > 0;
        const isNeg = hasCost && r.price_cents < r.cost_cents!;
        const isMap = !isNeg && !r.has_map_exc && r.map_cents !== null && r.map_cents > 0 && r.price_cents < r.map_cents;
        const marginPct = hasCost && r.price_cents > 0 ? (r.price_cents - r.cost_cents!) / r.price_cents : null;
        const numId = r.shopify_product_id ? r.shopify_product_id.split('/').pop() : '';
        return {
          id: r.id,
          title: r.title,
          brand: r.brand,
          category: r.category,
          sku: r.sku,
          priceCents: r.price_cents,
          costCents: r.cost_cents,
          mapCents: r.map_cents,
          marginPct,
          physicalQty: r.physical_qty,
          shopifyLinked: Boolean(r.shopify_product_id),
          issue: isNeg ? 'negative_margin' : isMap ? 'map_violation' : 'no_cost',
          adminUrl: shop && numId ? `https://${shop}/admin/products/${numId}` : '',
        };
      }),
    };
  });

  app.get('/api/reports/sales-profitability', { preHandler: requireAuth(ctx, 'catalog.read') }, async (req) => {
    const companyId = req.session!.companyId;
    const rawDays = String((req.query as Record<string, unknown>).days || '30');
    const days = rawDays === 'all' ? 0 : Math.max(1, Math.min(3650, Number(rawDays) || 30));

    const [summaryRes, topSkusRes, campaignsRes] = await Promise.all([
      ctx.pool.query<{
        order_count: number;
        special_orders: number;
        units_sold: number;
        revenue_cents: number;
        known_cost_cents: number;
        known_cost_revenue_cents: number;
        lines_with_cost: number;
        total_lines: number;
      }>(
        `SELECT
           count(DISTINCT o.id)::int AS order_count,
           count(DISTINCT o.id) FILTER (WHERE o.is_special_order)::int AS special_orders,
           COALESCE(sum(ol.qty), 0)::int AS units_sold,
           COALESCE(sum(ol.price_cents::bigint * ol.qty), 0)::bigint AS revenue_cents,
           COALESCE(sum(CASE WHEN COALESCE(ol.quoted_cost_cents, v.cost_cents) > 0 THEN COALESCE(ol.quoted_cost_cents, v.cost_cents)::bigint * ol.qty ELSE 0 END), 0)::bigint AS known_cost_cents,
           COALESCE(sum(CASE WHEN COALESCE(ol.quoted_cost_cents, v.cost_cents) > 0 THEN ol.price_cents::bigint * ol.qty ELSE 0 END), 0)::bigint AS known_cost_revenue_cents,
           count(ol.id) FILTER (WHERE COALESCE(ol.quoted_cost_cents, v.cost_cents) > 0)::int AS lines_with_cost,
           count(ol.id)::int AS total_lines
         FROM orders o
         JOIN order_lines ol ON ol.order_id = o.id
         LEFT JOIN variants v ON v.id = ol.variant_id
         WHERE o.company_id = $1
           AND o.internal_status <> 'cancelled'
           AND ($2 = 0 OR o.created_at >= now() - make_interval(days => $2))`,
        [companyId, days],
      ),
      ctx.pool.query<{
        sku: string;
        title: string;
        variant_id: string | null;
        units_sold: number;
        revenue_cents: number;
        cost_cents: number;
        known_cost_revenue_cents: number;
        orders_count: number;
      }>(
        `SELECT
           ol.sku,
           max(ol.title) AS title,
           ol.variant_id::text AS variant_id,
           sum(ol.qty)::int AS units_sold,
           sum(ol.price_cents::bigint * ol.qty)::bigint AS revenue_cents,
           sum(CASE WHEN COALESCE(ol.quoted_cost_cents, v.cost_cents) > 0 THEN COALESCE(ol.quoted_cost_cents, v.cost_cents)::bigint * ol.qty ELSE 0 END)::bigint AS cost_cents,
           sum(CASE WHEN COALESCE(ol.quoted_cost_cents, v.cost_cents) > 0 THEN ol.price_cents::bigint * ol.qty ELSE 0 END)::bigint AS known_cost_revenue_cents,
           count(DISTINCT o.id)::int AS orders_count
         FROM orders o
         JOIN order_lines ol ON ol.order_id = o.id
         LEFT JOIN variants v ON v.id = ol.variant_id
         WHERE o.company_id = $1
           AND o.internal_status <> 'cancelled'
           AND ($2 = 0 OR o.created_at >= now() - make_interval(days => $2))
         GROUP BY ol.sku, ol.variant_id
         ORDER BY revenue_cents DESC, units_sold DESC
         LIMIT 50`,
        [companyId, days],
      ),
      ctx.pool.query<{
        id: string;
        name: string;
        channel: string;
        status: string;
        starts_at: Date | null;
        ends_at: Date | null;
        orders_count: number;
        units_sold: number;
        revenue_cents: number;
        cost_cents: number;
        known_cost_revenue_cents: number;
      }>(
        `SELECT
           c.id,
           c.name,
           c.channel,
           c.status,
           COALESCE(c.starts_at, c.approved_at, c.created_at) AS starts_at,
           c.ends_at,
           count(DISTINCT o.id)::int AS orders_count,
           COALESCE(sum(ol.qty), 0)::int AS units_sold,
           COALESCE(sum(ol.price_cents::bigint * ol.qty), 0)::bigint AS revenue_cents,
           COALESCE(sum(CASE WHEN COALESCE(ol.quoted_cost_cents, v.cost_cents) > 0 THEN COALESCE(ol.quoted_cost_cents, v.cost_cents)::bigint * ol.qty ELSE 0 END), 0)::bigint AS cost_cents,
           COALESCE(sum(CASE WHEN COALESCE(ol.quoted_cost_cents, v.cost_cents) > 0 THEN ol.price_cents::bigint * ol.qty ELSE 0 END), 0)::bigint AS known_cost_revenue_cents
         FROM campaigns c
         LEFT JOIN campaign_lines cl ON cl.campaign_id = c.id AND cl.status IN ('ok','warning')
         LEFT JOIN order_lines ol ON ol.variant_id = cl.variant_id
         LEFT JOIN orders o ON o.id = ol.order_id
           AND o.company_id = c.company_id
           AND o.internal_status <> 'cancelled'
           AND o.created_at >= COALESCE(c.starts_at, c.approved_at, c.created_at)
           AND (c.ends_at IS NULL OR o.created_at <= c.ends_at)
           AND ($2 = 0 OR o.created_at >= now() - make_interval(days => $2))
         LEFT JOIN variants v ON v.id = ol.variant_id
         WHERE c.company_id = $1
           AND c.status IN ('active','restored','applying','restoring')
         GROUP BY c.id
         ORDER BY c.created_at DESC
         LIMIT 25`,
        [companyId, days],
      ),
    ]);

    const s = summaryRes.rows[0] || {
      order_count: 0, special_orders: 0, units_sold: 0, revenue_cents: 0,
      known_cost_cents: 0, known_cost_revenue_cents: 0, lines_with_cost: 0, total_lines: 0,
    };
    const rev = Number(s.revenue_cents || 0);
    const knownCost = Number(s.known_cost_cents || 0);
    const knownRev = Number(s.known_cost_revenue_cents || 0);
    const grossProfitCents = knownRev - knownCost;
    const marginPct = knownRev > 0 ? grossProfitCents / knownRev : null;

    return {
      generatedAt: new Date().toISOString(),
      days,
      summary: {
        orderCount: Number(s.order_count || 0),
        specialOrdersCount: Number(s.special_orders || 0),
        inStockOrdersCount: Math.max(0, Number(s.order_count || 0) - Number(s.special_orders || 0)),
        unitsSold: Number(s.units_sold || 0),
        revenueCents: rev,
        knownCostCents: knownCost,
        grossProfitCents,
        marginPct,
        linesWithCost: Number(s.lines_with_cost || 0),
        totalLines: Number(s.total_lines || 0),
      },
      campaigns: campaignsRes.rows.map((r) => {
        const cRev = Number(r.revenue_cents || 0);
        const cCost = Number(r.cost_cents || 0);
        const cKnownRev = Number(r.known_cost_revenue_cents || 0);
        const cProfit = cKnownRev - cCost;
        return {
          id: r.id,
          name: r.name,
          channel: r.channel,
          status: r.status,
          startsAt: r.starts_at,
          endsAt: r.ends_at,
          ordersCount: Number(r.orders_count || 0),
          unitsSold: Number(r.units_sold || 0),
          revenueCents: cRev,
          costCents: cCost,
          grossProfitCents: cProfit,
          marginPct: cKnownRev > 0 ? cProfit / cKnownRev : null,
        };
      }),
      topSkus: topSkusRes.rows.map((r) => {
        const sRev = Number(r.revenue_cents || 0);
        const sCost = Number(r.cost_cents || 0);
        const sKnownRev = Number(r.known_cost_revenue_cents || 0);
        const sProfit = sKnownRev - sCost;
        return {
          sku: r.sku,
          title: r.title,
          variantId: r.variant_id,
          ordersCount: Number(r.orders_count || 0),
          unitsSold: Number(r.units_sold || 0),
          revenueCents: sRev,
          costCents: sCost,
          grossProfitCents: sProfit,
          marginPct: sKnownRev > 0 ? sProfit / sKnownRev : null,
        };
      }),
    };
  });

  // Lightspeed-style Aging / Dead Stock report: in-stock variants with longest days since last recorded sale.
  app.get('/api/reports/days-without-sales', { preHandler: requireAuth(ctx, 'catalog.read') }, async (req) => {
    const companyId = req.session!.companyId;
    const rawMin = (req.query as Record<string, unknown>).minDays;
    const minDays = rawMin === undefined || rawMin === '' ? 0 : Math.max(0, Math.min(3650, Number(rawMin) || 0));

    const r = await ctx.pool.query<{
      variant_id: string;
      sku: string;
      upc: string | null;
      title: string;
      brand: string;
      category: string;
      on_hand: number;
      cost_cents: number;
      price_cents: number;
      last_sold_at: Date | null;
      days_without_sale: number | null;
    }>(
      `WITH inv AS (
         SELECT variant_id, sum(on_hand)::int AS on_hand
         FROM inventory_levels
         WHERE company_id = $1 AND on_hand > 0
         GROUP BY variant_id
       ),
       hub_sale AS (
         SELECT ol.variant_id, max(o.created_at) AS last_sold_at
         FROM order_lines ol
         JOIN orders o ON o.id = ol.order_id
         WHERE o.company_id = $1 AND o.internal_status <> 'cancelled' AND ol.variant_id IS NOT NULL
         GROUP BY ol.variant_id
       ),
       eff AS (
         SELECT v.id AS variant_id,
           CASE
             WHEN v.last_sold_at IS NULL THEN hs.last_sold_at
             WHEN hs.last_sold_at IS NULL THEN v.last_sold_at
             ELSE GREATEST(v.last_sold_at, hs.last_sold_at)
           END AS last_sold_at
         FROM variants v
         LEFT JOIN hub_sale hs ON hs.variant_id = v.id
         WHERE v.company_id = $1
       )
       SELECT
         v.id::text AS variant_id,
         v.sku,
         v.upc,
         COALESCE(NULLIF(v.title, ''), p.title) AS title,
         COALESCE(p.brand, '') AS brand,
         COALESCE(p.category, '') AS category,
         inv.on_hand,
         COALESCE(v.cost_cents, 0)::int AS cost_cents,
         COALESCE(v.price_cents, 0)::int AS price_cents,
         eff.last_sold_at,
         GREATEST(0, EXTRACT(DAY FROM (now() - COALESCE(eff.last_sold_at, v.received_at, v.created_at)))::int) AS days_without_sale
       FROM inv
       JOIN variants v ON v.id = inv.variant_id AND v.company_id = $1
       JOIN products p ON p.id = v.product_id AND p.company_id = $1
       LEFT JOIN eff ON eff.variant_id = v.id
       WHERE $2 = 0
          OR COALESCE(eff.last_sold_at, v.received_at, v.created_at) <= now() - make_interval(days => $2)
       ORDER BY days_without_sale DESC, (inv.on_hand::bigint * COALESCE(v.cost_cents, 0)) DESC, inv.on_hand DESC
       LIMIT 500`,
      [companyId, minDays],
    );

    let totalUnits = 0;
    let totalCostCents = 0;
    let totalRetailCents = 0;
    let neverSoldCount = 0;
    const rows = r.rows.map((x) => {
      totalUnits += x.on_hand;
      const stockCost = x.on_hand * x.cost_cents;
      const stockRetail = x.on_hand * x.price_cents;
      totalCostCents += stockCost;
      totalRetailCents += stockRetail;
      if (x.last_sold_at === null) neverSoldCount += 1;
      return {
        variantId: x.variant_id,
        sku: x.sku,
        upc: x.upc || '',
        title: x.title,
        brand: x.brand,
        category: x.category,
        onHand: x.on_hand,
        costCents: x.cost_cents,
        priceCents: x.price_cents,
        stockCostCents: stockCost,
        stockRetailCents: stockRetail,
        lastSoldAt: x.last_sold_at,
        neverSold: x.last_sold_at === null,
        daysWithoutSale: x.days_without_sale,
      };
    });

    return {
      generatedAt: new Date().toISOString(),
      minDays,
      summary: {
        totalSkus: rows.length,
        totalUnits,
        totalCostCents,
        totalRetailCents,
        neverSoldCount,
      },
      rows,
    };
  });

  app.post('/api/reports/days-without-sales/sync', { preHandler: requireAuth(ctx, 'catalog.read') }, async (req) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    const full = q.full !== 'false';
    const lookbackDays = q.lookbackDays ? Number(q.lookbackDays) : undefined;
    return syncLightspeedLastSalesJob(ctx, req.session!.companyId, { full, lookbackDays });
  });

  const facetsCache = new Map<string, { exp: number; data: unknown }>();
  app.get('/api/items/facets', { preHandler: requireAuth(ctx, 'catalog.read') }, async (req) => {
    const c = req.session!.companyId;
    const shop = String(ctx.config.env.SHOPIFY_SHOP_DOMAIN ?? '').toLowerCase();
    const cacheKey = `${c}:${shop}`;
    const hit = facetsCache.get(cacheKey);
    if (hit && hit.exp > Date.now()) return hit.data;
    const [cats, brands, shopifyBrands, sups] = await Promise.all([
      ctx.pool.query(`SELECT category AS value, count(*)::int n FROM catalog_items WHERE company_id = $1 AND trim(category) <> '' GROUP BY 1 ORDER BY n DESC, 1`, [c]),
      ctx.pool.query(`SELECT brand AS value, count(*)::int n FROM catalog_items WHERE company_id = $1 AND trim(brand) <> '' GROUP BY 1 ORDER BY n DESC, 1`, [c]),
      shop
        ? ctx.pool.query(
          `SELECT ci.brand AS value, count(*)::int n
           FROM catalog_items ci
           WHERE ci.company_id = $1 AND trim(ci.brand) <> ''
             AND EXISTS (
               SELECT 1 FROM shopify_variant_links l
               WHERE l.company_id = ci.company_id AND l.shop_domain = $2 AND l.variant_id = ci.id
             )
           GROUP BY 1 ORDER BY n DESC, 1`,
          [c, shop],
        )
        : Promise.resolve({ rows: [] }),
      ctx.pool.query(`SELECT code AS value, name FROM suppliers WHERE company_id = $1 AND is_active ORDER BY code`, [c]),
    ]);
    const data = { categories: cats.rows, brands: brands.rows, shopifyBrands: shopifyBrands.rows, suppliers: sups.rows };
    facetsCache.set(cacheKey, { exp: Date.now() + 120_000, data });
    return data;
  });

  app.get('/api/items/:id', { preHandler: requireAuth(ctx, 'catalog.read') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const c = req.session!.companyId;
    const item = await getItem(ctx.pool, c, id);
    if (!item) throw notFound('Item');
    const { availability } = await getSettings(ctx.pool, c);
    const shop = String(ctx.config.env.SHOPIFY_SHOP_DOMAIN ?? '').toLowerCase();
    const [history, ext, locs, shopLinks] = await Promise.all([
      ctx.pool.query(`SELECT old_price_cents, new_price_cents, source, campaign_id, created_at FROM price_history WHERE variant_id = $1 ORDER BY created_at DESC LIMIT 50`, [id]),
      ctx.pool.query<{ system: string; external_id: string }>(`SELECT system, external_id FROM external_ids WHERE entity_id = $1`, [id]),
      ctx.pool.query(
        `SELECT l.name, coalesce(il.on_hand, 0)::int AS on_hand, coalesce(il.reserved, 0)::int AS reserved
         FROM locations l
         LEFT JOIN inventory_levels il ON il.location_id = l.id AND il.variant_id = $1
         WHERE l.company_id = $2 AND l.kind = 'physical'
         ORDER BY (l.shopify_location_id IS NULL), l.name`,
        [id, c],
      ),
      ctx.pool.query<{ shopify_product_id: string; shopify_variant_id: string; match_method: string }>(
        `SELECT shopify_product_id, shopify_variant_id, match_method FROM shopify_variant_links
         WHERE company_id = $1 AND variant_id = $2 AND ($3 = '' OR shop_domain = $3)`,
        [c, id, shop],
      ),
    ]);
    const externalIds = [...ext.rows];
    if (shopLinks.rows[0] && !externalIds.some((e) => e.system === 'shopify')) {
      externalIds.push({ system: 'shopify', external_id: shopLinks.rows[0].shopify_variant_id });
    }
    const enrichedItem = shopLinks.rows[0] && !item.shopifyVariantId
      ? { ...item, shopifyVariantId: shopLinks.rows[0].shopify_variant_id }
      : item;
    const firstShopProd = shopLinks.rows[0]?.shopify_product_id;
    const numericProdId = firstShopProd ? firstShopProd.split('/').pop() : '';
    const shopifyAdminUrl = shop && numericProdId ? `https://${shop}/admin/products/${numericProdId}` : null;
    return {
      item: enrichedItem,
      availability: computeAvailability(enrichedItem, availability),
      priceHistory: history.rows,
      externalIds,
      shopifyAdminUrl,
      locationLevels: locs.rows,
    };
  });

  /** Manual price change: same commercial rules as campaigns, optimistic locking on version. */
  app.patch('/api/items/:id/price', { preHandler: requireAuth(ctx, 'pricing.write') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ priceCents: z.number().int().positive(), version: z.number().int() }).parse(req.body);
    const s = req.session!;
    const item = await getItem(ctx.pool, s.companyId, id);
    if (!item) throw notFound('Item');
    if (item.version !== body.version) throw conflict('VERSION_CONFLICT', 'This item was changed by someone else. Reload and try again.', { current: item });
    const { campaignRules } = await getSettings(ctx.pool, s.companyId);
    const line = evaluateLine(item, { type: 'set_price', value: body.priceCents, rounding: 'none' }, { rules: { ...campaignRules, clampToMinMargin: false, excludeWithoutCost: false } });
    if (line.status === 'blocked') throw new HttpError(422, 'RULE_VIOLATION', 'Price breaks a commercial rule', { reasons: line.reasons });
    await withTransaction(ctx.pool, async (c) => {
      const r = await c.query(`UPDATE variants SET price_cents = $3, version = version + 1, updated_at = now() WHERE company_id = $1 AND id = $2 AND version = $4`, [s.companyId, id, body.priceCents, body.version]);
      if (!r.rowCount) throw conflict('VERSION_CONFLICT', 'Concurrent update');
      await c.query(`INSERT INTO price_history (company_id, variant_id, old_price_cents, new_price_cents, source, actor_user_id) VALUES ($1,$2,$3,$4,'manual',$5)`, [s.companyId, id, item.priceCents, body.priceCents, s.userId]);
      await audit(c, { companyId: s.companyId, userId: s.userId, action: 'item.price_changed', entityType: 'variant', entityId: id, detail: { from: item.priceCents, to: body.priceCents, reasons: line.reasons } });
      if (ctx.config.env.SHOPIFY_SYNC_MODE === 'update_only') {
        // Send it to the store right away (seconds), through the same UPC-linked path as Lightspeed changes.
        await c.query(
          `INSERT INTO outbound_sync_staging (company_id, variant_id, stream, decision, hold_reasons, shopify_payload, status, updated_at)
           VALUES ($1, $2, 'availability', 'ready_for_shopify', '[]'::jsonb, '{"trigger":"manual_price"}'::jsonb, 'pending', now())
           ON CONFLICT (company_id, variant_id, stream) DO UPDATE SET decision = 'ready_for_shopify', hold_reasons = '[]'::jsonb, status = 'pending', last_error = NULL, updated_at = now()`,
          [s.companyId, id],
        );
      }
    });
    if (ctx.config.env.SHOPIFY_SYNC_MODE === 'update_only') {
      await enqueue(ctx.pool, { companyId: s.companyId, type: 'pipeline.flush_shopify', payload: { trigger: 'manual_price' } });
    }
    return { ok: true, warnings: line.reasons };
  });

  /** Bulk publish/hide runs as a job so thousands of products never block a request. */
  app.post('/api/items/bulk-status', { preHandler: requireAuth(ctx, 'catalog.write') }, async (req, reply) => {
    const body = z.object({ filter: itemFilterSchema, status: z.enum(['published', 'hidden']) }).parse(req.body);
    const s = req.session!;
    const job = await enqueue(ctx.pool, { companyId: s.companyId, type: 'items.bulk_status', payload: body, createdBy: s.userId });
    await audit(ctx.pool, { companyId: s.companyId, userId: s.userId, action: 'items.bulk_status_requested', detail: body });
    reply.code(202);
    return { jobId: job.id };
  });

  app.get('/api/inventory/locations', { preHandler: requireAuth(ctx, 'catalog.read') }, async (req) => {
    const r = await ctx.pool.query(
      `SELECT l.id, l.name, l.kind, count(il.variant_id)::int skus, coalesce(sum(il.on_hand),0)::int on_hand, coalesce(sum(il.reserved),0)::int reserved
       FROM locations l LEFT JOIN inventory_levels il ON il.location_id = l.id WHERE l.company_id = $1 GROUP BY l.id ORDER BY l.name`, [req.session!.companyId]);
    return { locations: r.rows };
  });

  // ---------- Ops: jobs, errors, audit, settings ----------
  app.get('/api/jobs', { preHandler: requireAuth(ctx, 'catalog.read') }, async (req) => {
    const q = z.object({ status: z.string().optional(), limit: z.coerce.number().int().max(200).default(50) }).parse(req.query);
    const r = await ctx.pool.query(
      `SELECT id, type, status, attempts, max_attempts, progress, result, last_error, created_at, finished_at, run_at FROM jobs
       WHERE company_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY id DESC LIMIT $3`, [req.session!.companyId, q.status ?? null, q.limit]);
    return { jobs: r.rows };
  });

  app.get('/api/jobs/:id', { preHandler: requireAuth(ctx, 'catalog.read') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const r = await ctx.pool.query(`SELECT id, type, status, attempts, progress, result, last_error, created_at, finished_at FROM jobs WHERE company_id = $1 AND id = $2`, [req.session!.companyId, id]);
    if (!r.rows[0]) throw notFound('Job');
    return r.rows[0];
  });

  app.post('/api/jobs/:id/retry', { preHandler: requireAuth(ctx, 'integrations.manage') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const s = req.session!;
    const r = await ctx.pool.query(`UPDATE jobs SET status = 'queued', attempts = 0, run_at = now(), last_error = NULL WHERE company_id = $1 AND id = $2 AND status = 'dead' RETURNING id`, [s.companyId, id]);
    if (!r.rowCount) throw conflict('NOT_DEAD', 'Only dead jobs can be retried');
    await audit(ctx.pool, { companyId: s.companyId, userId: s.userId, action: 'job.retried', entityType: 'job', entityId: String(id) });
    return { ok: true };
  });

  app.get('/api/errors', { preHandler: requireAuth(ctx, 'audit.read') }, async (req) => {
    const r = await ctx.pool.query(`SELECT id, source, message, context, job_id, resolved_at, created_at FROM error_log WHERE company_id = $1 ORDER BY id DESC LIMIT 200`, [req.session!.companyId]);
    return { errors: r.rows };
  });

  app.post('/api/errors/:id/resolve', { preHandler: requireAuth(ctx, 'audit.read') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const s = req.session!;
    await ctx.pool.query(`UPDATE error_log SET resolved_at = now() WHERE company_id = $1 AND id = $2`, [s.companyId, id]);
    await audit(ctx.pool, { companyId: s.companyId, userId: s.userId, action: 'error.resolved', entityType: 'error', entityId: String(id) });
    return { ok: true };
  });

  app.get('/api/audit', { preHandler: requireAuth(ctx, 'audit.read') }, async (req) => {
    const r = await ctx.pool.query(
      `SELECT a.id, a.action, a.entity_type, a.entity_id, a.detail, a.created_at, u.name AS actor FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
       WHERE a.company_id = $1 ORDER BY a.id DESC LIMIT 200`, [req.session!.companyId]);
    return { entries: r.rows };
  });

  // ---------- LED Sign Studio: saved templates ----------
  const ledSlideSchema = z.object({
    layout: z.enum(['slam', 'swap', 'rating', 'price', 'ticker', 'brand']),
    line1: z.string().max(60).default(''),
    line2: z.string().max(120).default(''),
    foot: z.string().max(80).default(''),
    palette: z.string().max(30),
    seconds: z.number().int().min(2).max(10),
    // visual style (validated loosely: unknown values fall back to defaults when drawn)
    bg: z.string().max(20).optional(),
    enter: z.string().max(20).optional(),
    motion: z.string().max(20).optional(),
    deco: z.string().max(20).optional(),
    trans: z.string().max(20).optional(),
    color: z.string().max(30).optional(),
    icon: z.string().max(20).optional(),
    iconSide: z.enum(['left', 'right']).optional(),
    size: z.number().int().min(60).max(140).optional(),
  });
  const ledSettingsSchema = z.object({
    padL: z.number().int().min(0).max(30).default(0),
    padR: z.number().int().min(0).max(30).default(0),
    padT: z.number().int().min(0).max(30).default(0),
    padB: z.number().int().min(0).max(30).default(0),
  }).default({ padL: 0, padR: 0, padT: 0, padB: 0 });
  const ledTemplateSchema = z.object({ name: z.string().trim().min(1).max(60), slides: z.array(ledSlideSchema).min(1).max(6), settings: ledSettingsSchema });
  const ledRow = (r: { id: string; name: string; slides: unknown; settings?: unknown; updated_at: Date; author: string | null }) =>
    ({ id: String(r.id), name: r.name, slides: r.slides, settings: r.settings ?? {}, updatedAt: r.updated_at, author: r.author });

  const listLedTemplates = async (q: { query: typeof ctx.pool.query }, companyId: string) => {
    const r = await q.query(
      `SELECT t.id, t.name, t.slides, t.settings, t.updated_at, u.name AS author FROM led_templates t LEFT JOIN users u ON u.id = t.created_by
       WHERE t.company_id = $1 ORDER BY t.sort_order, t.created_at, t.id LIMIT 200`, [companyId]);
    const seeded = await q.query(`SELECT version FROM led_template_seeds WHERE company_id = $1`, [companyId]);
    return { templates: r.rows.map(ledRow), seeded: (seeded.rowCount ?? 0) > 0, seededVersion: seeded.rows[0]?.version ?? 0 };
  };

  app.get('/api/led-templates', { preHandler: requireAuth(ctx, 'catalog.read') }, async (req) =>
    listLedTemplates(ctx.pool, req.session!.companyId));

  // Copies UBC's default templates into the company's list. First time: once (seeded flag).
  // restore=true: re-adds any default whose name is missing (after someone deleted it).
  app.post('/api/led-templates/seed', { preHandler: requireAuth(ctx, 'catalog.write') }, async (req) => {
    const body = z.object({
      restore: z.boolean().default(false),
      version: z.number().int().min(1).max(1000).default(1),
      templates: z.array(ledTemplateSchema.extend({ since: z.number().int().min(1).max(1000).default(1) })).min(1).max(30),
    }).parse(req.body);
    const s = req.session!;
    let added = 0;
    let refreshed = 0;
    await withTransaction(ctx.pool, async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('led_templates:' || $1::text))`, [s.companyId]);
      const seeded = await c.query(`SELECT version FROM led_template_seeds WHERE company_id = $1`, [s.companyId]);
      if (seeded.rowCount && !body.restore) {
        if ((seeded.rows[0].version ?? 1) >= body.version) return;
        const stored = seeded.rows[0].version ?? 1;
        // templates introduced after the stored version are new: add them (deleted older ones stay deleted)
        const existing = await c.query(`SELECT lower(name) AS n FROM led_templates WHERE company_id = $1`, [s.companyId]);
        const have = new Set(existing.rows.map((r: { n: string }) => r.n));
        for (const [i, t] of body.templates.entries()) {
          if (t.since <= stored || have.has(t.name.toLowerCase())) continue;
          await c.query(`INSERT INTO led_templates (company_id, name, slides, created_by, sort_order) VALUES ($1, $2, $3, $4, $5)`,
            [s.companyId, t.name, JSON.stringify(t.slides), s.userId, i]);
          added++;
        }
        // newer UBC design: refresh only the defaults nobody has edited
        for (const t of body.templates) {
          const u = await c.query(
            `UPDATE led_templates SET slides = $3, created_at = now(), updated_at = now()
             WHERE company_id = $1 AND lower(name) = lower($2) AND created_at = updated_at`,
            [s.companyId, t.name, JSON.stringify(t.slides)]);
          refreshed += u.rowCount ?? 0;
        }
        await c.query(`UPDATE led_template_seeds SET version = $2 WHERE company_id = $1`, [s.companyId, body.version]);
        if (refreshed || added) await audit(c, { companyId: s.companyId, userId: s.userId, action: 'led_template.refreshed', detail: { refreshed, added, version: body.version } });
        return;
      }
      const existing = await c.query(`SELECT lower(name) AS n FROM led_templates WHERE company_id = $1`, [s.companyId]);
      const have = new Set(existing.rows.map((r: { n: string }) => r.n));
      for (const [i, t] of body.templates.entries()) {
        if (have.has(t.name.toLowerCase())) continue;
        await c.query(`INSERT INTO led_templates (company_id, name, slides, created_by, sort_order) VALUES ($1, $2, $3, $4, $5)`,
          [s.companyId, t.name, JSON.stringify(t.slides), s.userId, i]);
        added++;
      }
      await c.query(`INSERT INTO led_template_seeds (company_id, version) VALUES ($1, $2) ON CONFLICT (company_id) DO NOTHING`, [s.companyId, body.version]);
      if (added) await audit(c, { companyId: s.companyId, userId: s.userId, action: body.restore ? 'led_template.restored' : 'led_template.seeded', detail: { added } });
    });
    return { ...(await listLedTemplates(ctx.pool, s.companyId)), added, refreshed };
  });

  app.post('/api/led-templates', { preHandler: requireAuth(ctx, 'catalog.write') }, async (req) => {
    const body = ledTemplateSchema.parse(req.body);
    const s = req.session!;
    const r = await ctx.pool.query(
      `INSERT INTO led_templates (company_id, name, slides, settings, created_by) VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, slides, settings, updated_at, NULL::text AS author`,
      [s.companyId, body.name, JSON.stringify(body.slides), JSON.stringify(body.settings), s.userId]);
    await audit(ctx.pool, { companyId: s.companyId, userId: s.userId, action: 'led_template.created', detail: { name: body.name } });
    return ledRow(r.rows[0]);
  });

  app.put('/api/led-templates/:id', { preHandler: requireAuth(ctx, 'catalog.write') }, async (req) => {
    const id = z.coerce.number().int().positive().parse((req.params as { id: string }).id);
    const body = ledTemplateSchema.parse(req.body);
    const s = req.session!;
    const r = await ctx.pool.query(
      `UPDATE led_templates SET name = $3, slides = $4, settings = $5, updated_at = now() WHERE id = $1 AND company_id = $2
       RETURNING id, name, slides, settings, updated_at, NULL::text AS author`,
      [id, s.companyId, body.name, JSON.stringify(body.slides), JSON.stringify(body.settings)]);
    if (!r.rowCount) throw notFound('LED template');
    await audit(ctx.pool, { companyId: s.companyId, userId: s.userId, action: 'led_template.updated', detail: { id, name: body.name } });
    return ledRow(r.rows[0]);
  });

  // Copy the sign-fit margins to all templates or to the chosen ones (slides are untouched,
  // and updated_at is kept so UBC default templates still receive design refreshes).
  app.post('/api/led-templates/apply-settings', { preHandler: requireAuth(ctx, 'catalog.write') }, async (req) => {
    const body = z.object({
      all: z.boolean().default(false),
      ids: z.array(z.coerce.number().int().positive()).max(200).default([]),
      settings: ledSettingsSchema,
    }).parse(req.body);
    if (!body.all && !body.ids.length) throw new HttpError(400, 'NO_TEMPLATES', 'Choose at least one template');
    const s = req.session!;
    const r = body.all
      ? await ctx.pool.query(`UPDATE led_templates SET settings = $2 WHERE company_id = $1`, [s.companyId, JSON.stringify(body.settings)])
      : await ctx.pool.query(`UPDATE led_templates SET settings = $2 WHERE company_id = $1 AND id = ANY($3::bigint[])`,
        [s.companyId, JSON.stringify(body.settings), body.ids]);
    await audit(ctx.pool, { companyId: s.companyId, userId: s.userId, action: 'led_template.settings_applied', detail: { all: body.all, ids: body.ids, settings: body.settings, updated: r.rowCount } });
    return { updated: r.rowCount ?? 0 };
  });

  app.delete('/api/led-templates/:id', { preHandler: requireAuth(ctx, 'catalog.write') }, async (req) => {
    const id = z.coerce.number().int().positive().parse((req.params as { id: string }).id);
    const s = req.session!;
    const r = await ctx.pool.query(`DELETE FROM led_templates WHERE id = $1 AND company_id = $2 RETURNING name`, [id, s.companyId]);
    if (!r.rowCount) throw notFound('LED template');
    await audit(ctx.pool, { companyId: s.companyId, userId: s.userId, action: 'led_template.deleted', detail: { id, name: r.rows[0].name } });
    return { ok: true };
  });

  app.get('/api/settings', { preHandler: requireAuth(ctx, 'catalog.read') }, async (req) => getSettings(ctx.pool, req.session!.companyId));

  app.put('/api/settings', { preHandler: requireAuth(ctx, 'settings.manage') }, async (req) => {
    const body = z.object({
      campaignRules: rulesSchema.required({ minMarginPct: true, warnMarginPct: true, clampToMinMargin: true }),
      availability: z.object({
        physicalSafetyQty: z.number().int().min(0).max(100), supplierSafetyQty: z.number().int().min(0).max(100),
        maxOfferAgeHours: z.number().int().min(1).max(720), handlingDays: z.number().int().min(0).max(60),
        showUpcMatches: z.boolean().optional(),
      }),
    }).parse(req.body);
    const s = req.session!;
    const before = await getSettings(ctx.pool, s.companyId);
    const nextAvailability = { ...before.availability, ...body.availability };
    const nextCampaignRules = { ...before.campaignRules, ...body.campaignRules, excludeWithoutCost: before.campaignRules.excludeWithoutCost ?? true };
    await ctx.pool.query(`UPDATE company_settings SET campaign_rules = $2, availability_rules = $3, updated_at = now() WHERE company_id = $1`,
      [s.companyId, JSON.stringify(nextCampaignRules), JSON.stringify(nextAvailability)]);
    await audit(ctx.pool, { companyId: s.companyId, userId: s.userId, action: 'settings.updated', detail: { before, after: body } });
    return getSettings(ctx.pool, s.companyId);
  });

  // ---------- Google Reviews & Shopify Theme Publish ----------
  app.get('/api/reviews', { preHandler: requireAuth(ctx, 'catalog.read') }, async (req) =>
    getReviewsState(ctx.pool, req.session!.companyId));

  app.put('/api/reviews/sources', { preHandler: requireAuth(ctx, 'catalog.write') }, async (req) => {
    const body = reviewSourcesUpdateSchema.parse(req.body);
    return updateReviewSources(ctx, req.session!.companyId, req.session!.userId, body);
  });

  app.post('/api/reviews/sync', { preHandler: requireAuth(ctx, 'catalog.write') }, async (req) =>
    syncGoogleReviews(ctx, req.session!.companyId, req.session!.userId));

  app.post('/api/reviews/manual', { preHandler: requireAuth(ctx, 'catalog.write') }, async (req) => {
    const body = manualReviewSchema.parse(req.body);
    return addManualReview(ctx, req.session!.companyId, req.session!.userId, body);
  });

  app.patch('/api/reviews/:id', { preHandler: requireAuth(ctx, 'catalog.write') }, async (req) => {
    const id = z.string().uuid().parse((req.params as { id: string }).id);
    const body = toggleReviewSchema.parse(req.body);
    return updateReviewFlags(ctx, req.session!.companyId, req.session!.userId, id, body);
  });

  app.delete('/api/reviews/:id', { preHandler: requireAuth(ctx, 'catalog.write') }, async (req) => {
    const id = z.string().uuid().parse((req.params as { id: string }).id);
    return deleteReview(ctx, req.session!.companyId, req.session!.userId, id);
  });

  app.post('/api/reviews/publish', { preHandler: requireAuth(ctx, 'catalog.write') }, async (req) =>
    publishReviewsToShopify(ctx, req.session!.companyId, req.session!.userId));

  // ---------- Free Phone System Voice Greeting Generator ----------
  app.post('/api/voice/generate', { preHandler: requireAuth(ctx, 'catalog.read') }, async (req, reply) => {
    const body = voiceGenerateSchema.parse(req.body);
    const { buffer, engine } = await generatePhoneGreetingAudio(ctx, req.session!.companyId, req.session!.userId, body);
    const clipId = saveVoiceClip(req.session!.companyId, buffer);
    reply
      .header('Content-Type', 'audio/mpeg')
      .header('Content-Disposition', 'attachment; filename="ubc-phone-greeting.mp3"')
      .header('X-UBC-Voice-Engine', engine)
      .header('X-UBC-Clip-Id', clipId);
    return reply.send(buffer);
  });

  // iOS Safari <audio> requires HTTP byte-range (206 Partial Content) responses.
  app.get('/api/voice/clip/:id', { preHandler: requireAuth(ctx, 'catalog.read') }, async (req, reply) => {
    const id = z.string().uuid().parse((req.params as { id: string }).id);
    const buf = getVoiceClip(req.session!.companyId, id);
    if (!buf) throw notFound('Voice clip');
    const total = buf.length;
    const range = req.headers.range;
    reply.header('Content-Type', 'audio/mpeg').header('Accept-Ranges', 'bytes').header('Cache-Control', 'private, max-age=600');
    if (range) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(String(range).trim());
      if (m) {
        const start = Math.min(total - 1, Number(m[1]));
        const end = m[2] ? Math.min(total - 1, Number(m[2])) : total - 1;
        if (start <= end) {
          reply.code(206).header('Content-Range', `bytes ${start}-${end}/${total}`).header('Content-Length', String(end - start + 1));
          return reply.send(buf.subarray(start, end + 1));
        }
      }
    }
    reply.header('Content-Length', String(total));
    return reply.send(buf);
  });
}
