import { h, mount, clear } from '../ui/dom.js';
import { card, dataTable, pageHead } from '../ui/components.js';
import { money } from '../ui/format.js';
import { B2B_PORTALS, copyToClipboard } from './orders.js?v=81';

const PO_BADGE = { awaiting_approval: 'warn', approved: 'info', submitted: 'info', confirmed: 'info', in_transit: 'info', received: 'ok', cancelled: '', exception: 'bad' };

export async function renderPurchasing(ctx) {
  const r = await ctx.api.purchaseOrders();
  const all = r.purchaseOrders || [];
  const waiting = all.filter((p) => p.status === 'awaiting_approval' || p.status === 'approved');
  let tab = 'all';
  const tabsHost = h('div.seg-group');
  const tableHost = h('div');

  const counts = {
    all: all.length,
    todo: all.filter((p) => p.status === 'awaiting_approval' || p.status === 'approved').length,
    active: all.filter((p) => ['submitted', 'confirmed', 'in_transit'].indexOf(p.status) >= 0).length,
    done: all.filter((p) => p.status === 'received').length,
  };

  const getRows = () => {
    if (tab === 'todo') return all.filter((p) => p.status === 'awaiting_approval' || p.status === 'approved');
    if (tab === 'active') return all.filter((p) => ['submitted', 'confirmed', 'in_transit'].indexOf(p.status) >= 0);
    if (tab === 'done') return all.filter((p) => p.status === 'received');
    return all;
  };

  const drawTabs = () => {
    clear(tabsHost);
    [
      ['all', 'All POs (' + counts.all + ')'],
      ['todo', 'To Order in B2B (' + counts.todo + ')'],
      ['active', 'Ordered & In Transit (' + counts.active + ')'],
      ['done', 'Received (' + counts.done + ')'],
    ].forEach(([k, label]) => {
      tabsHost.appendChild(h('button.seg-btn', {
        type: 'button',
        class: tab === k ? 'on' : '',
        onclick: () => { tab = k; drawTabs(); drawTable(); },
      }, label));
    });
  };

  const drawTable = () => {
    mount(tableHost, dataTable({
      columns: [
        { key: 'po', label: 'PO #', render: (p) => h('code', p.po_number) },
        { key: 'sup', label: 'Vendor', render: (p) => h('strong', p.supplier_code) },
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
        { key: 'order', label: 'Special Order #', render: (p) => (p.order_id ? h('a', { href: '#/orders/' + p.order_id }, h('strong', p.order_number)) : '—') },
        { key: 'status', label: 'PO Status', render: (p) => h('span.badge', { class: PO_BADGE[p.status] || '' }, p.status.replace(/_/g, ' ')) },
        { key: 'total', label: 'Est. Cost', num: true, render: (p) => money(p.total_cents) },
        { key: 'ship', label: 'Deliver To', opt: true, render: (p) => (p.ship_to === 'customer' ? 'Customer' : 'UBC Store') },
        { key: 'ref', label: 'Vendor Order #', opt: true, render: (p) => p.external_ref || '—' },
        { key: 'trk', label: 'Tracking', opt: true, render: (p) => p.tracking || '—' },
      ],
      rows: getRows(), onRowClick: (p) => p.order_id && ctx.navigate('#/orders/' + p.order_id), empty: 'No Purchase Orders in this view right now.',
    }));
  };

  drawTabs();
  drawTable();

  return h('div.stack',
    pageHead('Purchase Orders (B2B)', '1-to-1 Vendor Purchase Orders for customer Special Orders (QBP, JBI, Specialized). Copy Vendor Part # and place directly in the distributor B2B portal.',
      [h('a.btn', { href: '#/orders?special=true' }, 'View Special Orders')]),
    waiting.length ? h('div.notice.warn', waiting.length + ' Purchase Order(s) ready to place in Vendor B2B. Click "Copy SKU" to paste into QBP/JBI/Specialized, or open the Special Order # to record your Vendor Order #.') : null,
    card('Vendor Purchase Orders', tableHost, { flush: true, actions: tabsHost }));
}
