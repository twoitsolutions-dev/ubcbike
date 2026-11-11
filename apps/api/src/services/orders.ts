import { z } from 'zod';
import { assertTransition, nextSteps, planFulfillment, revalidateCost, TransitionError } from '@ubc/business-rules';
import { ROLE_PERMISSIONS, type ExceptionReason, type Role, type SpecialOrderStatus } from '@ubc/shared';
import { priceToCents, type ShopifyOrderWebhook } from '@ubc/integrations';
import { withTransaction, type PoolClient } from '@ubc/database';
import { audit } from './audit.js';
import { getItem, getSettings } from './catalog.js';
import { conflict, HttpError, notFound, type AppContext } from './context.js';
import { enqueue } from './jobs.js';

export const transitionSchema = z.object({
  to: z.enum(['awaiting_review', 'awaiting_approval', 'approved', 'po_submitted', 'supplier_confirmed', 'in_transit', 'received_at_ubc',
    'ready_for_pickup', 'shipped_to_customer', 'completed', 'exception', 'cancelled']),
  note: z.string().max(1000).optional(),
  tracking: z.string().max(100).optional(),
  reason: z.enum(['out_of_stock_after_purchase', 'cost_changed', 'discontinued', 'partially_available', 'po_rejected', 'connection_error',
    'damaged', 'return_requested', 'refund_requested', 'other']).optional(),
});

interface OrderRow {
  id: string; company_id: string; store_id: string; number: string; internal_status: SpecialOrderStatus;
  fulfillment_method: 'pickup' | 'ship'; is_special_order: boolean;
}

async function addEvent(c: PoolClient, orderId: string, from: string | null, to: string, actor: string, note = '') {
  await c.query(`INSERT INTO order_events (order_id, from_status, to_status, actor, note) VALUES ($1,$2,$3,$4,$5)`, [orderId, from, to, actor, note]);
}

async function setStatus(c: PoolClient, o: OrderRow, to: SpecialOrderStatus, actor: string, note = '', extra: { reason?: ExceptionReason; tracking?: string } = {}) {
  await c.query(
    `UPDATE orders SET internal_status = $2, exception_reason = CASE WHEN $2 = 'exception' THEN $3 ELSE exception_reason END,
       tracking = COALESCE($4, tracking), updated_at = now() WHERE id = $1`,
    [o.id, to, extra.reason ?? null, extra.tracking ?? null]);
  await addEvent(c, o.id, o.internal_status, to, actor, note);
}

/**
 * Ingest a Shopify order (webhook or DEMO checkout). Idempotent on
 * (store, shopify order id): a redelivered webhook never creates a second
 * order or reserves stock twice.
 */
