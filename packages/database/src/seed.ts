import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type pg from 'pg';
import { generateDemoDataset } from '@ubc/demo-data';
import { DEFAULT_CAMPAIGN_RULES } from '@ubc/shared';

export interface SeedResult {
  companyId: string;
  users: { email: string; role: string; password: string | null }[];
  variants: number;
}

/**
 * Load the DEMO dataset into an empty company. Refuses to run in LIVE mode
 * and refuses to touch a company that already has data.
 */
export async function seedDemo(pool: pg.Pool, opts: { carlosPassword?: string; adminPassword?: string; products?: number; now?: Date } = {}): Promise<SeedResult> {
  if (process.env.APP_MODE === 'live') throw new Error('Refusing to seed DEMO data while APP_MODE=live');
  const { hashPassword } = await import('./pool.js');
  const ds = generateDemoDataset({ products: opts.products, now: opts.now });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(`SELECT id FROM companies WHERE slug = 'ubc'`);
    if (existing.rowCount) throw new Error('Company "ubc" already exists — reset the database before re-seeding');

    const companyId = (await client.query<{ id: string }>(`INSERT INTO companies (slug, name) VALUES ('ubc', 'University Bicycle Center (DEMO)') RETURNING id`)).rows[0]!.id;
    const storeId = (await client.query<{ id: string }>(`INSERT INTO stores (company_id, name, shopify_shop_domain) VALUES ($1, 'UBC Online (DEMO)', NULL) RETURNING id`, [companyId])).rows[0]!.id;
    const locationId = (await client.query<{ id: string }>(`INSERT INTO locations (company_id, store_id, name, kind) VALUES ($1, $2, 'UBC Main Store', 'physical') RETURNING id`, [companyId, storeId])).rows[0]!.id;

    await client.query(
      `INSERT INTO company_settings (company_id, campaign_rules, availability_rules) VALUES ($1, $2, $3)`,
      [companyId, JSON.stringify(DEFAULT_CAMPAIGN_RULES), JSON.stringify({ physicalSafetyQty: 0, supplierSafetyQty: 2, maxOfferAgeHours: 48, handlingDays: 2 })],
    );

    const gen = () => randomBytes(12).toString('base64url');
    const carlosPw = opts.carlosPassword ?? process.env.SEED_CARLOS_PASSWORD ?? gen();
    const adminPw = opts.adminPassword ?? process.env.SEED_ADMIN_PASSWORD ?? gen();
    const users = [
      { email: 'carlos@ubc.demo', name: 'Carlos Mirabal', role: 'purchasing', pw: carlosPw },
      { email: 'admin@twoit.demo', name: 'TwoIT Admin', role: 'owner', pw: adminPw },
      { email: 'staff@ubc.demo', name: 'Store Staff (demo)', role: 'staff', pw: gen() + gen() },
    ];
    const userIds: Record<string, string> = {};
    for (const u of users) {
      const id = (await client.query<{ id: string }>(`INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id`, [u.email, u.name, await hashPassword(u.pw)])).rows[0]!.id;
      await client.query(`INSERT INTO memberships (user_id, company_id, role) VALUES ($1, $2, $3)`, [id, companyId, u.role]);
      userIds[u.email] = id;
    }

    const supplierIds: Record<string, string> = {};
    for (const s of ds.suppliers) {
      supplierIds[s.code] = (await client.query<{ id: string }>(
        `INSERT INTO suppliers (company_id, code, name, connector, methods, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [companyId, s.code, s.name, s.connector, s.methods, s.notes],
      )).rows[0]!.id;
      await client.query(
        `INSERT INTO supplier_sync_schedules (company_id, supplier_id, stream, interval_minutes, max_silence_hours, last_success_at, last_status)
         VALUES
           ($1, $2, 'availability', 20,   2,  now(), 'succeeded'),
           ($1, $2, 'costs',        540,  24, now(), 'succeeded'),
           ($1, $2, 'content',      1440, 48, now(), 'succeeded'),
           ($1, $2, 'full_catalog', NULL, 48, now(), 'succeeded')
         ON CONFLICT (company_id, supplier_id, stream) DO NOTHING`,
        [companyId, supplierIds[s.code]],
      );
    }

    // Products (one row per productId) then variants, via jsonb_to_recordset for bulk speed.
    const products = new Map<string, (typeof ds.items)[number]>();
    for (const it of ds.items) if (!products.has(it.productId)) products.set(it.productId, it);
    await client.query(
      `INSERT INTO products (company_id, ref, brand, model, category, title, status, map_policy, description)
       SELECT $1, r.ref, r.brand, r.model, r.category, r.title, r.status, r.map_policy, 'Demonstration product — not real UBC inventory.'
       FROM jsonb_to_recordset($2::jsonb) AS r(ref text, brand text, model text, category text, title text, status text, map_policy text)`,
      [companyId, JSON.stringify([...products.values()].map((p) => ({
        ref: p.productId, brand: p.brand, model: p.model, category: p.category,
        title: p.title.replace(/ — .*$/, ''), status: p.status, map_policy: p.mapPolicy,
      })))],
    );
    await client.query(
      `INSERT INTO variants (company_id, product_id, ref, title, sku, upc, mpn, price_cents, cost_cents, map_cents, status, updated_at)
       SELECT $1, p.id, r.ref, r.title, r.sku, r.upc, r.mpn, r.price, r.cost, r.map, r.status, r.updated_at
       FROM jsonb_to_recordset($2::jsonb) AS r(ref text, product_ref text, title text, sku text, upc text, mpn text, price int, cost int, map int, status text, updated_at timestamptz)
       JOIN products p ON p.company_id = $1 AND p.ref = r.product_ref`,
      [companyId, JSON.stringify(ds.items.map((i) => ({
        ref: i.id, product_ref: i.productId, title: i.title, sku: i.sku, upc: i.upc, mpn: i.mpn,
        price: i.priceCents, cost: i.costCents, map: i.mapCents, status: i.status, updated_at: i.updatedAt,
      })))],
    );
    await client.query(
      `INSERT INTO inventory_levels (variant_id, location_id, company_id, on_hand, reserved, source)
       SELECT v.id, $2, $1, r.qty, r.reserved, 'demo'
       FROM jsonb_to_recordset($3::jsonb) AS r(ref text, qty int, reserved int)
       JOIN variants v ON v.company_id = $1 AND v.ref = r.ref`,
      [companyId, locationId, JSON.stringify(ds.items.filter((i) => i.physicalQty > 0 || i.reservedQty > 0).map((i) => ({ ref: i.id, qty: i.physicalQty, reserved: Math.min(i.reservedQty, i.physicalQty) })))],
    );
    await client.query(
      `INSERT INTO external_ids (company_id, entity_type, entity_id, system, external_id)
       SELECT $1, 'variant', v.id, 'lightspeed_r', r.ls
       FROM jsonb_to_recordset($2::jsonb) AS r(ref text, ls text)
       JOIN variants v ON v.company_id = $1 AND v.ref = r.ref
       ON CONFLICT DO NOTHING`,
      [companyId, JSON.stringify(ds.items.filter((i) => i.lightspeedItemId).map((i) => ({ ref: i.id, ls: i.lightspeedItemId })))],
    );
    const offers = ds.items.flatMap((i) => i.offers.map((o) => ({
      ref: i.id, supplier_id: supplierIds[o.supplierCode], sku: o.supplierSku, brand: i.brand, title: i.title, upc: i.upc, mpn: i.mpn,
      cost: o.costCents, qty: o.qtyAvailable, drop: o.dropShip, lead: o.leadDays, reported: o.reportedAt, map: i.mapCents,
    })));
    await client.query(
      `INSERT INTO supplier_offers (company_id, supplier_id, variant_id, supplier_sku, brand, title, upc, mpn, cost_cents, map_cents, qty_available, drop_ship, lead_days, reported_at)
       SELECT $1, r.supplier_id, v.id, r.sku, r.brand, r.title, r.upc, r.mpn, r.cost, r.map, r.qty, r.drop, r.lead, r.reported
       FROM jsonb_to_recordset($2::jsonb) AS r(ref text, supplier_id uuid, sku text, brand text, title text, upc text, mpn text, cost int, map int, qty int, drop boolean, lead int, reported timestamptz)
       JOIN variants v ON v.company_id = $1 AND v.ref = r.ref`,
      [companyId, JSON.stringify(offers)],
    );

    // A few unmatched supplier records that need manual review (dubious equivalence).
    const reviewSamples = ds.items.filter((i) => i.offers.length && i.upc).slice(0, 6);
    for (const [n, i] of reviewSamples.entries()) {
      const offerId = (await client.query<{ id: string }>(
        `INSERT INTO supplier_offers (company_id, supplier_id, supplier_sku, brand, title, upc, mpn, cost_cents, qty_available, reported_at)
         VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, 12, now()) RETURNING id`,
        [companyId, supplierIds[n % 2 ? 'JBI' : 'QBP'], `NEW-${n + 1}-${i.sku}`, i.brand.toUpperCase(), `${i.title} (supplier listing)`, i.mpn, Math.round((i.costCents ?? i.priceCents * 0.6) * 1.01)],
      )).rows[0]!.id;
      await client.query(
        `INSERT INTO match_reviews (company_id, offer_id, candidate_variant_id, score, reasons)
         SELECT $1, $2, v.id, 0.8, '["BRAND_MPN_EQUAL","GTIN_MISSING"]'::jsonb FROM variants v WHERE v.company_id = $1 AND v.ref = $3`,
        [companyId, offerId, i.id],
      );
    }

    for (const o of ds.orders) {
      const orderId = (await client.query<{ id: string }>(
        `INSERT INTO orders (company_id, store_id, shopify_order_id, number, customer_name, fulfillment_method, financial_status, shopify_fulfillment_status, internal_status, is_special_order, total_cents, tracking, created_at, exception_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [companyId, storeId, `demo-${o.id}`, o.number, o.customerName, o.fulfillmentMethod, o.financialStatus, o.shopifyFulfillmentStatus, o.status, o.isSpecialOrder, o.totalCents, o.tracking, o.createdAt, o.status === 'exception' ? 'cost_changed' : null],
      )).rows[0]!.id;
      for (const l of o.lines) {
        const lineId = (await client.query<{ id: string }>(
          `INSERT INTO order_lines (order_id, variant_id, sku, title, qty, price_cents, source, supplier_id, quoted_cost_cents)
           SELECT $1, v.id, $3, $4, $5, $6, $7, $8, $9 FROM variants v WHERE v.company_id = $2 AND v.ref = $10 RETURNING id`,
          [orderId, companyId, l.sku, l.title, l.qty, l.priceCents, l.source, l.supplierCode ? supplierIds[l.supplierCode] : null, l.costCents, l.itemId],
        )).rows[0]!.id;
        const poStatus: Record<string, string> = {
          approved: 'approved', po_submitted: 'submitted', supplier_confirmed: 'confirmed', in_transit: 'in_transit',
          received_at_ubc: 'received', ready_for_pickup: 'received', completed: 'received', exception: 'exception', awaiting_approval: 'awaiting_approval',
        };
        if (l.source === 'supplier' && poStatus[o.status] && l.supplierCode) {
          const poId = (await client.query<{ id: string }>(
            `INSERT INTO purchase_orders (company_id, supplier_id, order_id, po_number, status, ship_to, total_cents, idempotency_key, external_ref, tracking, approved_by, approved_at, submitted_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
            [companyId, supplierIds[l.supplierCode], orderId, `PO-DEMO-${o.id.slice(1)}`, poStatus[o.status], o.fulfillmentMethod === 'ship' ? 'customer' : 'ubc_store',
              (l.costCents ?? 0) * l.qty, `po:${orderId}:${l.supplierCode}`,
              ['submitted', 'confirmed', 'in_transit', 'received', 'exception'].includes(poStatus[o.status]!) ? `${l.supplierCode}-DEMO-${o.id}` : null,
              o.tracking, o.status === 'awaiting_approval' ? null : userIds['carlos@ubc.demo'], o.status === 'awaiting_approval' ? null : o.createdAt,
              ['submitted', 'confirmed', 'in_transit', 'received', 'exception'].includes(poStatus[o.status]!) ? o.createdAt : null],
          )).rows[0]!.id;
          await client.query(
            `INSERT INTO purchase_order_lines (purchase_order_id, order_line_id, supplier_sku, qty, expected_cost_cents)
             SELECT $1, $2, so.supplier_sku, $3, $4 FROM supplier_offers so JOIN variants v ON v.id = so.variant_id
             WHERE so.company_id = $5 AND v.ref = $6 AND so.supplier_id = $7 LIMIT 1`,
            [poId, lineId, l.qty, l.costCents ?? 0, companyId, l.itemId, supplierIds[l.supplierCode]],
          );
        }
      }
      for (const e of o.events) {
        await client.query(`INSERT INTO order_events (order_id, from_status, to_status, actor, note, created_at) VALUES ($1,$2,$3,$4,$5,$6)`, [orderId, e.from, e.to, e.actor, e.note, e.at]);
      }
    }

    await client.query(`INSERT INTO audit_log (company_id, action, detail) VALUES ($1, 'demo.seeded', $2)`, [companyId, JSON.stringify({ variants: ds.items.length, notice: ds.notice })]);
    await client.query('COMMIT');
    return {
      companyId,
      variants: ds.items.length,
      users: users.map((u) => ({
        email: u.email, role: u.role,
        // Only echo passwords we generated; never echo ones provided via env.
        password: u.email === 'carlos@ubc.demo' && (opts.carlosPassword || process.env.SEED_CARLOS_PASSWORD) ? null
          : u.email === 'admin@twoit.demo' && (opts.adminPassword || process.env.SEED_ADMIN_PASSWORD) ? null
          : u.role === 'staff' ? null : u.pw,
      })),
    };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void import('./pool.js').then(({ createPool }) => {
    const pool = createPool();
    return seedDemo(pool)
      .then((r) => {
        console.log(`Seeded DEMO company ${r.companyId} with ${r.variants} variants.`);
        for (const u of r.users) console.log(`  ${u.role.padEnd(10)} ${u.email}${u.password ? `  password: ${u.password}` : ''}`);
        console.log('Store generated passwords in a password manager; they are not shown again.');
      })
      .catch((e) => { console.error(e.message); process.exitCode = 1; })
      .finally(() => pool.end());
  });
}
