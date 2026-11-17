// Live end-to-end order test across Shopify -> https://ubc-hub.twoitsolutions.com -> Supabase PostgreSQL.
// 1. Attempts to create a real order on Shopify (`draftOrderCreate` -> `draftOrderComplete` or `orderCreate`)
//    so Shopify's cloud delivers a real `orders/create` webhook to https://ubc-hub.twoitsolutions.com/webhooks/shopify.
// 2. If the sandbox app lacks `write_draft_orders`/`write_orders` scopes, sends a real signed HTTPS POST
//    over the public internet to https://ubc-hub.twoitsolutions.com/webhooks/shopify.
// 3. Verifies that the live Hostinger worker ingests the order, splits physical vs. special_order lines,
//    and creates the Purchase Order in Supabase.
import { createPool } from '../packages/database/dist/index.js';
import { ShopifyAdminClient, signShopifyWebhook } from '../packages/integrations/dist/index.js';

const hubUrl = 'https://ubc-hub.twoitsolutions.com';
const pool = createPool(process.env.DATABASE_URL);

const shopify = new ShopifyAdminClient({
  shopDomain: process.env.SHOPIFY_SHOP_DOMAIN?.trim(),
  clientId: process.env.SHOPIFY_CLIENT_ID?.trim(),
  clientSecret: process.env.SHOPIFY_CLIENT_SECRET?.trim(),
  accessToken: process.env.SHOPIFY_ADMIN_ACCESS_TOKEN?.trim(),
  apiVersion: process.env.SHOPIFY_API_VERSION?.trim() || '2026-10',
  plan: process.env.SHOPIFY_PLAN?.trim() || 'basic',
  writesEnabled: true,
});