export async function ingestShopifyOrder(ctx: AppContext, companyId: string, storeId: string, payload: ShopifyOrderWebhook) {
  const settings = await getSettings(ctx.pool, companyId);
  const method: 'pickup' | 'ship' = payload.shipping_lines?.some((s) => /pick ?up/i.test(`${s.code} ${s.title}`)) ? 'pickup' : payload.shipping_lines?.length ? 'ship' : 'pickup';
  const result = await withTransaction(ctx.pool, async (c) => {
    const ins = await c.query<{ id: string }>(
      `INSERT INTO orders (company_id, store_id, shopify_order_id, number, customer_name, fulfillment_method, financial_status, shopify_fulfillment_status, total_cents, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (store_id, shopify_order_id) DO NOTHING RETURNING id`,
      [companyId, storeId, String(payload.id), payload.name,
        [payload.customer?.first_name, payload.customer?.last_name].filter(Boolean).join(' '),
        method, payload.financial_status ?? 'pending', payload.fulfillment_status ?? 'unfulfilled', priceToCents(payload.total_price), payload.created_at]);
    if (!ins.rows[0]) {
      const ex = await c.query<{ id: string }>(`SELECT id FROM orders WHERE store_id = $1 AND shopify_order_id = $2`, [storeId, String(payload.id)]);
      return { orderId: ex.rows[0]!.id, duplicate: true, special: false };
    }
    const orderId = ins.rows[0].id;
    await addEvent(c, orderId, null, 'new_order', 'shopify', `Order ${payload.name} received`);
    let special = false;
    let unfulfillable = false;
    for (const li of payload.line_items) {
      const v = await c.query<{ id: string }>(
        `SELECT v.id FROM variants v LEFT JOIN external_ids e ON e.entity_id = v.id AND e.system = 'shopify' AND e.entity_type = 'variant'
         WHERE v.company_id = $1 AND (e.external_id = $2 OR v.sku = $3) LIMIT 1`, [companyId, String(li.variant_id ?? ''), li.sku ?? '']);
      const item = v.rows[0] ? await getItem(c, companyId, v.rows[0].id) : null;
      const price = priceToCents(li.price);
      if (!item) {
        unfulfillable = true;
        await c.query(`INSERT INTO order_lines (order_id, sku, title, qty, price_cents, source) VALUES ($1,$2,$3,$4,$5,'unfulfillable')`, [orderId, li.sku ?? '?', li.title, li.quantity, price]);
        continue;
      }
      for (const part of planFulfillment(item, li.quantity, method, settings.availability)) {
        if (part.kind === 'ubc_stock') {
          const r = await c.query(
            `UPDATE inventory_levels SET reserved = reserved + $3, updated_at = now()
             WHERE variant_id = $1 AND company_id = $2 AND on_hand - reserved >= $3`, [item.id, companyId, part.qty]);
          if (!r.rowCount) throw new Error(`Stock reservation failed for ${item.sku}`);
          await c.query(`INSERT INTO order_lines (order_id, variant_id, sku, title, qty, price_cents, source, quoted_cost_cents) VALUES ($1,$2,$3,$4,$5,$6,'ubc_stock',$7)`,
            [orderId, item.id, item.sku, item.title, part.qty, price, item.costCents]);
        } else if (part.kind === 'supplier') {
          special = true;
          await c.query(
            `INSERT INTO order_lines (order_id, variant_id, sku, title, qty, price_cents, source, supplier_id, quoted_cost_cents)
             SELECT $1,$2,$3,$4,$5,$6,'supplier', s.id, $8 FROM suppliers s WHERE s.company_id = $9 AND s.code = $7`,
            [orderId, item.id, item.sku, item.title, part.qty, price, part.supplierCode, part.costCents, companyId]);
        } else {
          unfulfillable = true;
          await c.query(`INSERT INTO order_lines (order_id, variant_id, sku, title, qty, price_cents, source) VALUES ($1,$2,$3,$4,$5,$6,'unfulfillable')`,
            [orderId, item.id, item.sku, item.title, part.qty, price]);
        }
      }
    }
    const o: OrderRow = { id: orderId, company_id: companyId, store_id: storeId, number: payload.name, internal_status: 'new_order', fulfillment_method: method, is_special_order: special };
    await c.query(`UPDATE orders SET is_special_order = $2 WHERE id = $1`, [orderId, special]);
    if (unfulfillable) {
      await setStatus(c, o, 'exception', 'system', 'Some units are not available from UBC stock or any supplier', { reason: 'partially_available' });
    } else if (special) {
      await setStatus(c, o, 'awaiting_review', 'system', 'Special order: supplier availability will be re-checked');
      await enqueue(c, { companyId, type: 'order.review', payload: { orderId }, idempotencyKey: `order:review:${orderId}` });
    } else {
      await setStatus(c, o, 'received_at_ubc', 'system', 'All units reserved from UBC stock');
    }
    await audit(c, { companyId, action: 'order.ingested', entityType: 'order', entityId: orderId, detail: { number: payload.name, special, unfulfillable } });
    return { orderId, duplicate: false, special };
  });
  return result;
}

async function loadOrder(c: PoolClient | AppContext['pool'], companyId: string, id: string): Promise<OrderRow> {
  const r = await c.query<OrderRow>(`SELECT id, company_id, store_id, number, internal_status, fulfillment_method, is_special_order FROM orders WHERE company_id = $1 AND id = $2`, [companyId, id]);
  if (!r.rows[0]) throw notFound('Order');
  return r.rows[0];
}

