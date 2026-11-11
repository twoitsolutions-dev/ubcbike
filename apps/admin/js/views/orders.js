import { h, mount } from '../ui/dom.js';
import { card, dataTable, modal, pageHead, toast, watchJob } from '../ui/components.js';
import { dateTime, EXCEPTION_REASONS, money, ORDER_STATUS, orderBadge } from '../ui/format.js';

// Mirrors business-rules/orders.ts TRANSITIONS so the UI only offers valid next steps.
// The server re-validates every transition and permission.
const TRANSITIONS = {
  new_order: ['awaiting_review', 'cancelled', 'exception'],
  awaiting_review: ['awaiting_approval', 'cancelled', 'exception'],
  awaiting_approval: ['approved', 'cancelled', 'exception'],
  approved: ['po_submitted', 'cancelled', 'exception'],
  po_submitted: ['supplier_confirmed', 'exception', 'cancelled'],
  supplier_confirmed: ['in_transit', 'exception', 'cancelled'],
  in_transit: ['received_at_ubc', 'shipped_to_customer', 'exception'],
  received_at_ubc: ['ready_for_pickup', 'shipped_to_customer', 'exception'],
  ready_for_pickup: ['completed', 'exception'],
  shipped_to_customer: ['completed', 'exception'],
  completed: ['exception'],
  exception: ['awaiting_review', 'awaiting_approval', 'approved', 'po_submitted', 'cancelled', 'completed'],
  cancelled: [],
};
const FLOW = ['new_order', 'awaiting_review', 'awaiting_approval', 'approved', 'po_submitted', 'supplier_confirmed', 'in_transit', 'received_at_ubc', 'ready_for_pickup', 'completed'];
const ACTION_LABEL = {
  awaiting_review: 'Send to review', awaiting_approval: 'Ready for approval', approved: 'Approve purchase', po_submitted: 'Send PO to supplier',
  supplier_confirmed: 'Supplier confirmed', in_transit: 'Mark in transit', received_at_ubc: 'Received at UBC', ready_for_pickup: 'Ready for pickup',
  shipped_to_customer: 'Shipped to customer', completed: 'Complete', exception: 'Report exception', cancelled: 'Cancel order',
};

export function nextSteps(status, method) {
  return (TRANSITIONS[status] || []).filter((s) => !(method === 'pickup' && s === 'shipped_to_customer') && !(method === 'ship' && s === 'ready_for_pickup'));
}

export async function renderOrders(ctx) {
  const f = { status: ctx.query.status || '', special: ctx.query.special || '', q: '' };
  const host = h('div');
  const load = async () => {
    const r = await ctx.api.orders({ status: f.status || undefined, special: f.special || undefined, q: f.q || undefined });
    if (!ctx.isCurrent()) return;
    mount(host, dataTable({
      columns: [
        { key: 'number', label: 'Order', render: (o) => h('a', { href: '#/orders/' + o.id }, o.number) },
        { key: 'date', label: 'Date', opt: true, render: (o) => dateTime(o.created_at) },
        { key: 'cust', label: 'Customer', opt: true, render: (o) => o.customer_name },
        { key: 'type', label: 'Type', render: (o) => (o.is_special_order ? h('span.badge.violet', 'Special order') : h('span.badge', 'UBC stock')) },
        { key: 'method', label: 'Fulfilment', opt: true, render: (o) => (o.fulfillment_method === 'pickup' ? 'Pickup at UBC' : 'Ship to customer') },
        { key: 'total', label: 'Total', num: true, render: (o) => money(o.total_cents) },
        { key: 'shop', label: 'Shopify', opt: true, render: (o) => h('span.small.muted', o.financial_status + ' · ' + o.shopify_fulfillment_status) },
        { key: 'status', label: 'Internal status', render: (o) => orderBadge(o.internal_status) },
      ],
      rows: r.orders, onRowClick: (o) => ctx.navigate('#/orders/' + o.id), empty: 'No orders match.',
    }));
  };
  const statusSel = h('select', { onchange: (e) => { f.status = e.target.value; load(); } },
    [h('option', { value: '' }, 'Any status')].concat(Object.keys(ORDER_STATUS).map((k) => h('option', { value: k, selected: f.status === k }, ORDER_STATUS[k][0]))));
  const typeSel = h('select', { onchange: (e) => { f.special = e.target.value; load(); } },
    [['', 'All orders'], ['true', 'Special orders'], ['false', 'UBC stock orders']].map(([v, t]) => h('option', { value: v, selected: f.special === v }, t)));
  let t = null;
  const search = h('input', { type: 'search', placeholder: 'Order # or customer', oninput: (e) => { f.q = e.target.value; clearTimeout(t); t = setTimeout(load, 250); } });
  await load();
  return h('div.stack',
    pageHead('Orders', 'Internal statuses are separate from Shopify’s financial/fulfilment statuses', ctx.can('orders.write') ? [h('a.btn', { href: '#/store' }, 'New demo purchase')] : []),
    h('section.card', h('div.filters', h('label.field.grow', 'Search', search), h('label.field', 'Status', statusSel), h('label.field', 'Type', typeSel)), host));
}

