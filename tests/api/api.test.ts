import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { createPool, runMigrations, seedDemo, type Pool } from '@ubc/database';
import { signShopifyWebhook } from '@ubc/integrations';
import { buildApp } from '../../apps/api/src/app.js';
import { loadConfig } from '../../apps/api/src/config/env.js';
import type { AppContext } from '../../apps/api/src/services/context.js';
import { drain } from '../../apps/api/src/workers/runner.js';
import { backoffMs } from '../../apps/api/src/services/jobs.js';

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://ubc:ubc_dev@127.0.0.1:5432/ubc_hub_test';
const CARLOS_PW = 'carlos-test-password-123';
const ADMIN_PW = 'admin-test-password-1234';

let pool: Pool;
let app: FastifyInstance;
let ctx: AppContext;

interface Agent { cookie: string; csrf: string }

async function signIn(email: string, password: string): Promise<Agent> {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  expect(r.statusCode).toBe(200);
  const cookie = String(r.headers['set-cookie']).split(';')[0]!;
  return { cookie, csrf: r.json().csrfToken };
}

function call(a: Agent | null, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = {};
  if (a) { headers.cookie = a.cookie; headers['x-csrf-token'] = a.csrf; }
  return app.inject({ method, url, headers, payload: payload as never });
}

let carlos: Agent;
let admin: Agent;

beforeAll(async () => {
  pool = createPool(URL);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await runMigrations(pool, () => {});
  await seedDemo(pool, { carlosPassword: CARLOS_PW, adminPassword: ADMIN_PW });
  const config = loadConfig({ DATABASE_URL: URL, APP_MODE: 'demo', LOG_LEVEL: 'silent' });
  ({ app, ctx } = await buildApp({ pool, config, logger: false }));
  carlos = await signIn('carlos@ubc.demo', CARLOS_PW);
  admin = await signIn('admin@twoit.demo', ADMIN_PW);
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe('auth & security', () => {
  it('rejects anonymous and bad credentials', async () => {
    expect((await call(null, 'GET', '/api/items')).statusCode).toBe(401);
    const bad = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'carlos@ubc.demo', password: 'wrong-password' } });
    expect(bad.statusCode).toBe(401);
  });

  it('identifies Carlos Mirabal with the purchasing role', async () => {
    const me = (await call(carlos, 'GET', '/api/auth/me')).json();
    expect(me.user.name).toBe('Carlos Mirabal');
    expect(me.user.role).toBe('purchasing');
    expect(me.mode).toBe('demo');
  });

  it('requires a CSRF token on writes', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/campaigns', headers: { cookie: carlos.cookie }, payload: {} });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('CSRF');
  });

  it('sets security and noindex headers', async () => {
    const r = await call(carlos, 'GET', '/api/system');
    expect(r.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(r.headers['x-frame-options']).toBe('DENY');
  });

  it('refuses LIVE mode without explicit acknowledgement', () => {
    expect(() => loadConfig({ DATABASE_URL: URL, APP_MODE: 'live' })).toThrow(/LIVE_MODE_ACK/);
  });
});

describe('catalog', () => {
  it('filters, paginates and returns separated availability', async () => {
    const r = (await call(carlos, 'GET', '/api/items?categories=Accessories&limit=20&sort=price&dir=desc')).json();
    expect(r.total).toBeGreaterThan(500);
    expect(r.items).toHaveLength(20);
    expect(r.items.every((i: { category: string }) => i.category === 'Accessories')).toBe(true);
    expect(r.items[0].priceCents).toBeGreaterThanOrEqual(r.items[19].priceCents);
    const virt = (await call(carlos, 'GET', '/api/items?stock=virtual_only&limit=5')).json();
    for (const i of virt.items) {
      expect(i.availability.status).toBe('special_order');
      expect(i.availability.sellablePhysical).toBe(0);
      expect(i.availability.shopify.publishedQty).toBe(0);
    }
  });

  it('blocks a manual price under MAP and enforces optimistic locking', async () => {
    const list = (await call(carlos, 'GET', '/api/items?categories=Electric%20Bikes&limit=1')).json();
    const it0 = list.items[0];
    expect(it0.mapCents).not.toBeNull();
    const below = await call(carlos, 'PATCH', `/api/items/${it0.id}/price`, { priceCents: it0.mapCents - 100, version: it0.version });
    expect(below.statusCode).toBe(422);
    expect(below.json().details.reasons).toContain('MAP_VIOLATION');
    const stale = await call(carlos, 'PATCH', `/api/items/${it0.id}/price`, { priceCents: it0.priceCents + 100, version: it0.version - 1 });
    expect(stale.statusCode).toBe(409);
  });
});

