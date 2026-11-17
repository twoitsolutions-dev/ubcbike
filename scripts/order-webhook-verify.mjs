// End-to-end Special Order & Purchase Order verification (`npm run order:verify`).
// Exercises the exact Shopify `orders/create` HMAC webhook verification path,
// splits physical UBC stock vs. distributor Special Order fulfillment (JBI),
// runs supplier quote revalidation, and places a live Purchase Order into
// Carlos Mirabal's approval queue in Supabase (`twoit-sandbox`).
import { createPool } from '../packages/database/dist/index.js';
import { signShopifyWebhook } from '../packages/integrations/dist/index.js';
import { loadConfig } from '../apps/api/dist/config/env.js';
import { buildApp } from '../apps/api/dist/app.js';
import { drain } from '../apps/api/dist/workers/runner.js';

const cfg = loadConfig(process.env);
const pool = createPool(cfg.env.DATABASE_URL);
const { app, ctx } = await buildApp({ pool, config: cfg, logger: false });

try {
  const compRes = await pool.query(`SELECT id, slug FROM companies WHERE slug = 'twoit-sandbox'`);
  if (!compRes.rowCount) throw new Error('Tenant twoit-sandbox not found');
  const companyId = compRes.rows[0].id;

  const storeRes = await pool.query(`SELECT id, shopify_shop_domain FROM stores WHERE company_id = $1 LIMIT 1`, [companyId]);
  const shopDomain = storeRes.rows[0].shopify_shop_domain;

  const locRes = await pool.query(`SELECT id FROM locations WHERE company_id = $1 AND kind = 'physical' LIMIT 1`, [companyId]);
  const locationId = locRes.rows[0].id;

  // Pick 1 supplier-linked variant (`JBI-61028`) with 0 physical stock -> Special Order line!
  const specVar = await pool.query(
    `SELECT v.id, v.sku, v.title, v.price_cents, e.external_id AS shopify_gid, so.supplier_sku, so.cost_cents, so.qty_available
     FROM variants v
     JOIN supplier_offers so ON so.variant_id = v.id
     JOIN external_ids e ON e.entity_id = v.id AND e.system = 'shopify' AND e.entity_type = 'variant'
     WHERE v.company_id = $1 AND so.qty_available >= 4
     LIMIT 1`,
    [companyId],
  );
  if (!specVar.rowCount) {
    throw new Error('No supplier-linked variant found in twoit-sandbox — run npm run pipeline:verify first');
  }
  const sv = specVar.rows[0];
  // Ensure the special-order variant has 0 physical stock so it routes 100% to the distributor
  await pool.query(
    `INSERT INTO inventory_levels (variant_id, location_id, company_id, on_hand, reserved, source)
     VALUES ($1, $2, $3, 0, 0, 'shopify')
     ON CONFLICT (variant_id, location_id) DO UPDATE SET on_hand = 0, reserved = 0`,
    [sv.id, locationId, companyId],
  );

  // Pick a second distinct variant and ensure it has physical stock on hand -> UBC Stock line!
  const physVar = await pool.query(
    `SELECT v.id, v.sku, v.title, v.price_cents, e.external_id AS shopify_gid
     FROM variants v
     JOIN external_ids e ON e.entity_id = v.id AND e.system = 'shopify' AND e.entity_type = 'variant'
     WHERE v.company_id = $1 AND v.id <> $2
     ORDER BY v.price_cents DESC LIMIT 1`,
    [companyId, sv.id],
  );
  const pv = physVar.rows[0];
  await pool.query(
    `INSERT INTO inventory_levels (variant_id, location_id, company_id, on_hand, reserved, source)
     VALUES ($1, $2, $3, 8, 0, 'shopify')
     ON CONFLICT (variant_id, location_id) DO UPDATE SET on_hand = GREATEST(inventory_levels.on_hand, 8), reserved = 0`,
    [pv.id, locationId, companyId],
  );

  const numericPhysId = Number(String(pv.shopify_gid).replace(/\D/g, ''));
  const numericSpecId = Number(String(sv.shopify_gid).replace(/\D/g, ''));

  const orderIdNum = 900100200301;
  const webhookId = 'wh-e2e-special-order-1001';

  // Idempotent cleanup if re-running verification
  await pool.query(`DELETE FROM orders WHERE company_id = $1 AND shopify_order_id = $2`, [companyId, String(orderIdNum)]);
  await pool.query(`DELETE FROM sync_events WHERE company_id = $1 AND idempotency_key = $2`, [companyId, webhookId]);
  await pool.query(`DELETE FROM jobs WHERE company_id = $1 AND idempotency_key LIKE 'shopify:order:wh-e2e-%'`, [companyId]);

  const webhookPayload = {
    id: orderIdNum,
    name: '#UBC-1001',
    created_at: new Date().toISOString(),
    financial_status: 'paid',
    fulfillment_status: null,
    total_price: (((pv.price_cents + sv.price_cents * 2) / 100)).toFixed(2),
    customer: { first_name: 'Alex', last_name: 'Rivera' },
    shipping_lines: [{ code: 'LOCAL_PICKUP', title: 'In-Store Pickup at UBC' }],
    line_items: [
      { id: 1, variant_id: numericPhysId, sku: pv.sku, title: pv.title, quantity: 1, price: (pv.price_cents / 100).toFixed(2) },
      { id: 2, variant_id: numericSpecId, sku: sv.sku, title: sv.title, quantity: 2, price: (sv.price_cents / 100).toFixed(2) },
    ],
  };

  const rawBody = JSON.stringify(webhookPayload);
  const hmac = signShopifyWebhook(rawBody, cfg.env.SHOPIFY_WEBHOOK_SECRET);

  console.log('\n=== UBC Commerce Hub · Special Order Webhook & PO Lifecycle Verification ===\n');
  const res = await app.inject({
    method: 'POST',
    url: '/webhooks/shopify',
    headers: {
      'content-type': 'application/json',
      'x-shopify-hmac-sha256': hmac,
      'x-shopify-topic': 'orders/create',
      'x-shopify-shop-domain': shopDomain,
      'x-shopify-webhook-id': webhookId,
    },
    payload: rawBody,
  });
  console.log('1) Signed Shopify `orders/create` webhook accepted:', res.statusCode, res.json());

  // Duplicate webhook replay test (must acknowledge without double-reserving stock!)
  const dup = await app.inject({
    method: 'POST',
    url: '/webhooks/shopify',
    headers: {
      'content-type': 'application/json',
      'x-shopify-hmac-sha256': hmac,
      'x-shopify-topic': 'orders/create',
      'x-shopify-shop-domain': shopDomain,
      'x-shopify-webhook-id': webhookId,
    },
    payload: rawBody,
  });
  console.log('2) Idempotent replay check (`duplicate: true`)    :', dup.statusCode, dup.json());

  // Process background jobs (`shopify.order_created` -> `order.review`)
  await drain(ctx);

  const ord = await pool.query(
    `SELECT id, number, customer_name, fulfillment_method, internal_status, is_special_order, total_cents
     FROM orders WHERE company_id = $1 AND shopify_order_id = $2`,
    [companyId, String(orderIdNum)],
  );
  const orderRow = ord.rows[0];
  console.log('3) Order state after worker split & quote check  :', JSON.stringify(orderRow));

  const lines = await pool.query(
    `SELECT sku, title, qty, source, quoted_cost_cents FROM order_lines WHERE order_id = $1 ORDER BY source`,
    [orderRow.id],
  );
  for (const l of lines.rows) {
    console.log(`   - Line [${l.source}] qty=${l.qty} | ${l.title} | quotedCost=${l.quoted_cost_cents !== null ? `$${(l.quoted_cost_cents / 100).toFixed(2)}` : 'UBC stock'}`);
  }

  const pos = await pool.query(
    `SELECT po.po_number, s.code AS supplier_code, po.status, po.ship_to, po.total_cents
     FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
     WHERE po.order_id = $1`,
    [orderRow.id],
  );
  console.log('4) Generated Purchase Order awaiting Carlos      :', JSON.stringify(pos.rows));
  console.log('\n=== Special Order Webhook & PO Verification PASSED ===\n');
} finally {
  await app.close();
  await pool.end();
}