/** Job: re-check supplier availability/cost, then create purchase requests awaiting Carlos's approval. */
export async function reviewOrderJob(ctx: AppContext, companyId: string, orderId: string) {
  const lines = await ctx.pool.query<{ id: string; qty: number; quoted_cost_cents: number; supplier_code: string; supplier_id: string; supplier_sku: string | null }>(
    `SELECT ol.id, ol.qty, ol.quoted_cost_cents, s.code AS supplier_code, s.id AS supplier_id,
            (SELECT so.supplier_sku FROM supplier_offers so WHERE so.variant_id = ol.variant_id AND so.supplier_id = s.id LIMIT 1) AS supplier_sku
     FROM order_lines ol JOIN suppliers s ON s.id = ol.supplier_id WHERE ol.order_id = $1 AND ol.source = 'supplier'`, [orderId]);
  const problems: string[] = [];
  let reason: ExceptionReason | null = null;
  for (const l of lines.rows) {
    const conn = ctx.connectors.suppliers.get(l.supplier_code);
    if (!conn || !l.supplier_sku) { problems.push(`${l.supplier_code}: no connector or SKU mapping`); reason = 'other'; continue; }
    const [q] = await conn.checkAvailability([l.supplier_sku]); // throws -> job retry -> eventually exception
    const check = revalidateCost(l.quoted_cost_cents, q?.costCents ?? null, q?.qtyAvailable ?? 0, l.qty);
    if (!check.ok) { problems.push(`${l.supplier_code} ${l.supplier_sku}: ${check.reason}`); reason = check.reason; }
  }
  return withTransaction(ctx.pool, async (c) => {
    const o = await loadOrder(c, companyId, orderId);
    if (o.internal_status !== 'awaiting_review') return { skipped: o.internal_status };
    if (problems.length) {
      await setStatus(c, o, 'exception', 'system', problems.join('; '), { reason: reason ?? 'other' });
      return { exception: problems };
    }
    const bySupplier = new Map<string, typeof lines.rows>();
    for (const l of lines.rows) bySupplier.set(l.supplier_id, [...(bySupplier.get(l.supplier_id) ?? []), l]);
    let n = 0;
    for (const [supplierId, ls] of bySupplier) {
      n++;
      const poNumber = `PO-${o.number.replace(/\W/g, '')}-${n}`;
      const po = await c.query<{ id: string }>(
        `INSERT INTO purchase_orders (company_id, supplier_id, order_id, po_number, status, ship_to, total_cents, idempotency_key)
         VALUES ($1,$2,$3,$4,'awaiting_approval',$5,$6,$7) ON CONFLICT (company_id, idempotency_key) DO NOTHING RETURNING id`,
        [companyId, supplierId, orderId, poNumber, o.fulfillment_method === 'ship' ? 'customer' : 'ubc_store',
          ls.reduce((s, l) => s + l.quoted_cost_cents * l.qty, 0), `po:${orderId}:${supplierId}`]);
      if (!po.rows[0]) continue;
      for (const l of ls) {
        await c.query(`INSERT INTO purchase_order_lines (purchase_order_id, order_line_id, supplier_sku, qty, expected_cost_cents) VALUES ($1,$2,$3,$4,$5)`,
          [po.rows[0].id, l.id, l.supplier_sku, l.qty, l.quoted_cost_cents]);
      }
    }
    await setStatus(c, o, 'awaiting_approval', 'system', 'Availability and cost confirmed; purchase request awaiting approval');
    // Notification for Carlos: surfaced on the dashboard and in the audit trail (email/SMS delivery is a later phase).
    await audit(c, { companyId, action: 'notification.purchase_approval_needed', entityType: 'order', entityId: orderId, detail: { number: o.number } });
    return { purchaseOrders: n };
  });
}