describe('Black Friday campaign', () => {
  let campaignId: string;
  let token: string;

  it('previews 20 % off Accessories with margins, MAP blocks and exclusions', async () => {
    const r = await call(carlos, 'POST', '/api/campaigns', {
      name: 'Black Friday Accessories (test)', channel: 'online_and_pos',
      selection: { categories: ['Accessories'] },
      adjustment: { type: 'percent_off', value: 0.2, rounding: 'none' },
      startsAt: null, endsAt: null,
    });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    campaignId = body.id;
    token = body.previewToken;
    expect(body.summary.total).toBeGreaterThan(500);
    expect(body.summary.blocked).toBeGreaterThan(0); // MAP-protected accessories
    expect(body.summary.ok + body.summary.warning).toBeGreaterThan(0);
    expect(body.strategy).toBe('variant_price_update'); // POS channel => price rewrite
    const blocked = (await call(carlos, 'GET', `/api/campaigns/${campaignId}/lines?status=blocked&limit=5`)).json();
    expect(blocked.lines[0].reasons.length).toBeGreaterThan(0);
  });

  it('cannot be approved by staff or with a stale preview', async () => {
    expect((await call(admin, 'POST', `/api/campaigns/${campaignId}/approve`, { previewToken: 'deadbeefdeadbeef' })).statusCode).toBe(409);
  });

  it('applies only compliant lines, then restores without overwriting later edits', async () => {
    const appr = await call(carlos, 'POST', `/api/campaigns/${campaignId}/approve`, { previewToken: token });
    expect(appr.statusCode).toBe(200);
    await drain(ctx);
    const camp = (await call(carlos, 'GET', `/api/campaigns/${campaignId}`)).json();
    expect(camp.status).toBe('active');

    const okLine = (await call(carlos, 'GET', `/api/campaigns/${campaignId}/lines?status=ok&limit=2`)).json().lines;
    const blockedLine = (await call(carlos, 'GET', `/api/campaigns/${campaignId}/lines?status=blocked&limit=1`)).json().lines[0];
    const a = (await call(carlos, 'GET', `/api/items/${okLine[0].variant_id}`)).json().item;
    const b = (await call(carlos, 'GET', `/api/items/${okLine[1].variant_id}`)).json().item;
    const blk = (await call(carlos, 'GET', `/api/items/${blockedLine.variant_id}`)).json().item;
    expect(a.priceCents).toBe(okLine[0].new_price_cents);
    expect(blk.priceCents).toBe(blockedLine.old_price_cents); // MAP line untouched

    // POS update was simulated (DEMO), never sent to a real Lightspeed.
    const integ = (await call(carlos, 'GET', '/api/integrations')).json();
    expect(integ.integrations.every((i: { status: string }) => i.status === 'demo_adapter')).toBe(true);
    expect(integ.demoCalls.some((c: { op: string }) => c.op.includes('updatePrices'))).toBe(true);

    // Someone legitimately edits item b during the campaign.
    const edited = b.priceCents + 500;
    expect((await call(carlos, 'PATCH', `/api/items/${b.id}/price`, { priceCents: edited, version: b.version })).statusCode).toBe(200);

    expect((await call(carlos, 'POST', `/api/campaigns/${campaignId}/restore`, {})).statusCode).toBe(200);
    await drain(ctx);
    const a2 = (await call(carlos, 'GET', `/api/items/${a.id}`)).json().item;
    const b2 = (await call(carlos, 'GET', `/api/items/${b.id}`)).json().item;
    expect(a2.priceCents).toBe(okLine[0].old_price_cents);
    expect(b2.priceCents).toBe(edited);
    expect((await call(carlos, 'GET', `/api/campaigns/${campaignId}`)).json().status).toBe('restored');
    const csv = await call(carlos, 'GET', `/api/campaigns/${campaignId}/export.csv`);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body).toContain('skipped_changed');
  });

  it('only owner/admin can record MAP exceptions', async () => {
    const item = (await call(carlos, 'GET', '/api/items?categories=Electric%20Bikes&limit=1')).json().items[0];
    const payload = { itemId: item.id, approvedBy: 'Vendor rep (demo)', reference: 'EMAIL-2026-11-01', validUntil: new Date(Date.now() + 86400000).toISOString() };
    expect((await call(carlos, 'POST', '/api/map-exceptions', payload)).statusCode).toBe(403);
    expect((await call(admin, 'POST', '/api/map-exceptions', payload)).statusCode).toBe(201);
  });
});

