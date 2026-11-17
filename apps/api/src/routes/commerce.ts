import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { REASON_LABELS } from '@ubc/business-rules';
import { signShopifyWebhook, verifyShopifyWebhook, type ShopifyOrderWebhook } from '@ubc/integrations';
import { requireAuth } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import {
  approveCampaign, campaignInputSchema, cancelCampaign, createCampaign, getCampaign, refreshPreview, requestRestore,
} from '../services/campaigns.js';
import { getItem } from '../services/catalog.js';
import { HttpError, notFound, type AppContext } from '../services/context.js';
import { enqueue } from '../services/jobs.js';
import { transitionOrder, transitionSchema } from '../services/orders.js';
import { getPipelineStatus, runPipelineWatchdogAndSchedules } from '../services/pipeline.js';
import {
  importChunkSchema,
  importSchema,
  importSupplierChunk,
  promoteOffersSchema,
  resolveReview,
} from '../services/suppliers.js';

const uuidParam = z.object({ id: z.string().uuid() });

export function registerCommerceRoutes(app: FastifyInstance, ctx: AppContext) {
  // ---------- Campaigns ----------
  app.get('/api/campaigns', { preHandler: requireAuth(ctx, 'catalog.read') }, async (req) => {
    const r = await ctx.pool.query(
      `SELECT c.id, c.name, c.status, c.channel, c.strategy, c.starts_at, c.ends_at, c.summary, c.adjustment, c.selection, c.created_at, u.name AS created_by, a.name AS approved_by
       FROM campaigns c JOIN users u ON u.id = c.created_by LEFT JOIN users a ON a.id = c.approved_by WHERE c.company_id = $1 ORDER BY c.created_at DESC`, [req.session!.companyId]);
    return { campaigns: r.rows };
  });

  app.post('/api/campaigns', { preHandler: requireAuth(ctx, 'pricing.write') }, async (req, reply) => {
    const input = campaignInputSchema.parse(req.body);
    reply.code(201);
    return createCampaign(ctx, req.session!.companyId, req.session!.userId, input);
  });

  app.get('/api/campaigns/:id', { preHandler: requireAuth(ctx, 'catalog.read') }, async (req) => {
    const { id } = uuidParam.parse(req.params);
    return getCampaign(ctx.pool, req.session!.companyId, id);
  });

  app.get('/api/campaigns/:id/lines', { preHandler: requireAuth(ctx, 'catalog.read') }, async (req) => {
    const { id } = uuidParam.parse(req.params);
    const q = z.object({ status: z.enum(['ok', 'warning', 'blocked', 'excluded']).optional(), limit: z.coerce.number().int().max(500).default(100), offset: z.coerce.number().int().min(0).default(0) }).parse(req.query);
    await getCampaign(ctx.pool, req.session!.companyId, id);
    const r = await ctx.pool.query(
      `SELECT cl.*, v.sku, v.title, p.brand, p.category FROM campaign_lines cl JOIN variants v ON v.id = cl.variant_id JOIN products p ON p.id = v.product_id
       WHERE cl.campaign_id = $1 AND ($2::text IS NULL OR cl.status = $2) ORDER BY cl.status, v.sku LIMIT $3 OFFSET $4`, [id, q.status ?? null, q.limit, q.offset]);
    const n = await ctx.pool.query<{ n: number }>(`SELECT count(*)::int n FROM campaign_lines WHERE campaign_id = $1 AND ($2::text IS NULL OR status = $2)`, [id, q.status ?? null]);
    return { total: n.rows[0]!.n, lines: r.rows, reasonLabels: REASON_LABELS };
  });

  app.get('/api/campaigns/:id/export.csv', { preHandler: requireAuth(ctx, 'catalog.read') }, async (req, reply) => {
    const { id } = uuidParam.parse(req.params);
    const camp = await getCampaign(ctx.pool, req.session!.companyId, id);
    const r = await ctx.pool.query<Record<string, unknown>>(
      `SELECT v.sku, v.title, p.brand, p.category, cl.old_price_cents, cl.new_price_cents, cl.cost_cents, cl.map_cents, cl.status, cl.reasons, cl.applied_at, cl.restore_result
       FROM campaign_lines cl JOIN variants v ON v.id = cl.variant_id JOIN products p ON p.id = v.product_id WHERE cl.campaign_id = $1 ORDER BY v.sku`, [id]);
    const esc = (v: unknown) => { const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const cols = ['sku', 'title', 'brand', 'category', 'old_price_cents', 'new_price_cents', 'cost_cents', 'map_cents', 'status', 'reasons', 'applied_at', 'restore_result'];
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="campaign-${camp.name.replace(/\W+/g, '_')}.csv"`);
    return [cols.join(','), ...r.rows.map((row) => cols.map((c) => esc(row[c])).join(','))].join('\n');
  });

  app.post('/api/campaigns/:id/preview', { preHandler: requireAuth(ctx, 'pricing.write') }, async (req) => {
    const { id } = uuidParam.parse(req.params);
    return refreshPreview(ctx, req.session!.companyId, req.session!.userId, id);
  });

  app.post('/api/campaigns/:id/approve', { preHandler: requireAuth(ctx, 'campaign.approve') }, async (req) => {
    const { id } = uuidParam.parse(req.params);
    const { previewToken } = z.object({ previewToken: z.string().min(8) }).parse(req.body);
    return approveCampaign(ctx, req.session!.companyId, req.session!.userId, id, previewToken);
  });

  app.post('/api/campaigns/:id/restore', { preHandler: requireAuth(ctx, 'pricing.write') }, async (req) => {
    const { id } = uuidParam.parse(req.params);
    return requestRestore(ctx, req.session!.companyId, req.session!.userId, id);
  });

  app.post('/api/campaigns/:id/cancel', { preHandler: requireAuth(ctx, 'pricing.write') }, async (req) => {
    const { id } = uuidParam.parse(req.params);
    await cancelCampaign(ctx, req.session!.companyId, req.session!.userId, id);
    return { ok: true };
  });

  /** MAP exceptions need map.exception (owner/admin) — a buyer cannot unblock MAP alone. */
  app.post('/api/map-exceptions', { preHandler: requireAuth(ctx, 'map.exception') }, async (req, reply) => {
    const body = z.object({
      itemId: z.string().uuid(), approvedBy: z.string().min(2).max(200), reference: z.string().min(2).max(200),
      validUntil: z.string().datetime(), note: z.string().max(1000).default(''),
    }).parse(req.body);
    const s = req.session!;
    if (!(await getItem(ctx.pool, s.companyId, body.itemId))) throw notFound('Item');
    const r = await ctx.pool.query<{ id: string }>(
      `INSERT INTO map_exceptions (company_id, variant_id, approved_by, reference, valid_until, note, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [s.companyId, body.itemId, body.approvedBy, body.reference, body.validUntil, body.note, s.userId]);
    await audit(ctx.pool, { companyId: s.companyId, userId: s.userId, action: 'map_exception.recorded', entityType: 'variant', entityId: body.itemId, detail: body });
    reply.code(201);
    return { id: r.rows[0]!.id };
  });

  // ---------- Orders & purchasing ----------
  app.get('/api/orders', { preHandler: requireAuth(ctx, 'orders.read') }, async (req) => {
    const q = z.object({ status: z.string().optional(), special: z.enum(['true', 'false']).optional(), q: z.string().max(100).optional() }).parse(req.query);
    const r = await ctx.pool.query(
      `SELECT o.id, o.number, o.customer_name, o.fulfillment_method, o.financial_status, o.shopify_fulfillment_status, o.internal_status,
              o.is_special_order, o.exception_reason, o.total_cents, o.tracking, o.created_at,
              (SELECT count(*)::int FROM order_lines ol WHERE ol.order_id = o.id) AS line_count
       FROM orders o WHERE o.company_id = $1 AND ($2::text IS NULL OR o.internal_status = $2)
         AND ($3::boolean IS NULL OR o.is_special_order = $3) AND ($4::text IS NULL OR o.number ILIKE '%' || $4 || '%' OR o.customer_name ILIKE '%' || $4 || '%')
       ORDER BY o.created_at DESC LIMIT 300`,
      [req.session!.companyId, q.status ?? null, q.special === undefined ? null : q.special === 'true', q.q ?? null]);
    return { orders: r.rows };
  });

  app.get('/api/orders/:id', { preHandler: requireAuth(ctx, 'orders.read') }, async (req) => {
    const { id } = uuidParam.parse(req.params);
    const c = req.session!.companyId;
    const o = await ctx.pool.query(`SELECT * FROM orders WHERE company_id = $1 AND id = $2`, [c, id]);
    if (!o.rows[0]) throw notFound('Order');
    const [lines, events, pos] = await Promise.all([
      ctx.pool.query(
        `SELECT ol.*, s.code AS supplier_code,
                (SELECT so.supplier_sku FROM supplier_offers so WHERE so.variant_id = ol.variant_id AND so.supplier_id = ol.supplier_id LIMIT 1) AS supplier_sku,
                (SELECT json_agg(DISTINCT o2.number)
                 FROM order_lines ol2
                 JOIN orders o2 ON o2.id = ol2.order_id
                 WHERE ol.source = 'supplier'
                   AND ol2.source = 'supplier'
                   AND ((ol.variant_id IS NOT NULL AND ol2.variant_id = ol.variant_id) OR ol2.sku = ol.sku)
                   AND o2.company_id = $2
                   AND o2.id <> ol.order_id
                   AND o2.internal_status NOT IN ('completed', 'cancelled')) AS shared_open_orders
         FROM order_lines ol LEFT JOIN suppliers s ON s.id = ol.supplier_id WHERE ol.order_id = $1`,
        [id, c],
      ),
      ctx.pool.query(`SELECT * FROM order_events WHERE order_id = $1 ORDER BY id`, [id]),
      ctx.pool.query(
        `SELECT po.*, s.code AS supplier_code, s.name AS supplier_name, u.name AS approved_by_name,
                 (SELECT json_agg(pol) FROM purchase_order_lines pol WHERE purchase_order_id = po.id) AS lines,
                 (SELECT json_agg(DISTINCT o2.number)
                  FROM purchase_order_lines pol
                  JOIN purchase_order_lines pol2 ON pol2.supplier_sku = pol.supplier_sku AND pol2.purchase_order_id <> po.id
                  JOIN purchase_orders po2 ON po2.id = pol2.purchase_order_id AND po2.company_id = po.company_id
                  JOIN orders o2 ON o2.id = po2.order_id
                  WHERE pol.purchase_order_id = po.id
                    AND po2.status NOT IN ('cancelled')
                    AND o2.internal_status NOT IN ('completed', 'cancelled')) AS shared_open_orders
          FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id LEFT JOIN users u ON u.id = po.approved_by WHERE po.order_id = $1`, [id]),
    ]);
    return { order: o.rows[0], lines: lines.rows, events: events.rows, purchaseOrders: pos.rows };
  });

  app.post('/api/orders/:id/transition', { preHandler: requireAuth(ctx, 'orders.write') }, async (req, reply) => {
    const { id } = uuidParam.parse(req.params);
    const body = transitionSchema.parse(req.body);
    const s = req.session!;
    const res = await transitionOrder(ctx, { companyId: s.companyId, userId: s.userId, role: s.role, name: s.name }, id, body);
    if ('queued' in res) reply.code(202);
    return res;
  });

  app.get('/api/purchase-orders', { preHandler: requireAuth(ctx, 'orders.read') }, async (req) => {
    const r = await ctx.pool.query(
      `SELECT po.id, po.po_number, po.status, po.ship_to, po.total_cents, po.external_ref, po.tracking, po.created_at, po.approved_at, po.submitted_at,
              s.code AS supplier_code, o.number AS order_number, o.id AS order_id, u.name AS approved_by,
              (SELECT json_agg(pol) FROM purchase_order_lines pol WHERE pol.purchase_order_id = po.id) AS lines,
              (SELECT json_agg(DISTINCT o2.number)
               FROM purchase_order_lines pol
               JOIN purchase_order_lines pol2 ON pol2.supplier_sku = pol.supplier_sku AND pol2.purchase_order_id <> po.id
               JOIN purchase_orders po2 ON po2.id = pol2.purchase_order_id AND po2.company_id = po.company_id
               JOIN orders o2 ON o2.id = po2.order_id
               WHERE pol.purchase_order_id = po.id
                 AND po2.status NOT IN ('cancelled')
                 AND o2.internal_status NOT IN ('completed', 'cancelled')) AS shared_open_orders
       FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id LEFT JOIN orders o ON o.id = po.order_id LEFT JOIN users u ON u.id = po.approved_by
       WHERE po.company_id = $1 ORDER BY po.created_at DESC`, [req.session!.companyId]);
    return { purchaseOrders: r.rows };
  });

  /**
   * DEMO storefront checkout: builds a Shopify-shaped orders/create payload, signs it with the
   * DEMO secret and sends it through the same verification + idempotency + job path as a real webhook.
   */
  app.post('/api/demo/checkout', { preHandler: requireAuth(ctx, 'orders.write') }, async (req, reply) => {
    if (ctx.config.mode !== 'demo') throw new HttpError(404, 'NOT_FOUND', 'Not available');
    const body = z.object({
      lines: z.array(z.object({ itemId: z.string().uuid(), qty: z.number().int().min(1).max(20) })).min(1).max(20),
      method: z.enum(['pickup', 'ship']), customerName: z.string().min(1).max(100),
    }).parse(req.body);
    const s = req.session!;
    const items = await Promise.all(body.lines.map((l) => getItem(ctx.pool, s.companyId, l.itemId)));
    if (items.some((i) => !i)) throw notFound('Item');
    const seq = Date.now();
    const payload: ShopifyOrderWebhook = {
      id: `demo-${seq}`, name: `#DEMO-${String(seq).slice(-6)}`, created_at: new Date().toISOString(), financial_status: 'paid',
      fulfillment_status: null, customer: { first_name: body.customerName, last_name: '(demo)' },
      shipping_lines: body.method === 'pickup' ? [{ code: 'pickup', title: 'Store pickup' }] : [{ code: 'standard', title: 'Standard shipping' }],
      total_price: (items.reduce((sum, it, i) => sum + it!.priceCents * body.lines[i]!.qty, 0) / 100).toFixed(2),
      line_items: items.map((it, i) => ({ id: `li-${seq}-${i}`, variant_id: null, sku: it!.sku, title: it!.title, quantity: body.lines[i]!.qty, price: (it!.priceCents / 100).toFixed(2) })),
    };
    const raw = JSON.stringify(payload);
    const res = await app.inject({
      method: 'POST', url: '/webhooks/shopify',
      headers: {
        'content-type': 'application/json', 'x-shopify-topic': 'orders/create', 'x-shopify-shop-domain': 'demo.local',
        'x-shopify-webhook-id': `demo-wh-${seq}`, 'x-shopify-hmac-sha256': signShopifyWebhook(raw, ctx.config.env.DEMO_WEBHOOK_SECRET),
      },
      payload: raw,
    });
    reply.code(res.statusCode === 200 ? 202 : res.statusCode);
    return { webhook: res.json(), orderNumber: payload.name };
  });

  // ---------- Suppliers ----------
  app.get('/api/suppliers', { preHandler: requireAuth(ctx, 'catalog.read') }, async (req) => {
    const c = req.session!.companyId;
    const r = await ctx.pool.query(
      `SELECT s.id, s.code, s.name, s.connector, s.methods, s.notes, s.is_active,
              count(so.id)::int AS offers, count(so.id) FILTER (WHERE so.variant_id IS NULL)::int AS unmatched,
              max(so.reported_at) AS last_report
       FROM suppliers s LEFT JOIN supplier_offers so ON so.supplier_id = s.id WHERE s.company_id = $1 GROUP BY s.id ORDER BY s.code`, [c]);
    const health = await Promise.all(r.rows.map((row: { code: string }) => ctx.connectors.suppliers.get(row.code)?.health()));
    return { suppliers: r.rows.map((row: object, i: number) => ({ ...row, health: health[i] ?? null })) };
  });

  app.get('/api/suppliers/:code/offers', { preHandler: requireAuth(ctx, 'catalog.read') }, async (req) => {
    const { code } = z.object({ code: z.string().max(50) }).parse(req.params);
    const q = z.object({ unmatched: z.enum(['true', 'false']).optional(), limit: z.coerce.number().int().max(200).default(50), offset: z.coerce.number().int().default(0) }).parse(req.query);
    const r = await ctx.pool.query(
      `SELECT so.id, so.supplier_sku, so.brand, so.title, so.upc, so.mpn, so.cost_cents, so.qty_available, so.drop_ship, so.lead_days, so.reported_at, so.content_licensed, v.sku AS ubc_sku
       FROM supplier_offers so JOIN suppliers s ON s.id = so.supplier_id LEFT JOIN variants v ON v.id = so.variant_id
       WHERE so.company_id = $1 AND s.code = $2 AND ($3::boolean IS NULL OR (so.variant_id IS NULL) = $3) ORDER BY so.supplier_sku LIMIT $4 OFFSET $5`,
      [req.session!.companyId, code, q.unmatched === undefined ? null : q.unmatched === 'true', q.limit, q.offset]);
    return { offers: r.rows };
  });

  app.post('/api/suppliers/:code/import', { preHandler: requireAuth(ctx, 'catalog.write'), bodyLimit: 32 * 1024 * 1024 }, async (req, reply) => {
    const { code } = z.object({ code: z.string().max(50) }).parse(req.params);
    const body = importSchema.parse(req.body);
    const s = req.session!;
    const job = await enqueue(ctx.pool, { companyId: s.companyId, type: 'supplier.import_feed', payload: { ...body, supplierCode: code }, createdBy: s.userId, maxAttempts: 2 });
    reply.code(202);
    return { jobId: job.id };
  });

  app.post('/api/suppliers/:code/import-chunk', { preHandler: requireAuth(ctx, 'catalog.write'), bodyLimit: 16 * 1024 * 1024 }, async (req) => {
    const { code } = z.object({ code: z.string().max(50) }).parse(req.params);
    const body = importChunkSchema.parse(req.body);
    return importSupplierChunk(ctx, req.session!.companyId, code, body);
  });

  app.post('/api/suppliers/:code/promote', { preHandler: requireAuth(ctx, 'catalog.write') }, async (req, reply) => {
    const { code } = z.object({ code: z.string().max(50) }).parse(req.params);
    const body = promoteOffersSchema.omit({ supplierCode: true }).parse(req.body ?? {});
    const s = req.session!;
    const job = await enqueue(ctx.pool, {
      companyId: s.companyId,
      type: 'supplier.promote_catalog',
      payload: { ...body, supplierCode: code },
      createdBy: s.userId,
      maxAttempts: 2,
    });
    reply.code(202);
    return { jobId: job.id };
  });

  app.get('/api/match-reviews', { preHandler: requireAuth(ctx, 'catalog.read') }, async (req) => {
    const q = z.object({
      limit: z.coerce.number().int().min(1).max(250).default(100),
      offset: z.coerce.number().int().min(0).default(0),
      supplier: z.string().max(50).optional(),
    }).parse(req.query);
    const c = req.session!.companyId;
    const [r, cnt] = await Promise.all([
      ctx.pool.query(
        `SELECT mr.id, mr.score, mr.reasons, mr.status, mr.created_at, s.code AS supplier_code, so.supplier_sku, so.title AS offer_title, so.brand AS offer_brand,
                so.upc AS offer_upc, so.mpn AS offer_mpn, v.sku AS candidate_sku, v.title AS candidate_title, v.upc AS candidate_upc, v.mpn AS candidate_mpn
         FROM match_reviews mr
         JOIN supplier_offers so ON so.id = mr.offer_id
         JOIN suppliers s ON s.id = so.supplier_id
         LEFT JOIN variants v ON v.id = mr.candidate_variant_id
         WHERE mr.company_id = $1 AND mr.status = 'pending'
           AND ($2::text IS NULL OR s.code = $2)
         ORDER BY mr.score DESC, mr.id
         LIMIT $3 OFFSET $4`,
        [c, q.supplier ?? null, q.limit, q.offset],
      ),
      ctx.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n
         FROM match_reviews mr
         JOIN supplier_offers so ON so.id = mr.offer_id
         JOIN suppliers s ON s.id = so.supplier_id
         WHERE mr.company_id = $1 AND mr.status = 'pending'
           AND ($2::text IS NULL OR s.code = $2)`,
        [c, q.supplier ?? null],
      ),
    ]);
    return { reviews: r.rows, total: cnt.rows[0]!.n };
  });

  app.post('/api/match-reviews/:id/resolve', { preHandler: requireAuth(ctx, 'catalog.write') }, async (req) => {
    const { id } = uuidParam.parse(req.params);
    const { decision } = z.object({ decision: z.enum(['approved', 'rejected']) }).parse(req.body);
    return resolveReview(ctx, req.session!.companyId, req.session!.userId, id, decision);
  });

  // ---------- Intermediary Engine Pipeline (Observability, Versioning & Staging) ----------
  app.get('/api/pipeline/status', { preHandler: requireAuth(ctx, 'catalog.read') }, async (req) => {
    return getPipelineStatus(ctx, req.session!.companyId);
  });

  app.get('/api/pipeline/offer-history', { preHandler: requireAuth(ctx, 'catalog.read') }, async (req) => {
    const q = z.object({
      supplier: z.string().max(50).optional(),
      variantId: z.string().uuid().optional(),
      limit: z.coerce.number().int().max(200).default(50),
    }).parse(req.query);
    const r = await ctx.pool.query(
      `SELECT h.id, s.code AS supplier_code, h.supplier_sku, v.sku AS ubc_sku, v.title AS variant_title,
              h.change_types, h.old_cost_cents, h.new_cost_cents, h.old_map_cents, h.new_map_cents,
              h.old_qty, h.new_qty, h.shopify_published_price_cents, h.resulting_margin_bps, h.recorded_at
       FROM supplier_offer_history h
       JOIN suppliers s ON s.id = h.supplier_id
       LEFT JOIN variants v ON v.id = h.variant_id
       WHERE h.company_id = $1
         AND ($2::text IS NULL OR s.code = $2)
         AND ($3::uuid IS NULL OR h.variant_id = $3)
       ORDER BY h.recorded_at DESC
       LIMIT $4`,
      [req.session!.companyId, q.supplier ?? null, q.variantId ?? null, q.limit],
    );
    return { history: r.rows };
  });

  app.get('/api/pipeline/staging', { preHandler: requireAuth(ctx, 'catalog.read') }, async (req) => {
    const q = z.object({
      decision: z.enum(['ready_for_shopify', 'held_for_review']).optional(),
      status: z.enum(['pending', 'pushed', 'held', 'dismissed']).optional(),
      limit: z.coerce.number().int().max(200).default(50),
    }).parse(req.query);
    const r = await ctx.pool.query(
      `SELECT oss.id, oss.variant_id, v.sku, v.title, oss.stream, oss.decision, oss.hold_reasons,
              oss.shopify_payload, oss.status, oss.updated_at, oss.pushed_at
       FROM outbound_sync_staging oss
       JOIN variants v ON v.id = oss.variant_id
       WHERE oss.company_id = $1
         AND ($2::text IS NULL OR oss.decision = $2)
         AND ($3::text IS NULL OR oss.status = $3)
       ORDER BY oss.updated_at DESC
       LIMIT $4`,
      [req.session!.companyId, q.decision ?? null, q.status ?? null, q.limit],
    );
    return { staged: r.rows };
  });

  app.post('/api/pipeline/staging/:id/resolve', { preHandler: requireAuth(ctx, 'pricing.write') }, async (req) => {
    const s = req.session!;
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const body = z.object({
      action: z.enum(['release', 'dismiss']),
      note: z.string().max(300).optional(),
    }).parse(req.body);
    const nextDecision = body.action === 'release' ? 'ready_for_shopify' : 'held_for_review';
    const nextStatus = body.action === 'release' ? 'pending' : 'dismissed';
    const r = await ctx.pool.query<{ id: number; variant_id: string }>(
      `UPDATE outbound_sync_staging
       SET decision = $3,
           status = $4,
           hold_reasons = CASE WHEN $3 = 'ready_for_shopify' THEN '[]'::jsonb ELSE hold_reasons END,
           updated_at = now()
       WHERE company_id = $1 AND id = $2
       RETURNING id, variant_id`,
      [s.companyId, id, nextDecision, nextStatus],
    );
    if (!r.rows[0]) throw notFound('Staging entry');
    await audit(ctx.pool, {
      companyId: s.companyId,
      userId: s.userId,
      action: `pipeline.staging_${body.action}`,
      entityType: 'variant',
      entityId: r.rows[0].variant_id,
      detail: { stagingId: id, note: body.note ?? null },
    });
    return { ok: true, id, status: nextStatus, decision: nextDecision };
  });

  app.post('/api/pipeline/flush', { preHandler: requireAuth(ctx, 'integrations.manage') }, async (req, reply) => {
    const s = req.session!;
    const job = await enqueue(ctx.pool, {
      companyId: s.companyId,
      type: 'pipeline.flush_shopify',
      payload: { trigger: 'manual' },
      createdBy: s.userId,
    });
    reply.code(202);
    return { jobId: job.id };
  });

  app.post('/api/pipeline/watchdog', { preHandler: requireAuth(ctx, 'integrations.manage') }, async () => {
    return runPipelineWatchdogAndSchedules(ctx);
  });

  // ---------- Shopify-First Bootstrap & Setup ----------
  app.post('/api/shopify/sync', { preHandler: requireAuth(ctx, 'integrations.manage') }, async (req, reply) => {
    const s = req.session!;
    const job = await enqueue(ctx.pool, {
      companyId: s.companyId,
      type: 'shopify.sync_catalog',
      payload: { trigger: 'manual' },
      createdBy: s.userId,
      maxAttempts: 3,
    });
    reply.code(202);
    return { jobId: job.id };
  });

  app.post('/api/shopify/setup-metafields', { preHandler: requireAuth(ctx, 'integrations.manage') }, async (req) => {
    const res = await ctx.connectors.shopify.ensureUbcMetafieldDefinitions();
    await audit(ctx.pool, { companyId: req.session!.companyId, userId: req.session!.userId, action: 'shopify.metafields_ensured', detail: res });
    return res;
  });

  app.post('/api/shopify/setup-collections', { preHandler: requireAuth(ctx, 'integrations.manage') }, async (req) => {
    const res = await ctx.connectors.shopify.ensureSmartCollections();
    await audit(ctx.pool, { companyId: req.session!.companyId, userId: req.session!.userId, action: 'shopify.collections_ensured', detail: res });
    return res;
  });

  app.post('/api/lightspeed/sync', { preHandler: requireAuth(ctx, 'integrations.manage') }, async (req, reply) => {
    const body = z.object({
      full: z.boolean().default(false),
      publishNew: z.boolean().default(false),
    }).parse(req.body ?? {});
    const s = req.session!;
    const job = await enqueue(ctx.pool, {
      companyId: s.companyId,
      type: 'lightspeed.sync_catalog',
      payload: body,
      createdBy: s.userId,
      maxAttempts: 3,
    });
    await enqueue(ctx.pool, {
      companyId: s.companyId,
      type: 'lightspeed.sync_special_orders',
      payload: {},
      createdBy: s.userId,
      maxAttempts: 2,
    });
    reply.code(202);
    return { jobId: job.id };
  });

  // Public HTTPS OAuth redirect landing page for Lightspeed Retail R-Series (`register.php` requires https://)
  app.get('/oauth/lightspeed/callback', async (req, reply) => {
    const q = req.query as { code?: string; error?: string };
    reply.header('Content-Type', 'text/html; charset=utf-8');
    if (q.error) {
      return `<!doctype html><html><body style="font-family:system-ui,sans-serif;background:#14202D;color:#FEFDF3;display:grid;place-items:center;min-height:100vh;margin:0"><div style="max-width:520px;padding:32px;border-radius:16px;background:#1E2F42;text-align:center"><h2>Authorization Cancelled</h2><p>${String(q.error).replace(/[<>&"]/g, '')}</p></div></body></html>`;
    }
    const safeCode = String(q.code || '').replace(/[^A-Za-z0-9._~+/-]/g, '');
    return `<!doctype html><html><head><meta charset="utf-8"><title>UBC Commerce Hub · Lightspeed Authorized</title></head><body style="font-family:system-ui,sans-serif;background:#14202D;color:#FEFDF3;display:grid;place-items:center;min-height:100vh;margin:0"><div style="max-width:560px;padding:32px;border-radius:18px;background:#1B3B2B;border:1px solid rgba(253,230,138,.35);text-align:center"><h2 style="margin:0 0 10px;color:#FDE68A">✓ Lightspeed Retail R-Series Authorized</h2><p style="opacity:.9;line-height:1.5">Copy the authorization code below (or copy the full browser URL) and paste it into your <code>npm run lightspeed:connect</code> terminal prompt:</p><input readonly value="${safeCode}" onclick="this.select()" style="width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:0;font-family:monospace;font-size:15px;text-align:center;margin:12px 0;background:#FEFDF3;color:#14202D"><p style="font-size:13px;opacity:.75;margin:8px 0 0">Read-Only Mode Active · Cash registers & POS prices untouched</p></div></body></html>`;
  });

  // Public HTTPS OAuth redirect landing page for Shopify (`UBC Hub` Dev Dashboard app installation)
  app.get('/api/shopify/oauth/callback', async (req, reply) => {
    const q = req.query as { code?: string; shop?: string; error?: string };
    reply.header('Content-Type', 'text/html; charset=utf-8');
    if (q.error) {
      return `<!doctype html><html><body style="font-family:system-ui,sans-serif;background:#14202D;color:#FEFDF3;display:grid;place-items:center;min-height:100vh;margin:0"><div style="max-width:520px;padding:32px;border-radius:16px;background:#1E2F42;text-align:center"><h2>Shopify Authorization Cancelled</h2><p>${String(q.error).replace(/[<>&"]/g, '')}</p></div></body></html>`;
    }
    const safeCode = String(q.code || '').replace(/[^A-Za-z0-9._~+/-]/g, '');
    const safeShop = String(q.shop || '').replace(/[^A-Za-z0-9.-]/g, '');
    return `<!doctype html><html><head><meta charset="utf-8"><title>UBC Hub · Shopify Authorized</title></head><body style="font-family:system-ui,sans-serif;background:#14202D;color:#FEFDF3;display:grid;place-items:center;min-height:100vh;margin:0"><div style="max-width:560px;padding:32px;border-radius:18px;background:#1B3B2B;border:1px solid rgba(253,230,138,.35);text-align:center"><h2 style="margin:0 0 10px;color:#FDE68A">✓ UBC Hub Connected to ${safeShop || 'Shopify'}</h2><p style="opacity:.9;line-height:1.5">Copy the authorization code below (or copy the full browser URL) and paste it into your terminal prompt:</p><input readonly value="${safeCode}" onclick="this.select()" style="width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:0;font-family:monospace;font-size:15px;text-align:center;margin:12px 0;background:#FEFDF3;color:#14202D"><p style="font-size:13px;opacity:.75;margin:8px 0 0">Safe Read-Only Mode Active until writes are explicitly enabled</p></div></body></html>`;
  });

  // ---------- Integrations ----------
  app.get('/api/integrations', { preHandler: requireAuth(ctx, 'catalog.read') }, async () => {
    const list = await Promise.all([
      ctx.connectors.shopifyHealth(), ctx.connectors.lightspeedHealth(),
      ...[...ctx.connectors.suppliers.values()].map((s) => s.health()),
    ]);
    return { mode: ctx.config.mode, integrations: list, demoCalls: ctx.connectors.demoCalls.slice(-50).reverse() };
  });

  // ---------- Webhooks ----------
  app.post('/webhooks/shopify', { config: { rawBody: true } }, async (req, reply) => {
    const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
    const hmac = req.headers['x-shopify-hmac-sha256'] as string | undefined;
    const secret = ctx.config.mode === 'demo' ? ctx.config.env.DEMO_WEBHOOK_SECRET : ctx.config.env.SHOPIFY_WEBHOOK_SECRET!;
    if (!raw || !verifyShopifyWebhook(raw, hmac, secret)) {
      reply.code(401);
      return { error: 'invalid signature' };
    }
    const topic = String(req.headers['x-shopify-topic'] ?? '');
    const shop = String(req.headers['x-shopify-shop-domain'] ?? '');
    const webhookId = String(req.headers['x-shopify-webhook-id'] ?? '');
    if (!webhookId) { reply.code(400); return { error: 'missing webhook id' }; }
    let store = ctx.config.mode === 'demo'
      ? await ctx.pool.query<{ id: string; company_id: string }>(`SELECT id, company_id FROM stores ORDER BY name LIMIT 1`)
      : await ctx.pool.query<{ id: string; company_id: string }>(`SELECT id, company_id FROM stores WHERE lower(shopify_shop_domain) = lower($1)`, [shop]);
    if (!store.rows[0] && ctx.config.mode !== 'demo' && ctx.config.env.SHOPIFY_SHOP_DOMAIN) {
      // HMAC above already authenticated this Shopify store; support renamed `.myshopify.com` aliases (e.g. `ubcbike-hub.myshopify.com`) seamlessly.
      store = await ctx.pool.query<{ id: string; company_id: string }>(
        `SELECT id, company_id FROM stores WHERE lower(shopify_shop_domain) = lower($1)`,
        [ctx.config.env.SHOPIFY_SHOP_DOMAIN],
      );
    }
    if (!store.rows[0]) { reply.code(404); return { error: 'unknown shop' }; }
    const { id: storeId, company_id: companyId } = store.rows[0];
    const ev = await ctx.pool.query<{ id: number }>(
      `INSERT INTO sync_events (company_id, source, topic, idempotency_key, payload) VALUES ($1,'shopify',$2,$3,$4)
       ON CONFLICT (company_id, source, idempotency_key) DO NOTHING RETURNING id`, [companyId, topic, webhookId, raw.toString('utf8')]);
    if (!ev.rows[0]) return { ok: true, duplicate: true }; // Shopify retries: acknowledge, do nothing.
    let parsedWebhook: { id?: string | number; cancelled_at?: string | null } = {};
    try { parsedWebhook = JSON.parse(raw.toString('utf8')) as { id?: string | number; cancelled_at?: string | null }; } catch { /* ignore */ }
    if (topic === 'orders/create') {
      await enqueue(ctx.pool, { companyId, type: 'shopify.order_created', payload: { syncEventId: ev.rows[0].id, storeId }, idempotencyKey: `shopify:order:${webhookId}` });
    } else if (topic === 'orders/cancelled' || (topic === 'orders/updated' && Boolean(parsedWebhook.cancelled_at))) {
      await enqueue(ctx.pool, {
        companyId,
        type: 'shopify.order_cancelled',
        payload: { syncEventId: ev.rows[0].id, storeId },
        idempotencyKey: `shopify:cancel:${parsedWebhook.id ?? webhookId}`,
      });
    } else {
      await ctx.pool.query(`UPDATE sync_events SET status = 'ignored', processed_at = now() WHERE id = $1`, [ev.rows[0].id]);
    }
    return { ok: true, eventId: ev.rows[0].id };
  });
}