export async function transitionOrder(
  ctx: AppContext, s: { companyId: string; userId: string; role: Role; name: string }, orderId: string, input: z.infer<typeof transitionSchema>,
) {
  const perms = ROLE_PERMISSIONS[s.role];
  const pool = ctx.pool;
  const o = await loadOrder(pool, s.companyId, orderId);
  try {
    assertTransition(o.internal_status, input.to, perms, input.note);
  } catch (e) {
    if (e instanceof TransitionError) throw new HttpError(e.code === 'FORBIDDEN' ? 403 : 422, e.code, e.message);
    throw e;
  }
  if (!nextSteps(o.internal_status, o.fulfillment_method).includes(input.to)) {
    throw new HttpError(422, 'INVALID_FOR_METHOD', `${input.to} does not apply to ${o.fulfillment_method} orders`);
  }
  if (input.to === 'exception' && !input.reason) throw new HttpError(422, 'REASON_REQUIRED', 'Choose an exception reason');

  if (input.to === 'approved') {
    // Explicit human approval of the purchase. Re-validate supplier data first.
    const lines = await pool.query<{ supplier_code: string; supplier_sku: string; qty: number; expected_cost_cents: number }>(
      `SELECT s.code AS supplier_code, pol.supplier_sku, pol.qty, pol.expected_cost_cents FROM purchase_orders po
       JOIN suppliers s ON s.id = po.supplier_id JOIN purchase_order_lines pol ON pol.purchase_order_id = po.id
       WHERE po.order_id = $1 AND po.status = 'awaiting_approval'`, [orderId]);
    if (!lines.rowCount) throw conflict('NO_PURCHASE_REQUEST', 'There is no purchase request awaiting approval for this order');
    for (const l of lines.rows) {
      const [q] = await ctx.connectors.suppliers.get(l.supplier_code)!.checkAvailability([l.supplier_sku]);
      const check = revalidateCost(l.expected_cost_cents, q?.costCents ?? null, q?.qtyAvailable ?? 0, l.qty);
      if (!check.ok) {
        await withTransaction(pool, (c) => setStatus(c, o, 'exception', s.name, `Approval blocked: ${l.supplier_code} ${l.supplier_sku} ${check.reason}`, { reason: check.reason }));
        throw conflict('REVALIDATION_FAILED', `Supplier data changed (${check.reason}). Order moved to Exception.`);
      }
    }
  }

  if (input.to === 'po_submitted') {
    const pos = await pool.query<{ id: string }>(`SELECT id FROM purchase_orders WHERE order_id = $1 AND status = 'approved'`, [orderId]);
    if (!pos.rowCount) throw conflict('NO_APPROVED_PO', 'Approve the purchase request first');
    const jobs = [];
    for (const p of pos.rows) {
      jobs.push((await enqueue(pool, { companyId: s.companyId, type: 'po.submit', payload: { purchaseOrderId: p.id }, idempotencyKey: `po:submit:${p.id}`, createdBy: s.userId })).id);
    }
    await audit(pool, { companyId: s.companyId, userId: s.userId, action: 'po.submit_requested', entityType: 'order', entityId: orderId, detail: { jobs } });
    return { queued: true, jobs };
  }

  await withTransaction(pool, async (c) => {
    const poStatus: Partial<Record<SpecialOrderStatus, string>> = {
      approved: 'approved', supplier_confirmed: 'confirmed', in_transit: 'in_transit', received_at_ubc: 'received',
    };
    if (input.to === 'approved') {
      await c.query(`UPDATE purchase_orders SET status = 'approved', approved_by = $2, approved_at = now(), updated_at = now() WHERE order_id = $1 AND status = 'awaiting_approval'`, [orderId, s.userId]);
    } else if (poStatus[input.to]) {
      await c.query(`UPDATE purchase_orders SET status = $2, tracking = COALESCE($3, tracking), updated_at = now() WHERE order_id = $1 AND status NOT IN ('cancelled')`, [orderId, poStatus[input.to], input.tracking ?? null]);
    }
    if (input.to === 'completed' || input.to === 'cancelled') {
      // Consume (completed) or release (cancelled) the physical reservation for stock lines.
      const stock = await c.query<{ variant_id: string; qty: number }>(`SELECT variant_id, qty FROM order_lines WHERE order_id = $1 AND source = 'ubc_stock' AND variant_id IS NOT NULL`, [orderId]);
      if (o.internal_status !== 'completed') {
        for (const l of stock.rows) {
          await c.query(
            `UPDATE inventory_levels SET reserved = GREATEST(0, reserved - $2), on_hand = on_hand - CASE WHEN $3 THEN $2 ELSE 0 END, updated_at = now() WHERE variant_id = $1`,
            [l.variant_id, l.qty, input.to === 'completed']);
        }
      }
      if (input.to === 'cancelled') {
        const submitted = await c.query(`UPDATE purchase_orders SET status = 'cancelled', updated_at = now() WHERE order_id = $1 AND status IN ('awaiting_approval','approved') RETURNING id`, [orderId]);
        const open = await c.query(`SELECT 1 FROM purchase_orders WHERE order_id = $1 AND status IN ('submitted','confirmed','in_transit')`, [orderId]);
        if (open.rowCount) input.note = `${input.note ?? ''} — NOTE: a PO was already sent to the supplier; request cancellation from the supplier manually.`.trim();
        void submitted;
      }
      if (input.to === 'completed') await c.query(`UPDATE orders SET shopify_fulfillment_status = 'fulfilled' WHERE id = $1`, [orderId]);
    }
    await setStatus(c, o, input.to, s.name, input.note ?? '', { reason: input.reason, tracking: input.tracking });
    await audit(c, { companyId: s.companyId, userId: s.userId, action: `order.${input.to}`, entityType: 'order', entityId: orderId, detail: { from: o.internal_status, note: input.note } });
  });
  return { status: input.to };
}