describe('special orders end to end', () => {
  it('Shopify order for a supplier-only item goes through review, approval, PO and tracking', async () => {
    const virt = (await call(carlos, 'GET', '/api/items?stock=virtual_only&categories=Bikes&limit=1')).json().items[0];
    const co = await call(carlos, 'POST', '/api/demo/checkout', { lines: [{ itemId: virt.id, qty: 1 }], method: 'pickup', customerName: 'Test' });
    expect(co.statusCode).toBe(202);
    await drain(ctx);
    const orders = (await call(carlos, 'GET', `/api/orders?q=${encodeURIComponent(co.json().orderNumber)}`)).json().orders;
    expect(orders).toHaveLength(1);
    const id = orders[0].id;
    let d = (await call(carlos, 'GET', `/api/orders/${id}`)).json();
    expect(d.order.is_special_order).toBe(true);
    expect(d.order.internal_status).toBe('awaiting_approval');
    expect(d.purchaseOrders[0].status).toBe('awaiting_approval');

    // Physical stock was not touched for a supplier line.
    const after = (await call(carlos, 'GET', `/api/items/${virt.id}`)).json().item;
    expect(after.reservedQty).toBe(virt.reservedQty);

    const staff = await signInStaff();
    expect((await call(staff, 'POST', `/api/orders/${id}/transition`, { to: 'approved' })).statusCode).toBe(403);
    expect((await call(carlos, 'POST', `/api/orders/${id}/transition`, { to: 'approved' })).statusCode).toBe(200);
    const sub = await call(carlos, 'POST', `/api/orders/${id}/transition`, { to: 'po_submitted' });
    expect(sub.statusCode).toBe(202);
    await drain(ctx);
    d = (await call(carlos, 'GET', `/api/orders/${id}`)).json();
    expect(d.order.internal_status).toBe('po_submitted');
    expect(d.purchaseOrders[0].external_ref).toMatch(/DEMO/);
    expect(d.purchaseOrders[0].approved_by_name).toBe('Carlos Mirabal');

    for (const to of ['supplier_confirmed', 'in_transit', 'received_at_ubc', 'ready_for_pickup', 'completed']) {
      const r = await call(carlos, 'POST', `/api/orders/${id}/transition`, { to, tracking: to === 'in_transit' ? 'TRK-1' : undefined });
      expect(r.statusCode, `${to}: ${r.body}`).toBe(200);
    }
    // Pickup orders cannot be "shipped"; exceptions need a reason.
    d = (await call(carlos, 'GET', `/api/orders/${id}`)).json();
    expect(d.order.tracking).toBe('TRK-1');
    expect(d.events.map((e: { to_status: string }) => e.to_status)).toContain('ready_for_pickup');
    expect((await call(carlos, 'POST', `/api/orders/${id}/transition`, { to: 'exception', note: 'x' })).statusCode).toBe(422);
  });

  it('stock orders reserve and then consume physical units', async () => {
    const stock = (await call(carlos, 'GET', '/api/items?stock=physical&categories=Accessories&limit=1')).json().items[0];
    await call(carlos, 'POST', '/api/demo/checkout', { lines: [{ itemId: stock.id, qty: 1 }], method: 'pickup', customerName: 'Stock' });
    await drain(ctx);
    const reserved = (await call(carlos, 'GET', `/api/items/${stock.id}`)).json().item;
    expect(reserved.reservedQty).toBe(stock.reservedQty + 1);
    expect(reserved.physicalQty).toBe(stock.physicalQty);
    const o = (await call(carlos, 'GET', '/api/orders?special=false&q=DEMO')).json().orders.find((x: { internal_status: string }) => x.internal_status === 'received_at_ubc');
    await call(carlos, 'POST', `/api/orders/${o.id}/transition`, { to: 'ready_for_pickup' });
    await call(carlos, 'POST', `/api/orders/${o.id}/transition`, { to: 'completed' });
    const done = (await call(carlos, 'GET', `/api/items/${stock.id}`)).json().item;
    expect(done.physicalQty).toBe(stock.physicalQty - 1);
    expect(done.reservedQty).toBe(stock.reservedQty);
  });

  it('webhooks: invalid signatures rejected, redeliveries are idempotent', async () => {
    const payload = JSON.stringify({ id: 'wh-1', name: '#WH-1', created_at: new Date().toISOString(), line_items: [] });
    const headers = (sig: string) => ({ 'content-type': 'application/json', 'x-shopify-topic': 'orders/create', 'x-shopify-webhook-id': 'wh-dup-1', 'x-shopify-hmac-sha256': sig });
    expect((await app.inject({ method: 'POST', url: '/webhooks/shopify', headers: headers('bad'), payload })).statusCode).toBe(401);
    const sig = signShopifyWebhook(payload, ctx.config.env.DEMO_WEBHOOK_SECRET);
    const first = await app.inject({ method: 'POST', url: '/webhooks/shopify', headers: headers(sig), payload });
    const second = await app.inject({ method: 'POST', url: '/webhooks/shopify', headers: headers(sig), payload });
    expect(first.json().ok).toBe(true);
    expect(second.json().duplicate).toBe(true);
  });

  it('a PO that keeps failing ends as an exception with errors logged', async () => {
    const virt = (await call(carlos, 'GET', '/api/items?stock=virtual_only&suppliers=QBP&limit=3')).json().items[2];
    const co = await call(carlos, 'POST', '/api/demo/checkout', { lines: [{ itemId: virt.id, qty: 1 }], method: 'ship', customerName: 'Fail' });
    await drain(ctx);
    const o = (await call(carlos, 'GET', `/api/orders?q=${encodeURIComponent(co.json().orderNumber)}`)).json().orders[0];
    expect((await call(carlos, 'POST', `/api/orders/${o.id}/transition`, { to: 'approved' })).statusCode).toBe(200);
    const d0 = (await call(carlos, 'GET', `/api/orders/${o.id}`)).json();
    const supplier = ctx.connectors.suppliers.get(d0.purchaseOrders[0].supplier_code) as unknown as { failNext: number };
    supplier.failNext = 10;
    await call(carlos, 'POST', `/api/orders/${o.id}/transition`, { to: 'po_submitted' });
    await pool.query(`UPDATE jobs SET max_attempts = 2 WHERE type = 'po.submit' AND status = 'queued'`);
    await drain(ctx); // attempt 1 fails -> requeued with backoff
    await pool.query(`UPDATE jobs SET run_at = now() WHERE type = 'po.submit' AND status = 'queued'`);
    await drain(ctx); // attempt 2 fails -> dead
    supplier.failNext = 0;
    const d = (await call(carlos, 'GET', `/api/orders/${o.id}`)).json();
    expect(d.order.internal_status).toBe('exception');
    expect(d.order.exception_reason).toBe('connection_error');
    const errs = (await call(carlos, 'GET', '/api/errors')).json().errors;
    expect(errs.some((e: { source: string }) => e.source === 'job:po.submit')).toBe(true);
    const jobs = (await call(carlos, 'GET', '/api/jobs?status=dead')).json().jobs;
    expect(jobs.length).toBeGreaterThan(0);
    expect(backoffMs(1)).toBe(10000);
    expect(backoffMs(10)).toBe(3600000);
  });
});

