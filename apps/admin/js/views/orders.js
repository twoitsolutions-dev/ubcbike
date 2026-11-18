import { h, mount, clear } from '../ui/dom.js';
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
  awaiting_review: 'Send to review', awaiting_approval: 'Ready for approval', approved: 'Approve B2B purchase', po_submitted: 'Mark ordered in B2B',
  supplier_confirmed: 'Supplier confirmed', in_transit: 'Mark in transit', received_at_ubc: 'Received at UBC', ready_for_pickup: 'Ready for pickup',
  shipped_to_customer: 'Shipped to customer', completed: 'Complete', exception: 'Report exception', cancelled: 'Cancel order',
};

export const B2B_PORTALS = {
  QBP: ['QBP B2B', 'https://www.qbp.com'],
  JBI: ['JBI.bike', 'https://www.jbi.bike'],
  SPECIALIZED: ['Specialized B2B', 'https://b2b.specialized.com'],
};

export async function copyToClipboard(text, msg) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      toast(msg || 'Copied: ' + text, 'ok');
      return;
    }
  } catch (e) { /* fallback below */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand('copy');
    toast(msg || 'Copied: ' + text, 'ok');
  } catch (e) {
    toast('Copy manually: ' + text, 'warn');
  }
  document.body.removeChild(ta);
}

export function nextSteps(status, method) {
  return (TRANSITIONS[status] || []).filter((s) => !(method === 'pickup' && s === 'shipped_to_customer') && !(method === 'ship' && s === 'ready_for_pickup'));
}

export async function renderOrders(ctx) {
  const f = { status: ctx.query.status || '', special: ctx.query.special || '', q: '' };
  const host = h('div');
  const quickHost = h('div.seg-group');

  const statusSel = h('select', { onchange: (e) => { f.status = e.target.value; drawQuick(); load(); } },
    [h('option', { value: '' }, 'Any status')].concat(Object.keys(ORDER_STATUS).map((k) => h('option', { value: k, selected: f.status === k }, ORDER_STATUS[k][0]))));
  const typeSel = h('select', { onchange: (e) => { f.special = e.target.value; drawQuick(); load(); } },
    [['', 'All orders'], ['true', 'Special Orders (Vendor B2B)'], ['false', 'In-Store Stock (UBC)']].map(([v, t]) => h('option', { value: v, selected: f.special === v }, t)));

  const drawQuick = () => {
    clear(quickHost);
    const presets = [
      ['all', 'All Orders', '', ''],
      ['special', 'Special Orders', 'true', ''],
      ['awaiting', 'Awaiting B2B PO', '', 'awaiting_approval'],
      ['store', 'In-Store Stock', 'false', ''],
      ['exception', 'Exceptions', '', 'exception'],
    ];
    presets.forEach(([, label, sp, st]) => {
      const isOn = f.special === sp && f.status === st;
      quickHost.appendChild(h('button.seg-btn', {
        type: 'button',
        class: isOn ? 'on' : '',
        onclick: () => {
          f.special = sp;
          f.status = st;
          typeSel.value = sp;
          statusSel.value = st;
          drawQuick();
          load();
        },
      }, label));
    });
  };

  const load = async () => {
    const r = await ctx.api.orders({ status: f.status || undefined, special: f.special || undefined, q: f.q || undefined });
    if (!ctx.isCurrent()) return;
    mount(host, dataTable({
      columns: [
        { key: 'number', label: 'Order #', render: (o) => h('a', { href: '#/orders/' + o.id }, h('strong', o.number)) },
        { key: 'date', label: 'Date', opt: true, render: (o) => dateTime(o.created_at) },
        { key: 'cust', label: 'Customer', opt: true, render: (o) => o.customer_name },
        { key: 'type', label: 'Order Type', render: (o) => (o.is_special_order ? h('span.badge.violet', 'Special Order') : h('span.badge', 'In-Store Stock')) },
        { key: 'method', label: 'Fulfillment', opt: true, render: (o) => (o.fulfillment_method === 'pickup' ? 'Pickup at UBC' : 'Ship to customer') },
        { key: 'total', label: 'Total', num: true, render: (o) => money(o.total_cents) },
        { key: 'shop', label: 'Shopify', opt: true, render: (o) => h('span.small.muted', o.financial_status + ' · ' + o.shopify_fulfillment_status) },
        { key: 'status', label: 'Status', render: (o) => orderBadge(o.internal_status) },
      ],
      rows: r.orders, onRowClick: (o) => ctx.navigate('#/orders/' + o.id), empty: 'No orders match these filters.',
    }));
  };

  let t = null;
  const search = h('input', { type: 'search', placeholder: 'Order # or customer name…', oninput: (e) => { f.q = e.target.value; clearTimeout(t); t = setTimeout(load, 250); } });
  drawQuick();
  await load();
  return h('div.stack',
    pageHead('Special Orders', 'Customer orders from Shopify — tracks Vendor Special Orders separately from In-Store Stock fulfillment.',
      [h('a.btn', { href: '#/purchasing' }, 'Purchase Orders (B2B)')]),
    quickHost,
    h('section.card', h('div.filters', h('label.field.grow', 'Search', search), h('label.field', 'Status', statusSel), h('label.field', 'Order Type', typeSel)), host));
}

