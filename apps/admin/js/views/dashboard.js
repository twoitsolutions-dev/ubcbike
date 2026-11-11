import { h } from '../ui/dom.js';
import { card, pageHead, dataTable } from '../ui/components.js';
import { ago, campaignBadge, adjustmentLabel, money, orderBadge } from '../ui/format.js';

export async function renderDashboard(ctx) {
  const [d, orders, camps] = await Promise.all([
    ctx.api.dashboard(),
    ctx.api.orders({}),
    ctx.api.campaigns(),
  ]);
  const c = d.counts;
  const kpi = (label, value, href, hint, cls) => h(href ? 'a.kpi' : 'div.kpi', { href, class: cls || '' },
    h('div.label', label), h('div.value', typeof value === 'number' ? value.toLocaleString('en-US') : value), hint ? h('div.hint', hint) : null);

  const attention = [];
  if (c.awaitingApproval) attention.push(['Purchase approvals waiting', c.awaitingApproval, '#/orders?status=awaiting_approval', 'warn']);
  const exc = orders.orders.filter((o) => o.internal_status === 'exception').length;
  if (exc) attention.push(['Orders in Exception', exc, '#/orders?status=exception', 'bad']);
  if (c.openErrors) attention.push(['Unresolved errors', c.openErrors, '#/activity', 'bad']);
  if (c.deadJobs) attention.push(['Failed background jobs', c.deadJobs, '#/activity', 'bad']);
  if (c.pendingMatchReviews) attention.push(['Supplier matches to review', c.pendingMatchReviews, '#/suppliers', 'warn']);

  const active = camps.campaigns.filter((x) => ['active', 'scheduled', 'applying', 'restoring'].indexOf(x.status) >= 0);
  const recentOrders = orders.orders.slice(0, 6);

  return h('div.stack',
    pageHead('Good day, ' + ctx.me.user.name.split(' ')[0], 'Catalog, pricing and special-order status for University Bicycle Center',
      [ctx.can('pricing.write') ? h('a.btn.primary', { href: '#/promotions/new' }, 'New promotion') : null, h('a.btn', { href: '#/orders' }, 'Orders')]),
    h('div.kpis',
      kpi('Published products', c.published, '#/products?status=published', 'of ' + c.total.toLocaleString('en-US') + ' SKUs'),
      kpi('In stock at UBC', c.physical, '#/inventory?stock=physical', 'SKUs with sellable units'),
      kpi('Supplier-only (virtual)', c.virtualOnly, '#/products?stock=virtual_only', 'SKUs sold as special order'),
      kpi('Unavailable', c.unavailable, '#/products?stock=unavailable', 'no stock, no fresh offer'),
      kpi('Orders received', c.orders, '#/orders'),
      kpi('Open special orders', c.pendingSpecial, '#/orders?special=true', null, c.pendingSpecial ? 'attn' : ''),
      kpi('Active promotions', c.activeCampaigns, '#/promotions'),
      kpi('Errors needing attention', c.openErrors + c.deadJobs, '#/activity', null, c.openErrors + c.deadJobs ? 'bad' : ''),
      kpi('Shopify sales', '—', null, d.shopifySales.reason)),
    h('div.grid.grid-2',
      card('Needs attention', attention.length
        ? h('div.stack', attention.map(([label, n, href, kind]) => h('a.row', { href, style: { justifyContent: 'space-between' } }, h('span', label), h('span.badge', { class: kind }, String(n)))))
        : h('p.muted', 'Nothing urgent. All approvals and syncs are up to date.')),
      card('Active & scheduled promotions', active.length
        ? dataTable({
          columns: [
            { key: 'name', label: 'Campaign', render: (r) => h('a', { href: '#/promotions/' + r.id }, r.name) },
            { key: 'adj', label: 'Change', render: (r) => adjustmentLabel(r.adjustment) },
            { key: 'status', label: 'Status', render: (r) => campaignBadge(r.status) },
          ],
          rows: active,
        })
        : h('p.muted', 'No active promotions.'), { flush: !!active.length })),
    h('div.grid.grid-2',
      card('Latest orders', dataTable({
        columns: [
          { key: 'number', label: 'Order', render: (r) => h('a', { href: '#/orders/' + r.id }, r.number) },
          { key: 'type', label: 'Type', opt: true, render: (r) => (r.is_special_order ? h('span.badge.violet', 'Special') : h('span.badge', 'Stock')) },
          { key: 'total', label: 'Total', num: true, render: (r) => money(r.total_cents) },
          { key: 'status', label: 'Status', render: (r) => orderBadge(r.internal_status) },
        ],
        rows: recentOrders,
      }), { flush: true }),
      card('Recent syncs & background jobs', d.recentJobs.length
        ? dataTable({
          columns: [
            { key: 'type', label: 'Job', render: (r) => h('code', r.type) },
            { key: 'status', label: 'Status', render: (r) => h('span.badge', { class: r.status === 'succeeded' ? 'ok' : r.status === 'dead' ? 'bad' : 'info' }, r.status) },
            { key: 'when', label: 'When', render: (r) => ago(r.finished_at || r.created_at) },
          ],
          rows: d.recentJobs,
        })
        : h('p.muted', 'No background jobs yet. Bulk changes, promotions and supplier imports appear here.'), { flush: !!d.recentJobs.length })));
}