describe('bulk operations and suppliers', () => {
  it('hides a whole category through a background job', async () => {
    const r = await call(carlos, 'POST', '/api/items/bulk-status', { filter: { categories: ['Apparel'] }, status: 'hidden' });
    expect(r.statusCode).toBe(202);
    await drain(ctx);
    const job = (await call(carlos, 'GET', `/api/jobs/${r.json().jobId}`)).json();
    expect(job.status).toBe('succeeded');
    const pub = (await call(carlos, 'GET', '/api/items?categories=Apparel&status=published&limit=1')).json();
    expect(pub.total).toBe(0);
  });

  it('imports a supplier feed: auto-matches by GTIN, sends doubtful ones to review', async () => {
    const it0 = (await call(carlos, 'GET', '/api/items?categories=Parts&limit=1')).json().items[0];
    const csv = [
      'Item,Brand,Description,UPC,MPN,Cost,Qty',
      `NEWQ-1,${it0.brand},"${it0.title}",${it0.upc ?? ''},${it0.mpn},12.00,30`,
      `NEWQ-2,${it0.brand},"Different listing",,${it0.mpn},11.00,4`,
      'NEWQ-3,Unknown,"Totally new thing",,,5.00,9',
    ].join('\n');
    const r = await call(carlos, 'POST', '/api/suppliers/QBP/import', { csv, mapping: { supplierSku: 'Item', brand: 'Brand', title: 'Description', upc: 'UPC', mpn: 'MPN', cost: 'Cost', qty: 'Qty' } });
    expect(r.statusCode).toBe(202);
    await drain(ctx);
    const job = (await call(carlos, 'GET', `/api/jobs/${r.json().jobId}`)).json();
    expect(job.status).toBe('succeeded');
    expect(job.result).toMatchObject({ upserted: 3, unmatched: 1 });
    expect(job.result.autoMatched + job.result.review).toBe(2);
    const reviews = (await call(carlos, 'GET', '/api/match-reviews')).json().reviews;
    expect(reviews.length).toBeGreaterThan(0);
    expect((await call(carlos, 'POST', `/api/match-reviews/${reviews[0].id}/resolve`, { decision: 'rejected' })).statusCode).toBe(200);
  });

  it('dashboard aggregates the state', async () => {
    const d = (await call(carlos, 'GET', '/api/dashboard')).json();
    expect(d.counts.total).toBe(2853);
    expect(d.counts.physical + d.counts.virtualOnly + d.counts.unavailable).toBe(2853);
    expect(d.counts.orders).toBeGreaterThan(12);
    expect(d.counts.deadJobs).toBeGreaterThan(0);
  });
});

async function signInStaff(): Promise<Agent> {
  const { hashPassword } = await import('@ubc/database');
  await pool.query(`UPDATE users SET password_hash = $1 WHERE email = 'staff@ubc.demo'`, [await hashPassword('staff-test-password-1')]);
  return signIn('staff@ubc.demo', 'staff-test-password-1');
}