export async function renderOrderDetail(ctx) {
  const d = await ctx.api.order(ctx.params.id);
  const o = d.order;
  const steps = nextSteps(o.internal_status, o.fulfillment_method);
  const reload = () => ctx.navigate('#/orders/' + o.id + '?r=' + Date.now());

  const doTransition = async (to) => {
    const needsNote = to === 'exception' || to === 'cancelled';
    const needsTracking = to === 'in_transit' || to === 'shipped_to_customer';
    if (!needsNote && !needsTracking && to !== 'approved' && to !== 'po_submitted') {
      return send({ to });
    }
    const note = h('textarea', { placeholder: needsNote ? 'Required: what happened?' : 'Optional note' });
    const reason = h('select', Object.keys(EXCEPTION_REASONS).map((k) => h('option', { value: k }, EXCEPTION_REASONS[k])));
    const tracking = h('input', { type: 'text', placeholder: 'Carrier tracking number' });
    const body = [];
    if (to === 'approved') {
      body.push(h('p', 'You are authorising the purchase from the supplier for this order. Availability and cost are re-checked with the supplier before approval is recorded.'));
      d.purchaseOrders.filter((p) => p.status === 'awaiting_approval').forEach((p) => body.push(h('div.notice.info', p.supplier_code + ' · ' + p.po_number + ' · ' + money(p.total_cents) + ' · ship to ' + (p.ship_to === 'customer' ? 'customer' : 'UBC'))));
    }
    if (to === 'po_submitted') body.push(h('div.notice.warn', 'This sends the approved purchase order to the supplier using its authorised method. In DEMO nothing is really ordered.'));
    if (to === 'exception') body.push(h('label.field', 'Reason', reason));
    if (needsTracking) body.push(h('label.field', 'Tracking (optional)', tracking));
    body.push(h('label.field', needsNote ? 'Note (required)' : 'Note', note));
    const err = h('div');
    body.push(err);
    const ok = h('button.btn', { class: to === 'cancelled' || to === 'exception' ? 'danger solid' : 'primary', onclick: async () => {
      if (needsNote && !note.value.trim()) { mount(err, h('div.notice.bad', 'Please add a note.')); return; }
      ok.disabled = true;
      const done = await send({ to, note: note.value.trim() || undefined, reason: to === 'exception' ? reason.value : undefined, tracking: tracking.value.trim() || undefined }, err);
      ok.disabled = false;
      if (done) m.close();
    } }, ACTION_LABEL[to]);
    const m = modal({ title: ACTION_LABEL[to] + ' — ' + o.number, body, actions: [h('button.btn', { onclick: () => m.close() }, 'Close'), ok] });
    return null;
  };

  async function send(body, errHost) {
    try {
      const r = await ctx.api.transition(o.id, body);
      if (r.queued) {
        toast('Sending purchase order…');
        for (const j of r.jobs) {
          const job = await watchJob(ctx.api, j);
          if (job.status !== 'succeeded') toast('PO submission failed after retries: ' + job.last_error, 'bad');
        }
      }
      toast('Order updated', 'ok');
      ctx.refreshBadges();
      reload();
      return true;
    } catch (e) {
      if (errHost) mount(errHost, h('div.notice.bad', e.message));
      else toast(e.message, 'bad');
      if (e.code === 'REVALIDATION_FAILED') reload();
      return false;
    }
  }

  const flowIdx = FLOW.indexOf(o.internal_status);
  const flow = o.is_special_order ? FLOW : ['new_order', 'received_at_ubc', o.fulfillment_method === 'pickup' ? 'ready_for_pickup' : 'shipped_to_customer', 'completed'];
  return h('div.stack',
    pageHead('Order ' + o.number, (o.is_special_order ? 'Special order' : 'UBC stock order') + ' · ' + (o.fulfillment_method === 'pickup' ? 'Pickup at UBC' : 'Ship to customer') + ' · ' + dateTime(o.created_at),
      [h('a.btn', { href: '#/orders' }, '← Orders')]),
    h('div.stepper', flow.map((s) => {
      const i = FLOW.indexOf(s);
      const cur = s === o.internal_status;
      return h('span', { class: cur ? 'current' : (o.internal_status === 'completed' || (flowIdx >= 0 && i >= 0 && i < flowIdx)) ? 'done' : '' }, ORDER_STATUS[s][0]);
    }), o.internal_status === 'exception' || o.internal_status === 'cancelled' ? h('span.current', ORDER_STATUS[o.internal_status][0]) : null),
    o.internal_status === 'exception' ? h('div.notice.bad', 'Exception: ' + (EXCEPTION_REASONS[o.exception_reason] || o.exception_reason || 'unspecified') + '. See the timeline for details.') : null,
    o.internal_status === 'awaiting_approval' ? h('div.notice.warn', 'Purchase request waiting for approval by purchasing (Carlos). Nothing is ordered from the supplier until it is approved.') : null,
    ctx.can('orders.write') && steps.length ? card('Next step', h('div.row', steps.map((s) => h('button.btn', {
      class: s === 'exception' || s === 'cancelled' ? 'danger' : ['approved', 'po_submitted'].indexOf(s) >= 0 ? 'primary' : '',
      disabled: (s === 'approved' || s === 'po_submitted') && !ctx.can('purchasing.approve'),
      title: (s === 'approved' || s === 'po_submitted') && !ctx.can('purchasing.approve') ? 'Requires purchasing approval permission' : null,
      onclick: () => doTransition(s),
    }, ACTION_LABEL[s])))) : null,
    h('div.grid.grid-2',
      card('Lines', dataTable({
        columns: [
          { key: 'title', label: 'Item', cls: 'title-cell', render: (l) => h('div', l.variant_id ? h('a', { href: '#/products/' + l.variant_id }, l.title) : l.title, h('div.sku', l.sku)) },
          { key: 'qty', label: 'Qty', num: true },
          { key: 'price', label: 'Price', num: true, render: (l) => money(l.price_cents) },
          { key: 'src', label: 'Fulfilled from', render: (l) => (l.source === 'ubc_stock' ? h('span.badge.ok', 'UBC stock') : l.source === 'supplier' ? h('span.badge.violet', l.supplier_code + ' · cost ' + money(l.quoted_cost_cents)) : h('span.badge.bad', 'Unavailable')) },
        ],
        rows: d.lines,
      }), { flush: true }),
      card('Shopify & customer', h('dl.props',
        h('dt', 'Customer'), h('dd', o.customer_name || '—'),
        h('dt', 'Payment (Shopify)'), h('dd', o.financial_status),
        h('dt', 'Fulfilment (Shopify)'), h('dd', o.shopify_fulfillment_status),
        h('dt', 'Internal status'), h('dd', orderBadge(o.internal_status)),
        h('dt', 'Tracking'), h('dd', o.tracking ? h('code', o.tracking) : '—'),
        h('dt', 'Total'), h('dd', money(o.total_cents))))),
    d.purchaseOrders.length ? card('Purchase orders to suppliers', dataTable({
      columns: [
        { key: 'po', label: 'PO', render: (p) => h('code', p.po_number) },
        { key: 'sup', label: 'Supplier', render: (p) => p.supplier_code },
        { key: 'status', label: 'Status', render: (p) => h('span.badge', { class: p.status === 'exception' ? 'bad' : p.status === 'awaiting_approval' ? 'warn' : 'info' }, p.status.replace(/_/g, ' ')) },
        { key: 'total', label: 'Cost', num: true, render: (p) => money(p.total_cents) },
        { key: 'ship', label: 'Ship to', opt: true, render: (p) => (p.ship_to === 'customer' ? 'Customer (drop-ship)' : 'UBC') },
        { key: 'appr', label: 'Approved by', opt: true, render: (p) => p.approved_by_name || '—' },
        { key: 'ref', label: 'Supplier ref.', opt: true, render: (p) => p.external_ref || '—' },
      ],
      rows: d.purchaseOrders,
    }), { flush: true }) : null,
    card('Timeline', h('ul.timeline', d.events.slice().reverse().map((e) => h('li',
      h('div', h('strong', ORDER_STATUS[e.to_status] ? ORDER_STATUS[e.to_status][0] : e.to_status), h('span.muted', ' · ' + e.actor)),
      e.note ? h('div.small', e.note) : null,
      h('div.when', dateTime(e.created_at)))))));
}