function renderB2bQuickCard(p) {
  const portal = B2B_PORTALS[p.supplier_code];
  const lines = p.lines || [];
  const onlySkus = lines.map((l) => l.supplier_sku).filter(Boolean).join(', ');
  const skuWithQty = lines.map((l) => l.supplier_sku + '\t' + l.qty).join('\n');
  return h('div.notice.info',
    h('div.row-between',
      h('div',
        h('strong', p.supplier_code + ' (' + p.po_number + ')'),
        ' · ',
        h('code', lines.map((l) => l.supplier_sku + ' × ' + l.qty).join(', ') || '—'),
        ' · est. cost ' + money(p.total_cents)),
      h('div.row',
        onlySkus ? h('button.btn.sm.primary', {
          type: 'button',
          onclick: (ev) => { ev.stopPropagation(); copyToClipboard(onlySkus, 'Copied B2B SKU: ' + onlySkus); },
        }, 'Copy SKU') : null,
        skuWithQty && lines.length > 0 ? h('button.btn.sm', {
          type: 'button',
          onclick: (ev) => { ev.stopPropagation(); copyToClipboard(skuWithQty, 'Copied SKU + Qty for B2B Quick Order'); },
        }, 'Copy SKU + Qty') : null,
        portal ? h('a.btn.sm', {
          href: portal[1], target: '_blank', rel: 'noopener noreferrer',
          onclick: (ev) => ev.stopPropagation(),
        }, 'Open ' + portal[0] + ' ↗') : null)));
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
    const note = h('textarea', { placeholder: needsNote ? 'Required: what happened?' : 'Optional note (e.g. combined with weekly freight order)' });
    const reason = h('select', Object.keys(EXCEPTION_REASONS).map((k) => h('option', { value: k }, EXCEPTION_REASONS[k])));
    const tracking = h('input', { type: 'text', placeholder: 'Carrier tracking number' });
    const externalRef = h('input', { type: 'text', placeholder: 'e.g. QBP-884120 / JBI-55190 / SPEC-3091' });
    const body = [];
    if (to === 'approved') {
      body.push(h('p', 'Verify cost & stock in the brand B2B portal before approving. Nothing is auto-ordered — Carlos places the order directly in the B2B portal.'));
      d.purchaseOrders.filter((p) => p.status === 'awaiting_approval').forEach((p) => body.push(renderB2bQuickCard(p)));
    }
    if (to === 'po_submitted') {
      body.push(h('p', 'Copy the SKU below into the brand B2B portal (you can combine it with shop restock for free freight), then paste the B2B confirmation number here:'));
      d.purchaseOrders.filter((p) => p.status === 'approved').forEach((p) => body.push(renderB2bQuickCard(p)));
      body.push(h('label.field', 'B2B Order / Confirmation # (from brand portal)', externalRef));
    }
    if (to === 'exception') body.push(h('label.field', 'Reason', reason));
    if (needsTracking) body.push(h('label.field', 'Tracking (optional)', tracking));
    body.push(h('label.field', needsNote ? 'Note (required)' : 'Note', note));
    const err = h('div');
    body.push(err);
    const ok = h('button.btn', { class: to === 'cancelled' || to === 'exception' ? 'danger solid' : 'primary', onclick: async () => {
      if (needsNote && !note.value.trim()) { mount(err, h('div.notice.bad', 'Please add a note.')); return; }
      ok.disabled = true;
      const done = await send({
        to,
        note: note.value.trim() || undefined,
        reason: to === 'exception' ? reason.value : undefined,
        tracking: tracking.value.trim() || undefined,
        externalRef: to === 'po_submitted' ? (externalRef.value.trim() || undefined) : undefined,
      }, err);
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
    pageHead('Order ' + o.number, (o.is_special_order ? 'Special Order (Vendor B2B)' : 'In-Store Stock Order') + ' · ' + (o.fulfillment_method === 'pickup' ? 'Pickup at UBC' : 'Ship to customer') + ' · ' + dateTime(o.created_at),
      [h('a.btn', { href: '#/orders' }, '← Special Orders')]),
    h('div.stepper', flow.map((s) => {
      const i = FLOW.indexOf(s);
      const cur = s === o.internal_status;
      return h('span', { class: cur ? 'current' : (o.internal_status === 'completed' || (flowIdx >= 0 && i >= 0 && i < flowIdx)) ? 'done' : '' }, ORDER_STATUS[s][0]);
    }), o.internal_status === 'exception' || o.internal_status === 'cancelled' ? h('span.current', ORDER_STATUS[o.internal_status][0]) : null),
    o.internal_status === 'exception' ? h('div.notice.bad', 'Exception: ' + (EXCEPTION_REASONS[o.exception_reason] || o.exception_reason || 'unspecified') + '. See the timeline for details.') : null,
    o.internal_status === 'awaiting_approval' ? h('div.notice.warn', 'Special Order item(s) waiting for Carlos to review & place as a Purchase Order in the Vendor B2B portal.') : null,
    ctx.can('orders.write') && steps.length ? card('Next step', h('div.row', steps.map((s) => h('button.btn', {
      class: s === 'exception' || s === 'cancelled' ? 'danger' : ['approved', 'po_submitted'].indexOf(s) >= 0 ? 'primary' : '',
      disabled: (s === 'approved' || s === 'po_submitted') && !ctx.can('purchasing.approve'),
      title: (s === 'approved' || s === 'po_submitted') && !ctx.can('purchasing.approve') ? 'Requires purchasing approval permission' : null,
      onclick: () => doTransition(s),
    }, ACTION_LABEL[s])))) : null,
    d.purchaseOrders.length ? card('Purchase Orders / Vendor B2B Worksheets', dataTable({
      columns: [
        { key: 'po', label: 'PO #', render: (p) => h('code', p.po_number) },
        { key: 'sup', label: 'Vendor', render: (p) => p.supplier_code },
        {
          key: 'skus', label: 'Vendor Part # × Qty', render: (p) => {
            const shared = Array.isArray(p.shared_open_orders) ? p.shared_open_orders.filter(Boolean) : [];
            return h('div.stack-sm',
              h('code', (p.lines || []).map((l) => l.supplier_sku + ' × ' + l.qty).join(', ') || '—'),
              shared.length ? h('div', h('span.badge.warn', {
                title: 'Another customer also ordered this SKU — allocate 1-to-1 by Order #',
              }, 'Shared SKU: also in ' + shared.join(', '))) : null);
          },
        },
        {
          key: 'actions', label: 'Quick B2B', render: (p) => {
            const portal = B2B_PORTALS[p.supplier_code];
            const onlySkus = (p.lines || []).map((l) => l.supplier_sku).filter(Boolean).join(', ');
            return h('div.row',
              onlySkus ? h('button.btn.sm.primary', {
                type: 'button',
                onclick: (ev) => { ev.stopPropagation(); copyToClipboard(onlySkus, 'Copied Vendor Part #: ' + onlySkus); },
              }, 'Copy SKU') : null,
              portal ? h('a.btn.sm', {
                href: portal[1], target: '_blank', rel: 'noopener noreferrer',
                onclick: (ev) => ev.stopPropagation(),
              }, 'Open ' + portal[0] + ' ↗') : null);
          },
        },
        { key: 'status', label: 'PO Status', render: (p) => h('span.badge', { class: p.status === 'exception' ? 'bad' : p.status === 'awaiting_approval' ? 'warn' : 'info' }, p.status.replace(/_/g, ' ')) },
        { key: 'total', label: 'Est. Cost', num: true, render: (p) => money(p.total_cents) },
        { key: 'ship', label: 'Deliver To', opt: true, render: (p) => (p.ship_to === 'customer' ? 'Customer' : 'UBC Store') },
        { key: 'ref', label: 'Vendor Order #', opt: true, render: (p) => (p.external_ref ? h('code', p.external_ref) : '—') },
      ],
      rows: d.purchaseOrders,
    }), { flush: true }) : null,
    h('div.grid.grid-2',
      card('Lines', dataTable({
        columns: [
          {
            key: 'title', label: 'Item', cls: 'title-cell', render: (l) => {
              const skuToCopy = l.supplier_sku || l.sku;
              const shared = Array.isArray(l.shared_open_orders) ? l.shared_open_orders.filter(Boolean) : [];
              return h('div',
                l.variant_id ? h('a', { href: '#/products/' + l.variant_id }, l.title) : l.title,
                h('div.row',
                  h('span.sku', l.supplier_sku ? 'B2B SKU: ' + l.supplier_sku + ' (Store: ' + l.sku + ')' : l.sku),
                  skuToCopy ? h('button.btn.sm', {
                    type: 'button',
                    onclick: (ev) => { ev.stopPropagation(); copyToClipboard(skuToCopy, 'Copied SKU: ' + skuToCopy); },
                  }, 'Copy SKU') : null,
                  shared.length ? h('span.badge.warn', 'Shared SKU: also in ' + shared.join(', ')) : null));
            },
          },
          { key: 'qty', label: 'Qty', num: true },
          { key: 'price', label: 'Price', num: true, render: (l) => money(l.price_cents) },
          { key: 'src', label: 'Fulfilled from', render: (l) => (l.source === 'ubc_stock' ? h('span.badge.ok', 'UBC stock') : l.source === 'supplier' ? h('span.badge.violet', l.supplier_code + ' · cost ' + money(l.quoted_cost_cents)) : l.source === 'workstand_catalog' ? h('span.badge', { title: 'Not a Lightspeed item — handled by Workstand' }, 'Workstand catalog') : h('span.badge.bad', 'Unavailable')) },
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
    card('Timeline', h('ul.timeline', d.events.slice().reverse().map((e) => h('li',
      h('div', h('strong', ORDER_STATUS[e.to_status] ? ORDER_STATUS[e.to_status][0] : e.to_status), h('span.muted', ' · ' + e.actor)),
      e.note ? h('div.small', e.note) : null,
      h('div.when', dateTime(e.created_at)))))));
}
