// DEMO driver: runs entirely in the browser with fictitious data.
// It reuses the exact business-rules package the API uses (compiled to ES2020),
// so MAP, margin, availability and order-state rules behave identically.
// Persistence: only *changes* are stored (safe localStorage wrapper); the
// catalog itself is regenerated deterministically on each load.

import * as R from '../vendor/business-rules/index.js';
import { generateDemoDataset, DEMO_NOTICE } from '../vendor/demo-data/index.js';
import { ROLE_PERMISSIONS, DEFAULT_CAMPAIGN_RULES } from '../vendor/shared/index.js';
import { mapFeed } from '../vendor/csv.js';
import { safeStorage } from '../ui/dom.js';
import { ApiError } from './http.js';

const KEY = 'ubc-demo-state-v1';
const USERS = [
  { id: 'u-carlos', name: 'Carlos Mirabal', email: 'carlos@ubc.demo', role: 'purchasing' },
  { id: 'u-admin', name: 'TwoIT Admin', email: 'admin@twoit.demo', role: 'owner' },
  { id: 'u-staff', name: 'Store Staff (demo)', email: 'staff@ubc.demo', role: 'staff' },
];
const SUPPLIER_HEALTH_MISSING = {
  QBP: ['Paste UBC QBP_API_KEY & QBP_ACCOUNT_NUMBER into .env', 'Confirm QBP image/description republication scope'],
  JBI: ['Paste UBC JBI_ACCOUNT_NUMBER & SFTP/feed credentials into .env', 'Confirm JBI feed column mapping'],
  SPECIALIZED: ['Paste UBC SPECIALIZED_DEALER_ID & B2B credential into .env', 'Verify Click & Collect bike categories & MAP rules'],
};

