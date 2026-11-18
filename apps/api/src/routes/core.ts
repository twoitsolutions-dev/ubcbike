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
  const v = {
    shop,
    ...r.rows[0],
    storeVariants: match ? Number(match.detail.storeVariants) || null : null,
    lastMatchAt: match?.created_at ?? null,
    lastReconcileAt: reconcile?.created_at ?? null,
    lastLightspeedSyncAt: lsSync?.created_at ?? null,
    overwrittenFixed24h: fixed24h,
  };
  syncStatsCache.set(companyId, { at: Date.now(), v });
  return v;
}

export function registerCoreRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/system', async () => ({
    mode: ctx.config.mode,
    demoNotice: ctx.config.mode === 'demo' ? DEMO_NOTICE : null,
    version: '0.1.0',
  }));

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
    const payload = {
      shopifySync,
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

  app.get('/api/items/facets', { preHandler: requireAuth(ctx, 'catalog.read') }, async (req) => {
    const c = req.session!.companyId;
    const [cats, brands, sups] = await Promise.all([
      ctx.pool.query(`SELECT category AS value, count(*)::int n FROM catalog_items WHERE company_id = $1 GROUP BY 1 ORDER BY 1`, [c]),
      ctx.pool.query(`SELECT brand AS value, count(*)::int n FROM catalog_items WHERE company_id = $1 GROUP BY 1 ORDER BY 1`, [c]),
      ctx.pool.query(`SELECT code AS value, name FROM suppliers WHERE company_id = $1 AND is_active ORDER BY code`, [c]),
    ]);
    return { categories: cats.rows, brands: brands.rows, suppliers: sups.rows };
  });

  app.get('/api/items/:id', { preHandler: requireAuth(ctx, 'catalog.read') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const c = req.session!.companyId;
    const item = await getItem(ctx.pool, c, id);
    if (!item) throw notFound('Item');
    const { availability } = await getSettings(ctx.pool, c);
    const [history, ext, locs] = await Promise.all([
      ctx.pool.query(`SELECT old_price_cents, new_price_cents, source, campaign_id, created_at FROM price_history WHERE variant_id = $1 ORDER BY created_at DESC LIMIT 50`, [id]),
      ctx.pool.query(`SELECT system, external_id FROM external_ids WHERE entity_id = $1`, [id]),
      ctx.pool.query(
        `SELECT l.name, coalesce(il.on_hand, 0)::int AS on_hand, coalesce(il.reserved, 0)::int AS reserved
         FROM locations l
         LEFT JOIN inventory_levels il ON il.location_id = l.id AND il.variant_id = $1
         WHERE l.company_id = $2 AND l.kind = 'physical'
         ORDER BY (l.shopify_location_id IS NULL), l.name`,
        [id, c],
      ),
    ]);
    return { item, availability: computeAvailability(item, availability), priceHistory: history.rows, externalIds: ext.rows, locationLevels: locs.rows };
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

  app.get('/api/settings', { preHandler: requireAuth(ctx, 'catalog.read') }, async (req) => getSettings(ctx.pool, req.session!.companyId));

  app.put('/api/settings', { preHandler: requireAuth(ctx, 'settings.manage') }, async (req) => {
    const body = z.object({
      campaignRules: rulesSchema.required({ minMarginPct: true, warnMarginPct: true, clampToMinMargin: true }),
      availability: z.object({
        physicalSafetyQty: z.number().int().min(0).max(100), supplierSafetyQty: z.number().int().min(0).max(100),
        maxOfferAgeHours: z.number().int().min(1).max(720), handlingDays: z.number().int().min(0).max(60),
      }),
    }).parse(req.body);
    const s = req.session!;
    const before = await getSettings(ctx.pool, s.companyId);
    await ctx.pool.query(`UPDATE company_settings SET campaign_rules = $2, availability_rules = $3, updated_at = now() WHERE company_id = $1`,
      [s.companyId, JSON.stringify({ ...body.campaignRules, excludeWithoutCost: true }), JSON.stringify(body.availability)]);
    await audit(ctx.pool, { companyId: s.companyId, userId: s.userId, action: 'settings.updated', detail: { before, after: body } });
    return getSettings(ctx.pool, s.companyId);
  });
}