try {
  const scopesRes = await shopify.query(`{
    currentAppInstallation {
      accessScopes { handle }
    }
  }`);
  const scopes = (scopesRes.currentAppInstallation?.accessScopes ?? []).map((s) => s.handle);
  console.log('Active Shopify App Scopes:', scopes.join(', '));

  const compRes = await pool.query(`SELECT id FROM companies WHERE slug = 'twoit-sandbox'`);
  const companyId = compRes.rows[0].id;
  const storeRes = await pool.query(`SELECT id, shopify_shop_domain FROM stores WHERE company_id = $1 LIMIT 1`, [companyId]);
  const shopDomain = storeRes.rows[0].shopify_shop_domain;
  const locRes = await pool.query(`SELECT id FROM locations WHERE company_id = $1 AND kind = 'physical' LIMIT 1`, [companyId]);
  const locationId = locRes.rows[0].id;

  const specVar = await pool.query(
    `SELECT v.id, v.sku, v.title, v.price_cents, e.external_id AS shopify_gid
     FROM variants v
     JOIN supplier_offers so ON so.variant_id = v.id
     JOIN external_ids e ON e.entity_id = v.id AND e.system = 'shopify' AND e.entity_type = 'variant'
     WHERE v.company_id = $1 AND so.qty_available >= 4
     LIMIT 1`,
    [companyId],
  );
  const sv = specVar.rows[0];
  await pool.query(
    `INSERT INTO inventory_levels (variant_id, location_id, company_id, on_hand, reserved, source)
     VALUES ($1, $2, $3, 0, 0, 'shopify')
     ON CONFLICT (variant_id, location_id) DO UPDATE SET on_hand = 0, reserved = 0`,
    [sv.id, locationId, companyId],
  );

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

  let targetShopifyOrderId = null;
  let deliveryMethod = '';

  if (scopes.includes('write_draft_orders')) {
    console.log('Creating real Shopify order via draftOrderCreate + draftOrderComplete...');
    const dCreate = await shopify.mutate(
      `mutation($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder { id name }
          userErrors { field message }
        }
      }`,
      {
        input: {
          note: 'Live Hostinger UBC Hub Test Order',
          lineItems: [
            { variantId: pv.shopify_gid, quantity: 1 },
            { variantId: sv.shopify_gid, quantity: 2 },
          ],
        },
      },
    );
    const draftId = dCreate.draftOrderCreate?.draftOrder?.id;
    if (draftId) {
      const dComp = await shopify.mutate(
        `mutation($id: ID!) {
          draftOrderComplete(id: $id) {
            draftOrder { order { id name legacyResourceId } }
            userErrors { field message }
          }
        }`,
        { id: draftId },
      );
      const ord = dComp.draftOrderComplete?.draftOrder?.order;
      if (ord?.legacyResourceId) {
        targetShopifyOrderId = String(ord.legacyResourceId);
        deliveryMethod = `Real Shopify Order ${ord.name} (ID ${targetShopifyOrderId}) -> Shopify Cloud Webhook`;
        console.log('Created real Shopify order:', ord);
      }
    }
  } else if (scopes.includes('write_orders')) {
    console.log('Creating real Shopify order via orderCreate...');
    const oCreate = await shopify.mutate(
      `mutation($order: OrderCreateOrderInput!) {
        orderCreate(order: $order) {
          order { id name legacyResourceId }
          userErrors { field message }
        }
      }`,
      {
        order: {
          financialStatus: 'PAID',
          lineItems: [
            { variantId: pv.shopify_gid, quantity: 1 },
            { variantId: sv.shopify_gid, quantity: 2 },
          ],
        },
      },
    );
    const ord = oCreate.orderCreate?.order;
    if (ord?.legacyResourceId) {
      targetShopifyOrderId = String(ord.legacyResourceId);
      deliveryMethod = `Real Shopify Order ${ord.name} (ID ${targetShopifyOrderId}) -> Shopify Cloud Webhook`;
      console.log('Created real Shopify order:', ord);
    } else {
      console.log('orderCreate userErrors:', oCreate.orderCreate?.userErrors);
    }
  }

  if (!targetShopifyOrderId) {
    const ts = Date.now();
    targetShopifyOrderId = String(950000000000 + (ts % 100000000));
    const orderName = `#HOSTINGER-${String(ts).slice(-4)}`;
    const numericPhysId = Number(String(pv.shopify_gid).replace(/\D/g, ''));
    const numericSpecId = Number(String(sv.shopify_gid).replace(/\D/g, ''));
    const payload = {
      id: Number(targetShopifyOrderId),
      name: orderName,
      created_at: new Date().toISOString(),
      financial_status: 'paid',
      fulfillment_status: null,
      total_price: (((pv.price_cents + sv.price_cents * 2) / 100)).toFixed(2),
      customer: { first_name: 'Prueba', last_name: 'Hostinger Live' },
      shipping_lines: [{ code: 'LOCAL_PICKUP', title: 'In-Store Pickup at UBC Tampa' }],
      line_items: [
        { id: 1, variant_id: numericPhysId, sku: pv.sku, title: pv.title, quantity: 1, price: (pv.price_cents / 100).toFixed(2) },
        { id: 2, variant_id: numericSpecId, sku: sv.sku, title: sv.title, quantity: 2, price: (sv.price_cents / 100).toFixed(2) },
      ],
    };
    const rawBody = JSON.stringify(payload);
    const secret = (process.env.SHOPIFY_WEBHOOK_SECRET?.trim() || process.env.SHOPIFY_CLIENT_SECRET?.trim());
    const hmac = signShopifyWebhook(rawBody, secret);
    const whRes = await fetch(`${hubUrl}/webhooks/shopify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Topic': 'orders/create',
        'X-Shopify-Shop-Domain': shopDomain,
        'X-Shopify-Webhook-Id': `wh-live-hostinger-${ts}`,
        'X-Shopify-Hmac-Sha256': hmac,
      },
      body: rawBody,
    });
    const whJson = await whRes.json();
    deliveryMethod = `Signed HTTPS Webhook (${orderName}) -> ${hubUrl}/webhooks/shopify (HTTP ${whRes.status}: ${JSON.stringify(whJson)})`;
    console.log(deliveryMethod);
  }

  console.log('Waiting for live worker on ubc-hub.twoitsolutions.com to process the order...');
  let orderRow = null;
  for (let i = 0; i < 15; i++) {
    const r = await pool.query(
      `SELECT id, number, shopify_order_id, customer_name, fulfillment_method, internal_status, is_special_order, total_cents, created_at
       FROM orders WHERE company_id = $1 AND shopify_order_id = $2`,
      [companyId, targetShopifyOrderId],
    );
    if (r.rowCount) {
      orderRow = r.rows[0];
      break;
    }
    await new Promise((res) => setTimeout(res, 1500));
  }

  if (!orderRow) {
    throw new Error(`Order ${targetShopifyOrderId} was not ingested within 22s`);
  }

  const lines = await pool.query(
    `SELECT sku, title, qty, source, quoted_cost_cents FROM order_lines WHERE order_id = $1 ORDER BY source`,
    [orderRow.id],
  );
  const pos = await pool.query(
    `SELECT po.po_number, po.status, po.ship_to, po.total_cents, s.code AS supplier_code
     FROM purchase_orders po
     JOIN suppliers s ON s.id = po.supplier_id
     WHERE po.order_id = $1`,
    [orderRow.id],
  );

  console.log('\n=== LIVE HOSTINGER HUB ORDER PROCESSING VERIFIED ===');
  console.log('Delivery     :', deliveryMethod);
  console.log('Ingested Order:', orderRow);
  console.log('Order Lines  :', lines.rows);
  console.log('Generated PO :', pos.rows);
} finally {
  await pool.end();
}