function inferPosEventType(name, explicit) {
  if (explicit) return explicit;
  const n = String(name || '').toLowerCase();
  if (n.indexOf('black friday') >= 0 || n.indexOf('cyber') >= 0) return 'black_friday';
  if (n.indexOf('christmas') >= 0 || n.indexOf('holiday') >= 0 || n.indexOf('xmas') >= 0) return 'christmas';
  if (n.indexOf('clearance') >= 0) return 'annual_clearance';
  return 'special_event';
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (status, code, message, details) => { throw new ApiError(status, { error: code, message, details }); };
const clone = (o) => JSON.parse(JSON.stringify(o));
const nowIso = () => new Date().toISOString();

function freshState() {
  return {
    v: 1, seq: 1, userId: null, overrides: {}, campaigns: [], orders: null, purchaseOrders: [], jobs: [], errors: [], audit: [],
    priceHistory: [], mapExceptions: [], importedOffers: [], reviews: null, demoCalls: [], simulateOutage: false,
    settings: { campaignRules: Object.assign({}, DEFAULT_CAMPAIGN_RULES), availability: Object.assign({}, R.DEFAULT_AVAILABILITY) },
  };
}

export function createDemoDriver() {
  const ds = generateDemoDataset({ now: new Date() });
  const itemsById = new Map(ds.items.map((i) => [i.id, i]));
  let state = freshState();
  let storageOk = true;
  try {
    const raw = safeStorage.get(KEY);
    if (raw) state = Object.assign(freshState(), JSON.parse(raw));
  } catch (e) { state = freshState(); }
  if (!state.orders) state.orders = seedOrders();
  if (!state.reviews) state.reviews = seedReviews();
  applyOverrides();

  function save() {
    // Cap history so storage never grows without bound.
    state.audit = state.audit.slice(0, 300);
    state.priceHistory = state.priceHistory.slice(0, 1500);
    state.jobs = state.jobs.slice(0, 200);
    state.demoCalls = state.demoCalls.slice(0, 100);
    storageOk = safeStorage.set(KEY, JSON.stringify(state));
  }
  function id(prefix) { state.seq += 1; return prefix + '-' + Date.now().toString(36) + '-' + state.seq; }
  function user() { const u = USERS.find((x) => x.id === state.userId); if (!u) fail(401, 'UNAUTHENTICATED', 'Sign in required'); return u; }
  function can(p) { const u = user(); if (ROLE_PERMISSIONS[u.role].indexOf(p) < 0) fail(403, 'FORBIDDEN', 'Your role (' + u.role + ') cannot perform this action (' + p + ')'); return u; }
  function audit(action, entityType, entityId, detail) {
    const u = USERS.find((x) => x.id === state.userId);
    state.audit.unshift({ id: state.seq++, action, entity_type: entityType || null, entity_id: entityId || null, detail: detail || {}, created_at: nowIso(), actor: u ? u.name : 'system' });
  }
  function logError(source, message, context, jobId) {
    state.errors.unshift({ id: state.seq++, source, message, context: context || {}, job_id: jobId || null, resolved_at: null, created_at: nowIso() });
  }
  function demoCall(system, op, detail) { state.demoCalls.unshift({ system, op, at: nowIso(), detail }); }

  function applyOverrides() {
    Object.keys(state.overrides).forEach((k) => { const it = itemsById.get(k); if (it) Object.assign(it, state.overrides[k]); });
  }
  function patchItem(it, patch) {
    Object.assign(it, patch, { version: it.version + 1, updatedAt: nowIso() });
    state.overrides[it.id] = Object.assign(state.overrides[it.id] || {}, patch, { version: it.version, updatedAt: it.updatedAt });
  }
  function avail(it) { return R.computeAvailability(it, state.settings.availability); }
  function allOffers() {
    const out = [];
    ds.items.forEach((it) => it.offers.forEach((o) => out.push({ o, it })));
    return out;
  }

  function seedOrders() {
    return ds.orders.map((o) => ({
      id: o.id, number: o.number, customer_name: o.customerName, fulfillment_method: o.fulfillmentMethod, financial_status: o.financialStatus,
      shopify_fulfillment_status: o.shopifyFulfillmentStatus, internal_status: o.status, is_special_order: o.isSpecialOrder,
      exception_reason: o.status === 'exception' ? 'cost_changed' : null, total_cents: o.totalCents, tracking: o.tracking, created_at: o.createdAt,
      lines: o.lines.map((l, i) => ({ id: o.id + '-l' + i, variant_id: l.itemId, sku: l.sku, title: l.title, qty: l.qty, price_cents: l.priceCents, source: l.source, supplier_code: l.supplierCode, quoted_cost_cents: l.costCents })),
      events: o.events.map((e, i) => ({ id: i + 1, from_status: e.from, to_status: e.to, actor: e.actor, note: e.note, created_at: e.at })),
      pos: [],
    })).map((o) => {
      const map = { approved: 'approved', po_submitted: 'submitted', supplier_confirmed: 'confirmed', in_transit: 'in_transit', received_at_ubc: 'received', ready_for_pickup: 'received', completed: 'received', exception: 'exception', awaiting_approval: 'awaiting_approval' };
      const l = o.lines[0];
      if (l.source === 'supplier' && map[o.internal_status]) {
        const sent = ['submitted', 'confirmed', 'in_transit', 'received', 'exception'].indexOf(map[o.internal_status]) >= 0;
        const it = itemsById.get(l.variant_id);
        const off = it && it.offers.find((x) => x.supplierCode === l.supplier_code);
        state.purchaseOrders.push({
          id: 'po-' + o.id, po_number: 'PO-DEMO-' + o.id.slice(1), order_id: o.id, status: map[o.internal_status], supplier_code: l.supplier_code,
          ship_to: o.fulfillment_method === 'ship' ? 'customer' : 'ubc_store', total_cents: (l.quoted_cost_cents || 0) * l.qty,
          external_ref: sent ? l.supplier_code + '-DEMO-' + o.id : null, tracking: o.tracking, created_at: o.created_at,
          approved_by: o.internal_status === 'awaiting_approval' ? null : 'Carlos Mirabal', approved_at: o.internal_status === 'awaiting_approval' ? null : o.created_at,
          submitted_at: sent ? o.created_at : null, idempotency_key: 'po:' + o.id, lines: [{ supplier_sku: off ? off.supplierSku : '?', qty: l.qty, expected_cost_cents: l.quoted_cost_cents || 0 }],
        });
      }
      return o;
    });
  }

  function seedReviews() {
    return ds.items.filter((i) => i.offers.length && i.upc).slice(0, 6).map((i, n) => ({
      id: 'mr-' + (n + 1), score: 0.8, reasons: ['BRAND_MPN_EQUAL', 'GTIN_MISSING'], status: 'pending', created_at: nowIso(),
      supplier_code: n % 2 ? 'JBI' : 'QBP', supplier_sku: 'NEW-' + (n + 1) + '-' + i.sku, offer_title: i.title + ' (supplier listing)',
      offer_brand: i.brand.toUpperCase(), offer_upc: null, offer_mpn: i.mpn, candidate_id: i.id, candidate_sku: i.sku, candidate_title: i.title,
      candidate_upc: i.upc, candidate_mpn: i.mpn,
    }));
  }

  function toFilter(q) {
    const list = (v) => (Array.isArray(v) ? v : typeof v === 'string' && v ? v.split(',') : undefined);
    const num = (v) => (v === undefined || v === '' || v === null ? undefined : Number(v));
    return {
      q: q.q || undefined, ids: q.ids, categories: list(q.categories), brands: list(q.brands), suppliers: list(q.suppliers),
      priceMinCents: num(q.priceMinCents), priceMaxCents: num(q.priceMaxCents), marginMinPct: num(q.marginMinPct), marginMaxPct: num(q.marginMaxPct),
      stock: q.stock || undefined, status: q.status || undefined,
    };
  }
  function select(filter) { return ds.items.filter((it) => R.matchesFilter(it, filter, state.settings.availability)); }

  // ---------- jobs (async, chunked so the UI never freezes) ----------
  function startJob(type, payload, runner, maxAttempts) {
    const job = { id: state.seq++, type, status: 'queued', attempts: 0, max_attempts: maxAttempts || 3, progress: null, result: null, last_error: null, created_at: nowIso(), finished_at: null, payload };
    state.jobs.unshift(job);
    save();
    const attempt = async () => {
      job.status = 'running';
      job.attempts += 1;
      try {
        job.result = await runner(job, (p) => { job.progress = p; });
        job.status = 'succeeded';
        job.finished_at = nowIso();
        job.last_error = null;
      } catch (e) {
        job.last_error = e.message;
        if (job.attempts >= job.max_attempts || e.permanent) {
          job.status = 'dead';
          job.finished_at = nowIso();
          logError('job:' + type, e.message, { jobId: job.id, attempts: job.attempts }, job.id);
          if (job.onDead) job.onDead(e);
        } else {
          job.status = 'queued';
          save();
          await delay(800 * job.attempts);
          return attempt();
        }
      }
      save();
      return job;
    };
    setTimeout(attempt, 50);
    return job;
  }

  // ---------- campaigns ----------
  function mapExc() { return state.mapExceptions.filter((m) => new Date(m.validUntil) > new Date()); }
  function evaluate(c) {
    const items = select(c.selection);
    const rules = Object.assign({}, state.settings.campaignRules, c.rules || {}, { excludeWithoutCost: true });
    const res = R.evaluateCampaign(items, c.adjustment, { rules, mapExceptions: mapExc() });
    const token = tokenOf(res.lines);
    return { lines: res.lines, summary: res.summary, rules, strategy: R.chooseExecutionStrategy(c.adjustment, c.channel, res.summary), token };
  }
  function tokenOf(lines) {
    let hsh = 2166136261;
    for (const l of lines) {
      const s = l.itemId + ':' + l.oldPriceCents + ':' + l.newPriceCents + ':' + l.status + '|';
      for (let i = 0; i < s.length; i++) { hsh ^= s.charCodeAt(i); hsh = Math.imul(hsh, 16777619) >>> 0; }
    }
    return 'demo' + hsh.toString(16) + lines.length;
  }
  function compactLines(lines) {
    return lines.map((l) => ({ i: l.itemId, o: l.oldPriceCents, n: l.newPriceCents, c: l.costCents, m: l.mapCents, s: l.status, r: l.reasons, a: null, rr: null }));
  }
  function getCamp(cid) { const c = state.campaigns.find((x) => x.id === cid); if (!c) fail(404, 'NOT_FOUND', 'Campaign not found'); return c; }
  function campRow(c) {
    const { lines, ...rest } = c;
    return clone(rest);
  }

  async function applyCampaign(c, job, progress) {
    if (c.status === 'active') return { alreadyActive: true };
    c.status = 'applying';
    const ev = evaluate(c);
    c.lines = compactLines(ev.lines);
    const todo = c.lines.filter((l) => l.s === 'ok' || l.s === 'warning');
    let applied = 0;
    let skippedChanged = 0;
    const posEventType = c.summary && c.summary.posEventType ? c.summary.posEventType : null;
    if (c.strategy === 'shopify_automatic_discount') {
      c.shopify_discount_id = 'gid://shopify/DiscountAutomaticNode/demo-' + state.seq++;
      demoCall('shopify', 'createAutomaticDiscount (Shopify Plus, simulated)', { title: c.name, items: todo.length });
      todo.forEach((l) => {
        const it = itemsById.get(l.i);
        if (it && l.n < l.o) patchItem(it, { priceCents: l.n, compareAtCents: l.o });
        l.a = nowIso();
      });
      applied = todo.length;
    } else {
      for (let i = 0; i < todo.length; i += 200) {
        todo.slice(i, i + 200).forEach((l) => {
          const it = itemsById.get(l.i);
          if (!it || it.priceCents !== l.o) { skippedChanged++; l.s = 'excluded'; l.r = ['CHANGED_SINCE_PREVIEW']; return; }
          patchItem(it, { priceCents: l.n, compareAtCents: l.n < l.o ? l.o : null });
          state.priceHistory.unshift({ variant_id: it.id, old_price_cents: l.o, new_price_cents: l.n, source: 'campaign', campaign_id: c.id, created_at: nowIso() });
          l.a = nowIso();
          applied++;
        });
        progress({ done: Math.min(i + 200, todo.length), total: todo.length, applied, skippedChanged });
        await delay(30); // yield to the UI between chunks
      }
      demoCall('shopify', 'productVariantsBulkUpdate (Shopify Plus, simulated)', { variants: applied });
      if (c.channel === 'online_and_pos') {
        demoCall('lightspeed_r', 'updateEventPosPrices (Physical Store POS, simulated)', { items: applied, event: posEventType || 'special_event' });
      }
    }
    c.status = 'active';
    c.summary = Object.assign({}, ev.summary, { previewToken: ev.token, posEventType, applied, skippedChanged });
    audit('campaign.applied', 'campaign', c.id, { applied, skippedChanged, strategy: c.strategy, channel: c.channel, posEventType });
    save();
    return { applied, skippedChanged, strategy: c.strategy };
  }

  async function restoreCampaign(c, job, progress) {
    if (c.status === 'restored') return { alreadyRestored: true };
    c.status = 'restoring';
    const counts = { restored: 0, skipped_changed: 0, skipped_not_applied: 0 };
    const lines = c.lines.filter((l) => l.s === 'ok' || l.s === 'warning');
    if (c.strategy === 'shopify_automatic_discount') {
      demoCall('shopify', 'discountAutomaticDeactivate (Shopify Plus, simulated)', { id: c.shopify_discount_id });
      lines.forEach((l) => {
        if (l.a) {
          const it = itemsById.get(l.i);
          if (it && it.priceCents === l.n) patchItem(it, { priceCents: l.o, compareAtCents: null });
          l.rr = 'restored';
          counts.restored++;
        }
      });
    } else {
      const plan = R.planRestore(lines.map((l) => ({ itemId: l.i, oldPriceCents: l.o, newPriceCents: l.n, applied: !!l.a })), (iid) => (itemsById.get(iid) || {}).priceCents);
      for (let i = 0; i < plan.length; i += 200) {
        plan.slice(i, i + 200).forEach((p) => {
          const l = lines.find((x) => x.i === p.itemId);
          if (p.action === 'restore') {
            const it = itemsById.get(p.itemId);
            patchItem(it, { priceCents: p.toCents, compareAtCents: null });
            state.priceHistory.unshift({ variant_id: it.id, old_price_cents: p.fromCents, new_price_cents: p.toCents, source: 'restore', campaign_id: c.id, created_at: nowIso() });
            l.rr = 'restored';
          } else l.rr = p.action === 'skip_not_applied' ? 'skipped_not_applied' : 'skipped_changed';
          counts[l.rr]++;
        });
        progress({ done: Math.min(i + 200, plan.length), total: plan.length });
        await delay(30);
      }
      demoCall('shopify', 'productVariantsBulkUpdate (restore Shopify Plus, simulated)', { variants: counts.restored });
      if (c.channel === 'online_and_pos') {
        demoCall('lightspeed_r', 'updateEventPosPrices (restore Physical Store POS, simulated)', { items: counts.restored });
      }
    }
    c.status = 'restored';
    audit('campaign.restored', 'campaign', c.id, counts);
    save();
    return counts;
  }

  // Scheduler: start/end campaigns by date while the page is open.
  setInterval(() => {
    const now = Date.now();
    state.campaigns.forEach((c) => {
      if (c.status === 'scheduled' && (!c.starts_at || new Date(c.starts_at).getTime() <= now) && !c._starting) {
        c._starting = true;
        startJob('campaign.apply', { campaignId: c.id }, (j, p) => applyCampaign(c, j, p));
      }
      if (c.status === 'active' && c.ends_at && new Date(c.ends_at).getTime() <= now && !c._ending) {
        c._ending = true;
        startJob('campaign.restore', { campaignId: c.id }, (j, p) => restoreCampaign(c, j, p));
      }
    });
  }, 15000);

  // ---------- orders ----------
  function getOrder(oid) { const o = state.orders.find((x) => x.id === oid); if (!o) fail(404, 'NOT_FOUND', 'Order not found'); return o; }
  function setStatus(o, to, actor, note, extra) {
    const e = extra || {};
    o.events.push({ id: o.events.length + 1, from_status: o.internal_status, to_status: to, actor, note: note || '', created_at: nowIso() });
    if (to === 'exception') o.exception_reason = e.reason || 'other';
    if (e.tracking) o.tracking = e.tracking;
    o.internal_status = to;
  }
  function orderRow(o) {
    const { lines, events, pos, ...rest } = o;
    return Object.assign(clone(rest), { line_count: lines.length });
  }
  function supplierQuote(code, sku) {
    if (state.simulateOutage) { const err = new Error(code + ' demo adapter: simulated connection error'); throw err; }
    for (const { o } of allOffers()) if (o.supplierCode === code && o.supplierSku === sku) return { qtyAvailable: o.qtyAvailable, costCents: o.costCents };
    return { qtyAvailable: 0, costCents: null };
  }

  function reviewOrder(o) {
    if (o.internal_status !== 'awaiting_review') return { skipped: o.internal_status };
    const problems = [];
    let reason = null;
    const bySup = {};
    o.lines.filter((l) => l.source === 'supplier').forEach((l) => {
      const it = itemsById.get(l.variant_id);
      const off = it.offers.find((x) => x.supplierCode === l.supplier_code);
      const q = supplierQuote(l.supplier_code, off.supplierSku);
      const chk = R.revalidateCost(l.quoted_cost_cents, q.costCents, q.qtyAvailable, l.qty);
      if (!chk.ok) { problems.push(l.supplier_code + ': ' + chk.reason); reason = chk.reason; }
      (bySup[l.supplier_code] = bySup[l.supplier_code] || []).push({ l, sku: off.supplierSku });
    });
    if (problems.length) { setStatus(o, 'exception', 'system', problems.join('; '), { reason }); save(); return { exception: problems }; }
    let n = 0;
    Object.keys(bySup).forEach((code) => {
      n++;
      const ls = bySup[code];
      state.purchaseOrders.push({
        id: id('po'), po_number: 'PO-' + o.number.replace(/\W/g, '') + '-' + n, order_id: o.id, status: 'awaiting_approval', supplier_code: code,
        ship_to: o.fulfillment_method === 'ship' ? 'customer' : 'ubc_store', total_cents: ls.reduce((s, x) => s + x.l.quoted_cost_cents * x.l.qty, 0),
        external_ref: null, tracking: null, created_at: nowIso(), approved_by: null, approved_at: null, submitted_at: null, idempotency_key: 'po:' + o.id + ':' + code,
        lines: ls.map((x) => ({ supplier_sku: x.sku, qty: x.l.qty, expected_cost_cents: x.l.quoted_cost_cents })),
      });
    });
    setStatus(o, 'awaiting_approval', 'system', 'Availability and cost confirmed; purchase request awaiting approval');
    audit('notification.purchase_approval_needed', 'order', o.id, { number: o.number });
    save();
    return { purchaseOrders: n };
  }

  function submitPo(po, o) {
    if (po.status === 'submitted') return { alreadySubmitted: true };
    if (po.status !== 'approved' || !po.approved_by) { const e = new Error('PO is not approved by a person'); e.permanent = true; throw e; }
    if (state.simulateOutage) throw new Error(po.supplier_code + ' demo adapter: simulated connection error');
    po.status = 'submitted';
    po.external_ref = po.supplier_code + '-DEMO-' + po.po_number;
    po.submitted_at = nowIso();
    demoCall(po.supplier_code.toLowerCase(), 'submitPurchaseOrder (simulated — nothing ordered)', { po: po.po_number });
    const pending = state.purchaseOrders.some((p) => p.order_id === o.id && (p.status === 'awaiting_approval' || p.status === 'approved'));
    if (!pending && o.internal_status === 'approved') setStatus(o, 'po_submitted', 'system', po.supplier_code + ' accepted ' + po.po_number + ' (' + po.external_ref + ')');
    audit('po.submitted', 'purchase_order', po.id, { ref: po.external_ref });
    save();
    return { accepted: true, externalRef: po.external_ref };
  }

  const api = {
    kind: 'demo',
    storageOk: () => storageOk,
    // UPC matches review only exists against the live Workstand-owned store.
    async upcReview() { return { proposals: [], counts: [], shop: 'demo.local', mode: 'demo' }; },
    async decideUpc() { throw new Error('UPC review is only available in the live Hub'); },
    async runUpcMatch() { throw new Error('UPC review is only available in the live Hub'); },
    async createShopifyProduct() { throw new Error('Creating Shopify products is only available in the live Hub'); },
    users: USERS,
    async login(email) {
      const u = USERS.find((x) => x.email === email);
      if (!u) fail(401, 'INVALID_CREDENTIALS', 'Unknown demo user');
      state.userId = u.id;
      audit('auth.login', null, null, { demo: true });
      save();
      return { user: u, csrfToken: 'demo' };
    },
    async me() {
      const u = user();
      return { user: u, permissions: ROLE_PERMISSIONS[u.role], csrfToken: 'demo', mode: 'demo' };
    },
    async logout() { state.userId = null; save(); return { ok: true }; },
    async system() { return { mode: 'demo', demoNotice: DEMO_NOTICE, static: true, storage: storageOk }; },

    async dashboard() {
      can('catalog.read');
      const counts = { published: 0, physical: 0, virtualOnly: 0, unavailable: 0, total: ds.items.length };
      ds.items.forEach((i) => {
        if (i.status === 'published') counts.published++;
        const s = avail(i).status;
        if (s === 'in_stock') counts.physical++; else if (s === 'special_order') counts.virtualOnly++; else counts.unavailable++;
      });
      const open = state.orders.filter((o) => o.is_special_order && o.internal_status !== 'completed' && o.internal_status !== 'cancelled');
      return {
        counts: Object.assign(counts, {
          orders: state.orders.length, pendingSpecial: open.length,
          awaitingApproval: state.orders.filter((o) => o.internal_status === 'awaiting_approval').length,
          activeCampaigns: state.campaigns.filter((c) => ['active', 'scheduled', 'applying'].indexOf(c.status) >= 0).length,
          openErrors: state.errors.filter((e) => !e.resolved_at).length, deadJobs: state.jobs.filter((j) => j.status === 'dead').length,
          pendingMatchReviews: state.reviews.filter((r) => r.status === 'pending').length,
        }),
        recentJobs: state.jobs.slice(0, 8).map((j) => ({ type: j.type, status: j.status, finished_at: j.finished_at, created_at: j.created_at })),
        shopifySales: { available: false, reason: 'Shopify Plus ready to connect (DEMO)' },
      };
    },

    async items(q) {
      can('catalog.read');
      const limit = Math.min(200, Number(q.limit) || 50);
      const offset = Number(q.offset) || 0;
      const list = R.sortItems(select(toFilter(q)), q.sort || 'title', q.dir || 'asc');
      return { total: list.length, items: list.slice(offset, offset + limit).map((i) => Object.assign(clone(i), { availability: avail(i) })) };
    },
    async facets() {
      can('catalog.read');
      const count = (key) => {
        const m = {};
        ds.items.forEach((i) => { m[i[key]] = (m[i[key]] || 0) + 1; });
        return Object.keys(m).sort().map((v) => ({ value: v, n: m[v] }));
      };
      return { categories: count('category'), brands: count('brand'), suppliers: ds.suppliers.map((s) => ({ value: s.code, name: s.name })) };
    },
    async item(iid) {
      can('catalog.read');
      const it = itemsById.get(iid);
      if (!it) fail(404, 'NOT_FOUND', 'Item not found');
      return {
        item: clone(it), availability: avail(it),
        priceHistory: state.priceHistory.filter((p) => p.variant_id === iid).slice(0, 50),
        externalIds: it.lightspeedItemId ? [{ system: 'lightspeed_r', external_id: it.lightspeedItemId + ' (demo)' }] : [],
      };
    },
    async setPrice(iid, priceCents, version) {
      can('pricing.write');
      const it = itemsById.get(iid);
      if (!it) fail(404, 'NOT_FOUND', 'Item not found');
      if (it.version !== version) fail(409, 'VERSION_CONFLICT', 'This item was changed by someone else. Reload and try again.');
      const line = R.evaluateLine(it, { type: 'set_price', value: priceCents, rounding: 'none' }, { rules: Object.assign({}, state.settings.campaignRules, { clampToMinMargin: false, excludeWithoutCost: false }), mapExceptions: mapExc() });
      if (line.status === 'blocked') fail(422, 'RULE_VIOLATION', 'Price breaks a commercial rule', { reasons: line.reasons });
      state.priceHistory.unshift({ variant_id: iid, old_price_cents: it.priceCents, new_price_cents: priceCents, source: 'manual', campaign_id: null, created_at: nowIso() });
      patchItem(it, { priceCents });
      audit('item.price_changed', 'variant', iid, { to: priceCents });
      save();
      return { ok: true, warnings: line.reasons };
    },
    async bulkStatus(filter, status) {
      can('catalog.write');
      const job = startJob('items.bulk_status', { status }, async (j, progress) => {
        const products = {};
        select(filter).forEach((i) => { products[i.productId] = true; });
        const pids = Object.keys(products);
        const targets = ds.items.filter((i) => products[i.productId]);
        for (let i = 0; i < targets.length; i += 300) {
          targets.slice(i, i + 300).forEach((it) => patchItem(it, { status }));
          progress({ done: Math.min(i + 300, targets.length), total: targets.length });
          await delay(20);
        }
        demoCall('shopify', 'productUpdate status (Shopify Plus, simulated)', { products: pids.length, status });
        audit('items.bulk_status_applied', null, null, { products: pids.length, status });
        return { products: pids.length, status };
      });
      audit('items.bulk_status_requested', null, null, { status });
      return { jobId: job.id };
    },
    async locations() {
      let skus = 0, onHand = 0, reserved = 0;
      ds.items.forEach((i) => { if (i.physicalQty || i.reservedQty) { skus++; onHand += i.physicalQty; reserved += i.reservedQty; } });
      return { locations: [{ id: 'loc-main', name: 'UBC Main Physical Store', kind: 'physical', skus, on_hand: onHand, reserved }] };
    },

    async job(jid) { const j = state.jobs.find((x) => x.id === Number(jid)); if (!j) fail(404, 'NOT_FOUND', 'Job not found'); return clone(Object.assign({}, j, { onDead: undefined })); },
    async jobs(status) { return { jobs: state.jobs.filter((j) => !status || j.status === status).map((j) => clone(Object.assign({}, j, { onDead: undefined }))) }; },
    async retryJob() { fail(409, 'NOT_SUPPORTED', 'In the static demo, re-run the action instead (the API version supports retries).'); },
    async errors() { can('audit.read'); return { errors: clone(state.errors) }; },
    async resolveError(eid) { can('audit.read'); const e = state.errors.find((x) => x.id === eid); if (e) e.resolved_at = nowIso(); audit('error.resolved', 'error', String(eid)); save(); return { ok: true }; },
    async audit() { can('audit.read'); return { entries: clone(state.audit) }; },
    async settings() { return clone(state.settings); },
    async saveSettings(s) { can('settings.manage'); audit('settings.updated', null, null, { before: state.settings, after: s }); state.settings = clone(s); state.settings.campaignRules.excludeWithoutCost = true; save(); return clone(state.settings); },

    async campaigns() {
      can('catalog.read');
      return { campaigns: state.campaigns.slice().sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).map(campRow) };
    },
    async createCampaign(input) {
      const u = can('pricing.write');
      if (!input.name || input.name.length < 3) fail(400, 'VALIDATION', 'Name must have at least 3 characters');
      if (input.startsAt && input.endsAt && new Date(input.endsAt) <= new Date(input.startsAt)) fail(400, 'VALIDATION', 'End must be after start');
      await delay(10);
      const ch = input.channel || 'online';
      const posEventType = ch === 'online_and_pos' ? inferPosEventType(input.name, input.posEventType) : null;
      const c = { id: id('cmp'), name: input.name, status: 'draft', channel: ch, selection: input.selection, adjustment: input.adjustment, rules: input.rules || {}, starts_at: input.startsAt || null, ends_at: input.endsAt || null, created_at: nowIso(), created_by: u.name, approved_by: null, shopify_discount_id: null };
      const ev = evaluate(c);
      c.rules = ev.rules;
      c.strategy = ev.strategy;
      c.summary = Object.assign({}, ev.summary, { previewToken: ev.token, posEventType });
      c.lines = compactLines(ev.lines);
      state.campaigns.push(c);
      audit('campaign.created', 'campaign', c.id, { summary: ev.summary, channel: ch, posEventType });
      save();
      return { id: c.id, summary: ev.summary, strategy: ev.strategy, previewToken: ev.token, posEventType };
    },
    async campaign(cid) { can('catalog.read'); return campRow(getCamp(cid)); },
    async campaignLines(cid, status, offset, limit) {
      const c = getCamp(cid);
      const all = c.lines.filter((l) => !status || l.s === status);
      const o = Number(offset) || 0;
      const lim = Number(limit) || 100;
      return {
        total: all.length,
        lines: all.slice(o, o + lim).map((l) => {
          const it = itemsById.get(l.i) || {};
          return { variant_id: l.i, sku: it.sku, title: it.title, brand: it.brand, category: it.category, old_price_cents: l.o, new_price_cents: l.n, cost_cents: l.c, map_cents: l.m, status: l.s, reasons: l.r, applied_at: l.a, restore_result: l.rr };
        }),
      };
    },
    async previewCampaign(cid) {
      can('pricing.write');
      const c = getCamp(cid);
      if (c.status !== 'draft') fail(409, 'CAMPAIGN_NOT_DRAFT', 'Only draft campaigns can be re-previewed');
      const ev = evaluate(c);
      const posEventType = c.summary && c.summary.posEventType ? c.summary.posEventType : (c.channel === 'online_and_pos' ? inferPosEventType(c.name) : null);
      c.lines = compactLines(ev.lines);
      c.summary = Object.assign({}, ev.summary, { previewToken: ev.token, posEventType });
      c.strategy = ev.strategy;
      save();
      return { summary: ev.summary, strategy: ev.strategy, previewToken: ev.token };
    },
    async approveCampaign(cid, token) {
      const u = can('campaign.approve');
      const c = getCamp(cid);
      if (c.status !== 'draft') fail(409, 'CAMPAIGN_NOT_DRAFT', 'Campaign is ' + c.status);
      const ev = evaluate(c);
      if (ev.token !== token) fail(409, 'PREVIEW_STALE', 'Catalog data changed since this preview. Review the refreshed preview before approving.', { previewToken: ev.token, summary: ev.summary });
      if (ev.summary.ok + ev.summary.warning === 0) fail(422, 'NOTHING_TO_APPLY', 'No line passes the commercial rules');
      if (c.ends_at && new Date(c.ends_at) <= new Date()) fail(422, 'ENDS_IN_PAST', 'Campaign end date is in the past');
      c.status = 'scheduled';
      c.approved_by = u.name;
      audit('campaign.approved', 'campaign', c.id, { summary: ev.summary, channel: c.channel, posEventType: c.summary ? c.summary.posEventType : null });
      const startNow = !c.starts_at || new Date(c.starts_at) <= new Date();
      let jobId = null;
      if (startNow) { c._starting = true; jobId = startJob('campaign.apply', { campaignId: c.id }, (j, p) => applyCampaign(c, j, p)).id; }
      save();
      return { status: 'scheduled', jobId, startNow };
    },
    async restoreCampaign(cid) {
      can('pricing.write');
      const c = getCamp(cid);
      if (c.status !== 'active') fail(409, 'CAMPAIGN_NOT_ACTIVE', 'Campaign is ' + c.status);
      c._ending = true;
      const job = startJob('campaign.restore', { campaignId: c.id }, (j, p) => restoreCampaign(c, j, p));
      audit('campaign.restore_requested', 'campaign', c.id);
      return { jobId: job.id };
    },
    async cancelCampaign(cid) {
      can('pricing.write');
      const c = getCamp(cid);
      if (c.status !== 'draft' && c.status !== 'scheduled') fail(409, 'CANNOT_CANCEL', 'Only draft or scheduled campaigns can be cancelled (restore an active one instead)');
      c.status = 'cancelled';
      audit('campaign.cancelled', 'campaign', c.id);
      save();
      return { ok: true };
    },
    async exportCampaign(cid) {
      const c = getCamp(cid);
      const esc = (v) => { const s = v === null || v === undefined ? '' : Array.isArray(v) ? v.join('|') : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
      const rows = c.lines.map((l) => { const it = itemsById.get(l.i) || {}; return [it.sku, it.title, it.brand, it.category, l.o, l.n, l.c, l.m, l.s, l.r, l.a, l.rr].map(esc).join(','); });
      return ['sku,title,brand,category,old_price_cents,new_price_cents,cost_cents,map_cents,status,reasons,applied_at,restore_result'].concat(rows).join('\n');
    },
    async mapException(body) {
      can('map.exception');
      state.mapExceptions.push(body);
      audit('map_exception.recorded', 'variant', body.itemId, body);
      save();
      return { id: id('mapx') };
    },

    async orders(q) {
      can('orders.read');
      const query = q || {};
      return {
        orders: state.orders.filter((o) => (!query.status || o.internal_status === query.status)
          && (query.special === undefined || query.special === '' || String(o.is_special_order) === String(query.special))
          && (!query.q || (o.number + ' ' + o.customer_name).toLowerCase().indexOf(String(query.q).toLowerCase()) >= 0))
          .sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).map(orderRow),
      };
    },
    async order(oid) {
      can('orders.read');
      const o = getOrder(oid);
      return {
        order: orderRow(o), lines: clone(o.lines), events: clone(o.events),
        purchaseOrders: clone(state.purchaseOrders.filter((p) => p.order_id === oid).map((p) => Object.assign({}, p, { approved_by_name: p.approved_by, supplier_name: (ds.suppliers.find((s) => s.code === p.supplier_code) || {}).name }))),
      };
    },
    async transition(oid, body) {
      const u = can('orders.write');
      const o = getOrder(oid);
      const perms = ROLE_PERMISSIONS[u.role];
      try { R.assertTransition(o.internal_status, body.to, perms, body.note); } catch (e) { fail(e.code === 'FORBIDDEN' ? 403 : 422, e.code, e.message); }
      if (R.nextSteps(o.internal_status, o.fulfillment_method).indexOf(body.to) < 0) fail(422, 'INVALID_FOR_METHOD', body.to + ' does not apply to ' + o.fulfillment_method + ' orders');
      if (body.to === 'exception' && !body.reason) fail(422, 'REASON_REQUIRED', 'Choose an exception reason');
      const pos = state.purchaseOrders.filter((p) => p.order_id === oid);
      if (body.to === 'approved') {
        const waiting = pos.filter((p) => p.status === 'awaiting_approval');
        if (!waiting.length) fail(409, 'NO_PURCHASE_REQUEST', 'There is no purchase request awaiting approval for this order');
        for (const p of waiting) {
          for (const l of p.lines) {
            let q;
            try { q = supplierQuote(p.supplier_code, l.supplier_sku); } catch (e) { logError('approval', e.message, { order: o.number }); save(); fail(503, 'SUPPLIER_UNAVAILABLE', e.message + ' — try again later'); }
            const chk = R.revalidateCost(l.expected_cost_cents, q.costCents, q.qtyAvailable, l.qty);
            if (!chk.ok) { setStatus(o, 'exception', u.name, 'Approval blocked: ' + p.supplier_code + ' ' + chk.reason, { reason: chk.reason }); save(); fail(409, 'REVALIDATION_FAILED', 'Supplier data changed (' + chk.reason + '). Order moved to Exception.'); }
          }
          p.status = 'approved'; p.approved_by = u.name; p.approved_at = nowIso();
        }
      }
      if (body.to === 'po_submitted') {
        const approved = pos.filter((p) => p.status === 'approved');
        if (!approved.length) fail(409, 'NO_APPROVED_PO', 'Approve the purchase request first');
        const jobs = approved.map((p) => {
          const j = startJob('po.submit', { purchaseOrderId: p.id }, async () => { await delay(400); return submitPo(p, o); }, 3);
          j.onDead = (e) => { p.status = 'exception'; if (o.internal_status !== 'exception') setStatus(o, 'exception', 'system', 'PO submission failed: ' + e.message, { reason: 'connection_error' }); save(); };
          return j.id;
        });
        audit('po.submit_requested', 'order', oid, { jobs });
        save();
        return { queued: true, jobs };
      }
      const poMap = { supplier_confirmed: 'confirmed', in_transit: 'in_transit', received_at_ubc: 'received' };
      if (poMap[body.to]) pos.forEach((p) => { if (p.status !== 'cancelled') { p.status = poMap[body.to]; if (body.tracking) p.tracking = body.tracking; } });
      if ((body.to === 'completed' || body.to === 'cancelled') && o.internal_status !== 'completed') {
        o.lines.filter((l) => l.source === 'ubc_stock').forEach((l) => {
          const it = itemsById.get(l.variant_id);
          if (it) patchItem(it, { reservedQty: Math.max(0, it.reservedQty - l.qty), physicalQty: it.physicalQty - (body.to === 'completed' ? l.qty : 0) });
        });
      }
      let note = body.note || '';
      if (body.to === 'cancelled') {
        pos.forEach((p) => { if (p.status === 'awaiting_approval' || p.status === 'approved') p.status = 'cancelled'; });
        if (pos.some((p) => ['submitted', 'confirmed', 'in_transit'].indexOf(p.status) >= 0)) note += ' — NOTE: a PO was already sent to the supplier; request cancellation from the supplier manually.';
      }
      if (body.to === 'completed') o.shopify_fulfillment_status = 'fulfilled';
      setStatus(o, body.to, u.name, note, { reason: body.reason, tracking: body.tracking });
      audit('order.' + body.to, 'order', oid, { note: body.note });
      save();
      return { status: body.to };
    },
    async purchaseOrders() {
      can('orders.read');
      return {
        purchaseOrders: state.purchaseOrders.slice().sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).map((p) => {
          const o = state.orders.find((x) => x.id === p.order_id);
          return Object.assign(clone(p), { order_number: o ? o.number : null });
        }),
      };
    },
    async checkout(body) {
      const u = can('orders.write');
      const seq = Date.now();
      const number = '#DEMO-' + String(seq).slice(-6);
      const o = {
        id: id('o'), number, customer_name: body.customerName + ' (demo)', fulfillment_method: body.method, financial_status: 'paid',
        shopify_fulfillment_status: 'unfulfilled', internal_status: 'new_order', is_special_order: false, exception_reason: null,
        total_cents: 0, tracking: null, created_at: nowIso(), lines: [], events: [{ id: 1, from_status: null, to_status: 'new_order', actor: 'shopify (simulated webhook)', note: 'Order ' + number + ' received', created_at: nowIso() }], pos: [],
      };
      let special = false;
      let unfulfillable = false;
      body.lines.forEach((ln, idx) => {
        const it = itemsById.get(ln.itemId);
        o.total_cents += it.priceCents * ln.qty;
        R.planFulfillment(it, ln.qty, body.method, state.settings.availability).forEach((part, pi) => {
          const base = { id: o.id + '-l' + idx + '-' + pi, variant_id: it.id, sku: it.sku, title: it.title, qty: part.qty, price_cents: it.priceCents };
          if (part.kind === 'ubc_stock') {
            patchItem(it, { reservedQty: it.reservedQty + part.qty });
            o.lines.push(Object.assign(base, { source: 'ubc_stock', supplier_code: null, quoted_cost_cents: it.costCents }));
          } else if (part.kind === 'supplier') {
            special = true;
            o.lines.push(Object.assign(base, { source: 'supplier', supplier_code: part.supplierCode, quoted_cost_cents: part.costCents }));
          } else {
            unfulfillable = true;
            o.lines.push(Object.assign(base, { source: 'unfulfillable', supplier_code: null, quoted_cost_cents: null }));
          }
        });
      });
      o.is_special_order = special;
      state.orders.push(o);
      demoCall('shopify', 'webhook orders/create (Shopify Plus simulated, HMAC-verified path in API)', { order: number });
      if (unfulfillable) setStatus(o, 'exception', 'system', 'Some units are not available from UBC stock or any supplier', { reason: 'partially_available' });
      else if (special) {
        setStatus(o, 'awaiting_review', 'system', 'Special order: supplier availability will be re-checked');
        startJob('order.review', { orderId: o.id }, async () => { await delay(700); return reviewOrder(o); });
      } else setStatus(o, 'received_at_ubc', 'system', 'All units reserved from UBC physical store stock');
      audit('order.ingested', 'order', o.id, { number, special, by: u.name });
      save();
      return { orderNumber: number, orderId: o.id, special };
    },

    async suppliers() {
      can('catalog.read');
      return {
        suppliers: ds.suppliers.map((s) => {
          let offers = 0, last = null;
          ds.items.forEach((i) => i.offers.forEach((o) => { if (o.supplierCode === s.code) { offers++; if (!last || o.reportedAt > last) last = o.reportedAt; } }));
          const imported = state.importedOffers.filter((o) => o.supplier_code === s.code);
          return {
            id: s.code, code: s.code, name: s.name, connector: s.connector, methods: s.methods, notes: s.notes, is_active: true,
            offers: offers + imported.length, unmatched: imported.filter((o) => !o.ubc_sku).length + state.reviews.filter((r) => r.supplier_code === s.code && r.status === 'pending').length,
            last_report: last,
            health: { system: s.code.toLowerCase(), status: 'demo_adapter', detail: 'UBC dealer access confirmed — simulated DEMO adapter ready to connect', missing: SUPPLIER_HEALTH_MISSING[s.code] || [], writesEnabled: false, checkedAt: nowIso() },
          };
        }),
      };
    },
    async supplierOffers(code, q) {
      can('catalog.read');
      const query = q || {};
      let rows = [];
      ds.items.forEach((it) => it.offers.forEach((o) => {
        if (o.supplierCode === code) rows.push({ id: o.supplierSku, supplier_sku: o.supplierSku, brand: it.brand, title: it.title, upc: it.upc, mpn: it.mpn, cost_cents: o.costCents, qty_available: o.qtyAvailable, drop_ship: o.dropShip, lead_days: o.leadDays, reported_at: o.reportedAt, content_licensed: false, ubc_sku: it.sku });
      }));
      rows = rows.concat(state.importedOffers.filter((o) => o.supplier_code === code));
      if (query.unmatched === 'true') rows = rows.filter((r) => !r.ubc_sku);
      rows.sort((a, b) => (a.supplier_sku < b.supplier_sku ? -1 : 1));
      const off = Number(query.offset) || 0;
      return { offers: rows.slice(off, off + (Number(query.limit) || 50)), total: rows.length };
    },
    async importFeed(code, body) {
      can('catalog.write');
      const job = startJob('supplier.import_feed', { supplierCode: code }, async (j, progress) => {
        const parsed = mapFeed(body.csv, body.mapping, { contentLicensed: !!body.contentLicensed, defaultLeadDays: 5 });
        const stats = { upserted: 0, autoMatched: 0, review: 0, unmatched: 0, alreadyLinked: 0, rowErrorCount: parsed.errors.length, rowErrors: parsed.errors.slice(0, 50) };
        for (let i = 0; i < parsed.records.length; i++) {
          const r = parsed.records[i];
          const best = R.findBestMatch({ brand: r.brand, mpn: r.mpn, upc: r.upc, title: r.title }, ds.items);
          const row = { id: id('off'), supplier_code: code, supplier_sku: r.supplierSku, brand: r.brand, title: r.title, upc: r.upc, mpn: r.mpn, cost_cents: r.costCents, qty_available: r.qtyAvailable, drop_ship: r.dropShip, lead_days: r.leadDays, reported_at: nowIso(), content_licensed: r.contentLicensed, ubc_sku: null };
          if (best && best.decision === 'auto_match') { row.ubc_sku = best.item.sku; stats.autoMatched++; }
          else if (best && best.decision === 'review') {
            state.reviews.push({ id: id('mr'), score: best.score, reasons: best.reasons, status: 'pending', created_at: nowIso(), supplier_code: code, supplier_sku: r.supplierSku, offer_title: r.title, offer_brand: r.brand, offer_upc: r.upc, offer_mpn: r.mpn, candidate_id: best.item.id, candidate_sku: best.item.sku, candidate_title: best.item.title, candidate_upc: best.item.upc, candidate_mpn: best.item.mpn });
            stats.review++;
          } else stats.unmatched++;
          state.importedOffers = state.importedOffers.filter((o) => !(o.supplier_code === code && o.supplier_sku === r.supplierSku));
          state.importedOffers.push(row);
          stats.upserted++;
          if (i % 200 === 0) { progress({ done: i, total: parsed.records.length }); await delay(5); }
        }
        state.importedOffers = state.importedOffers.slice(-2000);
        audit('supplier.imported', 'supplier', code, stats);
        return stats;
      }, 1);
      return { jobId: job.id };
    },
    async importFeedChunk(code, body) {
      can('catalog.write');
      const parsed = mapFeed(body.csv, body.mapping, { contentLicensed: !!body.contentLicensed, defaultLeadDays: 5 });
      const stats = { upserted: 0, autoMatched: 0, review: 0, unmatched: 0, alreadyLinked: 0, stagedReady: 0, rowErrorCount: parsed.errors.length };
      for (let i = 0; i < parsed.records.length; i++) {
        const r = parsed.records[i];
        const best = R.findBestMatch({ brand: r.brand, mpn: r.mpn, upc: r.upc, title: r.title }, ds.items);
        const row = { id: id('off'), supplier_code: code, supplier_sku: r.supplierSku, brand: r.brand, title: r.title, upc: r.upc, mpn: r.mpn, cost_cents: r.costCents, qty_available: r.qtyAvailable, drop_ship: r.dropShip, lead_days: r.leadDays, reported_at: nowIso(), content_licensed: r.contentLicensed, ubc_sku: null };
        if (best && best.decision === 'auto_match') { row.ubc_sku = best.item.sku; stats.autoMatched++; }
        else if (best && best.decision === 'review') { stats.review++; }
        else stats.unmatched++;
        state.importedOffers.push(row);
        stats.upserted++;
      }
      state.importedOffers = state.importedOffers.slice(-2000);
      save();
      return stats;
    },
    async promoteSupplierOffers(code) {
      can('catalog.write');
      const job = startJob('supplier.promote_catalog', { supplierCode: code }, async () => {
        const unm = state.importedOffers.filter((o) => o.supplier_code === code && !o.ubc_sku);
        unm.forEach((o) => { o.ubc_sku = code + '-' + o.supplier_sku; });
        save();
        return { productsUpserted: unm.length, variantsPromoted: unm.length, stagedForShopify: unm.length };
      });
      return { jobId: job.id };
    },
    async matchReviews(q) {
      can('catalog.read');
      const query = q || {};
      const all = state.reviews.filter((r) => r.status === 'pending' && (!query.supplier || r.supplier_code === query.supplier));
      const off = Number(query.offset) || 0;
      const lim = Number(query.limit) || 100;
      return { reviews: clone(all.slice(off, off + lim)), total: all.length };
    },
    async resolveReview(rid, decision) {
      can('catalog.write');
      const r = state.reviews.find((x) => x.id === rid && x.status === 'pending');
      if (!r) fail(404, 'NOT_FOUND', 'Pending review not found');
      r.status = decision;
      const off = state.importedOffers.find((o) => o.supplier_code === r.supplier_code && o.supplier_sku === r.supplier_sku);
      if (off && decision === 'approved') off.ubc_sku = r.candidate_sku;
      audit('match.' + decision, 'match_review', rid);
      save();
      return { status: decision };
    },
    async integrations() {
      const list = [
        { system: 'shopify', status: 'demo_adapter', detail: 'Shopify Plus DEMO adapter — ready to connect (Functions, Click & Collect & Bulk Ops prepared)', missing: ['SHOPIFY_SHOP_DOMAIN & SHOPIFY_CLIENT_ID / SECRET in .env'], writesEnabled: false, checkedAt: nowIso() },
        { system: 'lightspeed_r', status: 'demo_adapter', detail: 'Lightspeed Retail R-Series DEMO adapter — physical store stock & event-only POS price parity ready', missing: ['LIGHTSPEED_R_CLIENT_ID / SECRET in .env', 'LIGHTSPEED_R_REFRESH_TOKEN & ACCOUNT_ID in .env'], writesEnabled: false, checkedAt: nowIso() },
      ];
      ds.suppliers.forEach((s) => list.push({ system: s.code.toLowerCase(), status: 'demo_adapter', detail: 'UBC dealer access confirmed — ' + s.name + ' adapter ready to connect', missing: SUPPLIER_HEALTH_MISSING[s.code] || [], writesEnabled: false, checkedAt: nowIso() }));
      return { mode: 'demo', integrations: list, demoCalls: clone(state.demoCalls.slice(0, 50)) };
    },
    async pipelineStatus() {
      can('catalog.read');
      const now = nowIso();
      return {
        cadences: {
          availability: { stream: 'availability', intervalMinutes: 20, windowMinutes: [15, 30], maxSilenceHours: 2 },
          costs: { stream: 'costs', intervalMinutes: 540, windowMinutes: [360, 720], maxSilenceHours: 24 },
          content: { stream: 'content', intervalMinutes: 1440, windowMinutes: [1440, 1440], maxSilenceHours: 48 },
          full_catalog: { stream: 'full_catalog', intervalMinutes: null, windowMinutes: null, maxSilenceHours: 48 },
        },
        schedules: ds.suppliers.reduce((acc, s) => acc.concat([
          { supplier_code: s.code, supplier_name: s.name, stream: 'availability', interval_minutes: 20, max_silence_hours: 2, last_success_at: now, last_status: 'succeeded' },
          { supplier_code: s.code, supplier_name: s.name, stream: 'costs', interval_minutes: 540, max_silence_hours: 24, last_success_at: now, last_status: 'succeeded' },
          { supplier_code: s.code, supplier_name: s.name, stream: 'content', interval_minutes: 1440, max_silence_hours: 48, last_success_at: now, last_status: 'succeeded' },
        ]), []),
        watchdog: ds.suppliers.map((s) => ({ supplierCode: s.code, supplierName: s.name, status: 'healthy', hoursSilent: 0.2, maxSilenceHours: 48, message: s.name + ' feed healthy (DEMO).' })),
        stagingSummary: [{ status: 'held', decision: 'held_for_review', n: 1 }, { status: 'pending', decision: 'ready_for_shopify', n: 2 }],
        recentRuns: [
          { id: 1, supplier_code: 'QBP', stream: 'costs', status: 'succeeded', records_seen: 42, records_changed: 3, staged_ready: 2, staged_held: 1, started_at: now },
        ],
      };
    },
    async pipelineStaging() {
      can('catalog.read');
      const sample = ds.items[0];
      return {
        staged: sample ? [{
          id: 1,
          variant_id: sample.id,
          sku: sample.sku,
          title: sample.title,
          stream: 'costs',
          decision: 'held_for_review',
          status: 'held',
          hold_reasons: ['map_above_published_price'],
          shopify_payload: { availability: 'special_order', publishedQty: 0, leadTimeDays: 4, clickAndCollectOnly: sample.brand === 'Specialized' },
          updated_at: nowIso(),
        }] : [],
      };
    },
    async pipelineHistory() {
      can('catalog.read');
      const sample = ds.items[0];
      return {
        history: sample ? [{
          id: 1,
          supplier_code: 'QBP',
          supplier_sku: 'QBP-DEMO-450',
          variant_title: sample.title,
          change_types: ['cost_changed'],
          old_cost_cents: 45000,
          new_cost_cents: 47500,
          old_map_cents: 84999,
          new_map_cents: 84999,
          shopify_published_price_cents: sample.priceCents,
          resulting_margin_bps: 3820,
          recorded_at: nowIso(),
        }] : [],
      };
    },
    async resolveStaging(sid, action) { return { ok: true, id: sid, status: action === 'release' ? 'pending' : 'dismissed' }; },
    async flushPipeline() { const job = startJob('pipeline.flush_shopify', {}, async () => ({ pushed: 2 })); return { jobId: job.id }; },
    async runWatchdog() { return { alertsRaised: 0, jobsScheduled: 0 }; },
    async syncShopify() { const job = startJob('shopify.sync_catalog', {}, async () => ({ seen: ds.items.length })); return { jobId: job.id }; },
    async setupShopifyMetafields() { return { created: [], existing: ['ubc.availability', 'ubc.lead_time_days', 'ubc.click_and_collect_only'] }; },
    async setupShopifyCollections() { return { created: [], existing: ['electric-bikes', 'road-bikes', 'mountain-bikes', 'hybrid-bikes', 'helmets', 'tires-tubes', 'hydration-nutrition', 'parts-components'] }; },
    async syncLightspeed() { const job = startJob('lightspeed.sync_catalog', {}, async () => ({ status: 'awaiting_oauth_credentials', seen: 0 })); return { jobId: job.id }; },

    // Demo-only controls
    simulateOutage(on) { state.simulateOutage = !!on; save(); },
    outageOn() { return !!state.simulateOutage; },
    resetDemo() { safeStorage.remove(KEY); state = freshState(); state.orders = null; },
  };
  return api;
}