/** Job: send an approved PO to the supplier via its authorised method. Never runs without an approver on record. */
export async function submitPoJob(ctx: AppContext, companyId: string, poId: string) {
  const po = await ctx.pool.query<{ id: string; po_number: string; status: string; approved_by: string | null; idempotency_key: string; ship_to: 'ubc_store' | 'customer'; order_id: string; code: string }>(
    `SELECT po.*, s.code FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE po.company_id = $1 AND po.id = $2`, [companyId, poId]);
  const p = po.rows[0];
  if (!p) throw notFound('Purchase order');
  if (p.status === 'submitted') return { alreadySubmitted: true };
  if (p.status !== 'approved' || !p.approved_by) throw Object.assign(new Error('PO is not approved by a person'), { code: 'FORBIDDEN' });
  const lines = await ctx.pool.query<{ supplier_sku: string; qty: number; expected_cost_cents: number }>(`SELECT supplier_sku, qty, expected_cost_cents FROM purchase_order_lines WHERE purchase_order_id = $1`, [poId]);
  const conn = ctx.connectors.suppliers.get(p.code);
  if (!conn) throw Object.assign(new Error(`No connector for ${p.code}`), { code: 'NOT_CONFIGURED' });
  const res = await conn.submitPurchaseOrder({
    poNumber: p.po_number, idempotencyKey: p.idempotency_key, shipTo: p.ship_to,
    lines: lines.rows.map((l) => ({ supplierSku: l.supplier_sku, qty: l.qty, expectedCostCents: l.expected_cost_cents })),
  });
  return withTransaction(ctx.pool, async (c) => {
    if (!res.accepted) {
      await c.query(`UPDATE purchase_orders SET status = 'exception', updated_at = now() WHERE id = $1`, [poId]);
      const o = await loadOrder(c, companyId, p.order_id);
      if (o.internal_status !== 'exception') await setStatus(c, o, 'exception', 'system', `Supplier rejected PO: ${res.message}`, { reason: 'po_rejected' });
      return res;
    }
    await c.query(`UPDATE purchase_orders SET status = 'submitted', external_ref = $2, submitted_at = now(), updated_at = now() WHERE id = $1`, [poId, res.externalRef]);
    const remaining = await c.query(`SELECT 1 FROM purchase_orders WHERE order_id = $1 AND status IN ('awaiting_approval','approved')`, [p.order_id]);
    const o = await loadOrder(c, companyId, p.order_id);
    if (!remaining.rowCount && o.internal_status === 'approved') await setStatus(c, o, 'po_submitted', 'system', `${p.code} accepted ${p.po_number} (${res.externalRef})`);
    await audit(c, { companyId, action: 'po.submitted', entityType: 'purchase_order', entityId: poId, detail: res });
    return res;
  });
}

/** Called when a PO submit job is dead (retries exhausted): surface it on the order. */
export async function onPoSubmitDead(ctx: AppContext, companyId: string, poId: string, message: string) {
  await withTransaction(ctx.pool, async (c) => {
    const r = await c.query<{ order_id: string }>(`UPDATE purchase_orders SET status = 'exception', updated_at = now() WHERE id = $1 RETURNING order_id`, [poId]);
    if (!r.rows[0]) return;
    const o = await loadOrder(c, companyId, r.rows[0].order_id);
    if (o.internal_status !== 'exception') await setStatus(c, o, 'exception', 'system', `PO submission failed: ${message}`, { reason: 'connection_error' });
  });
}
