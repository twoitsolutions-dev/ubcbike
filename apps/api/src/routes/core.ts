import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { computeAvailability, evaluateLine } from '@ubc/business-rules';
import { DEMO_NOTICE } from '@ubc/demo-data';
import { ROLE_PERMISSIONS, type ItemFilter } from '@ubc/shared';
import { withTransaction } from '@ubc/database';
import { login, logout, requireAuth } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { getItem, getSettings, itemFilterSchema, listItems, loadAllMatching } from '../services/catalog.js';
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

export function registerCoreRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/system', async () => ({
    mode: ctx.config.mode,
    demoNotice: ctx.config.mode === 'demo' ? DEMO_NOTICE : null,
    version: '0.1.0',
  }));

  app.post('/api/auth/login', { config: { rawBody: false } }, async (req, reply) => {
    const body = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) }).parse(req.body);
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
    const { availability } = await getSettings(ctx.pool, c);
    const items = await loadAllMatching(ctx.pool, c, {}, availability);
    const counts = { published: 0, physical: 0, virtualOnly: 0, unavailable: 0, total: items.length };
    for (const i of items) {
      if (i.status === 'published') counts.published++;
      const st = computeAvailability(i, availability).status;
      if (st === 'in_stock') counts.physical++;
      else if (st === 'special_order') counts.virtualOnly++;
      else counts.unavailable++;
    }
    const q = (sql: string) => ctx.pool.query<{ n: number }>(sql, [c]).then((r) => r.rows[0]!.n);
    const [orders, pendingSpecial, awaitingApproval, activeCampaigns, openErrors, deadJobs, reviews] = await Promise.all([
      q(`SELECT count(*)::int n FROM orders WHERE company_id = $1`),
      q(`SELECT count(*)::int n FROM orders WHERE company_id = $1 AND is_special_order AND internal_status NOT IN ('completed','cancelled')`),
      q(`SELECT count(*)::int n FROM orders WHERE company_id = $1 AND internal_status = 'awaiting_approval'`),
      q(`SELECT count(*)::int n FROM campaigns WHERE company_id = $1 AND status IN ('active','scheduled','applying')`),
      q(`SELECT count(*)::int n FROM error_log WHERE company_id = $1 AND resolved_at IS NULL`),
      q(`SELECT count(*)::int n FROM jobs WHERE company_id = $1 AND status = 'dead'`),
      q(`SELECT count(*)::int n FROM match_reviews WHERE company_id = $1 AND status = 'pending'`),
    ]);
    const syncs = await ctx.pool.query(`SELECT type, status, finished_at, created_at FROM jobs WHERE company_id = $1 ORDER BY created_at DESC LIMIT 8`, [c]);
    return {
      counts: { ...counts, orders, pendingSpecial, awaitingApproval, activeCampaigns, openErrors, deadJobs, pendingMatchReviews: reviews },
      recentJobs: syncs.rows,
      shopifySales: ctx.config.mode === 'demo' ? { available: false, reason: 'Shopify not connected (DEMO)' } : { available: false, reason: 'Requires authorised Shopify connection' },
    };
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
    const history = await ctx.pool.query(`SELECT old_price_cents, new_price_cents, source, campaign_id, created_at FROM price_history WHERE variant_id = $1 ORDER BY created_at DESC LIMIT 50`, [id]);
    const ext = await ctx.pool.query(`SELECT system, external_id FROM external_ids WHERE entity_id = $1`, [id]);
    return { item, availability: computeAvailability(item, availability), priceHistory: history.rows, externalIds: ext.rows };
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
    });
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
