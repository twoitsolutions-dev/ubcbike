import { h } from '../ui/dom.js';
import { card, dataTable, pageHead } from '../ui/components.js';
import { dateTime, money } from '../ui/format.js';

const PO_BADGE = { awaiting_approval: 'warn', approved: 'info', submitted: 'info', confirmed: 'info', in_transit: 'info', received: 'ok', cancelled: '', exception: 'bad' };

export async function renderPurchasing(ctx) {
  const r = await ctx.api.purchaseOrders();
  const waiting = r.purchaseOrders.filter((p) => p.status === 'awaiting_approval');
  return h('div.stack',
    pageHead('Supplier purchasing', 'Purchase orders generated from special orders. None is sent to a supplier without a recorded human approval.'),
    waiting.length ? h('div.notice.warn', waiting.length + ' purchase request(s) waiting for approval. Open the order to review and approve.') : null,
    card(null, dataTable({
      columns: [
        { key: 'po', label: 'PO', render: (p) => h('code', p.po_number) },
        { key: 'sup', label: 'Supplier', render: (p) => p.supplier_code },
        { key: 'order', label: 'Customer order', render: (p) => (p.order_id ? h('a', { href: '#/orders/' + p.order_id }, p.order_number) : '—') },
        { key: 'status', label: 'Status', render: (p) => h('span.badge', { class: PO_BADGE[p.status] || '' }, p.status.replace(/_/g, ' ')) },
        { key: 'total', label: 'Cost', num: true, render: (p) => money(p.total_cents) },
        { key: 'ship', label: 'Ship to', opt: true, render: (p) => (p.ship_to === 'customer' ? 'Customer' : 'UBC') },
        { key: 'appr', label: 'Approved', opt: true, render: (p) => (p.approved_by ? p.approved_by + ' · ' + dateTime(p.approved_at) : '—') },
        { key: 'ref', label: 'Supplier ref.', opt: true, render: (p) => p.external_ref || '—' },
        { key: 'trk', label: 'Tracking', opt: true, render: (p) => p.tracking || '—' },
      ],
      rows: r.purchaseOrders, onRowClick: (p) => p.order_id && ctx.navigate('#/orders/' + p.order_id), empty: 'No purchase orders yet.',
    }), { flush: true }));
}
