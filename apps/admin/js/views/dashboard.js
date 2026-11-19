import { h } from '../ui/dom.js';
import { card, pageHead, dataTable } from '../ui/components.js';
import { ago, campaignBadge, adjustmentLabel, money, orderBadge } from '../ui/format.js';

export const JOB_LABELS = {
  'campaign.apply': 'Apply promotion prices',
  'campaign.restore': 'Restore regular prices',
  'supplier.import': 'Import vendor catalog feed',
  'supplier.import_feed': 'Import vendor catalog feed',
  'shopify.sync': 'Sync Shopify online catalog',
  'shopify.sync_catalog': 'Sync Shopify online catalog',
  'shopify.order_created': 'New Shopify order received',
  'shopify.order_updated': 'Shopify order updated',
  'shopify.order_cancelled': 'Shopify order cancellation check',
  'pipeline.flush': 'Publish ready items to Shopify',
  'pipeline.flush_shopify': 'Publish ready items to Shopify',
  'pipeline.watchdog': 'Vendor feed health check',
  'catalog.bulk_status': 'Bulk publish / hide items',
  'items.bulk_status': 'Bulk publish / hide items',
  'order.review': 'Evaluate incoming Special Order',
  'po.submit': 'Record vendor B2B PO',
  'lightspeed.sync_catalog': 'Read changes from Lightspeed',
  'lightspeed.sync_special_orders': 'Read Lightspeed special orders',
  'shopify.reconcile_links': 'Check Shopify prices & stock',
  'shopify.link_store': 'Find new UPC matches',
};

function pctOf(a, b) {
  return b ? Math.round((a / b) * 100) + '%' : '—';
}

function fmtNum(v) {
  return typeof v === 'number' ? v.toLocaleString('en-US') : '—';
}

function syncDetailsDrawer(s, recentJobs) {
  const row = (label, value, href) => h(href ? 'a.attn-row' : 'div.attn-row', { href },
    h('span', label), h('strong', value));

  const lsRows = s ? [
    row('In-stock items already online', pctOf(s.in_stock_linked, s.in_stock) + ' (' + fmtNum(s.in_stock_linked) + ' / ' + fmtNum(s.in_stock) + ')', '#/products'),
    row('In stock with UPC, not in Shopify yet', fmtNum(s.in_stock_missing), '#/products'),
    row('In stock without UPC in Lightspeed', fmtNum(s.in_stock_no_upc), null),
    row('Units in stock online', fmtNum(s.units_linked) + ' / ' + fmtNum(s.units), null),
    row('Last Lightspeed sync · check · UPC match', ago(s.lastLightspeedSyncAt) + ' · ' + ago(s.lastReconcileAt) + ' · ' + ago(s.lastMatchAt), '#/activity'),
  ] : [];

  const dupList = (s && s.duplicate_links && s.duplicate_links.length)
    ? h('div.dash-subblock',
      h('div.small.muted', s.duplicate_links.length + ' Lightspeed item(s) linked to 2+ Shopify products'),
      h('div.stack-sm', s.duplicate_links.slice(0, 8).map((dup) => h('a.attn-row', { href: '#/products/' + dup.id },
        h('span', h('strong', dup.title), h('div.sku', 'SKU ' + dup.sku)),
        h('strong', dup.variants + ' variants')))))
    : null;

  const jobsBlock = recentJobs.length
    ? h('div.dash-subblock',
      h('div.row-between',
        h('strong.small', 'Recent background jobs'),
        h('a.small', { href: '#/activity?tab=jobs' }, 'All logs →')),
      dataTable({
        columns: [
          { key: 'type', label: 'Task', render: (j) => JOB_LABELS[j.type] || j.type },
          { key: 'status', label: 'Status', render: (j) => h('span.badge', { class: j.status === 'succeeded' ? 'ok' : j.status === 'dead' ? 'bad' : 'warn' }, j.status) },
          { key: 'when', label: 'When', opt: true, render: (j) => ago(j.created_at) },
        ],
        rows: recentJobs,
      }))
    : null;

  return h('details.dash-details',
    h('summary.dash-details-summary',
      h('span', 'Sync & Coverage Details'),
      h('span.small.muted', s ? ('Lightspeed ' + ago(s.lastLightspeedSyncAt) + ' · ' + fmtNum(s.linked_items) + ' linked') : 'Tap to expand')),
    h('div.dash-details-body',
      lsRows.length ? h('div.attn-list', lsRows) : null,
      dupList,
      jobsBlock));
}

export async function renderDashboard(ctx) {
  const [d, orders, camps] = await Promise.all([
    ctx.api.dashboard(),
    ctx.api.orders({}),
    ctx.api.campaigns(),
  ]);
  const c = d.counts;
  const s = d.shopifySync || null;

  const attention = [];
  if (c.awaitingApproval) attention.push(['Special Orders waiting PO', c.awaitingApproval, '#/orders?status=awaiting_approval', 'warn']);
  const exc = orders.orders.filter((o) => o.internal_status === 'exception').length;
  if (exc) attention.push(['Orders in Exception', exc, '#/orders?status=exception', 'bad']);
  if (c.openErrors) attention.push(['Sync errors', c.openErrors, '#/activity?tab=errors', 'bad']);
  if (c.deadJobs) attention.push(['Failed jobs', c.deadJobs, '#/activity?tab=jobs', 'bad']);
  if (c.pendingMatchReviews) attention.push(['Vendor reviews', c.pendingMatchReviews, '#/suppliers', 'warn']);

  const active = camps.campaigns.filter((x) => ['active', 'scheduled', 'applying', 'restoring'].indexOf(x.status) >= 0);
  const recentOrders = orders.orders.slice(0, 4);
  const recentJobs = (d.recentJobs || []).slice(0, 4);

  const kpi = (label, value, href, hint, cls) => h(href ? 'a.kpi.dash-kpi' : 'div.kpi.dash-kpi', { href, class: cls || '' },
    h('div.label', label),
    h('div.value', typeof value === 'number' ? value.toLocaleString('en-US') : value),
    hint ? h('div.hint', hint) : null);

  const subtitle = s
    ? 'Lightspeed synced ' + ago(s.lastLightspeedSyncAt) + ' · ' + (attention.length ? attention.length + ' item(s) need attention' : 'All systems healthy')
    : (attention.length ? attention.length + ' item(s) need attention' : 'All systems healthy');

  const headerActions = [
    ctx.can('pricing.write') ? h('a.btn.primary.sm', { href: '#/promotions/new' }, '+ Promotion') : null,
    d.storeUrl ? h('a.btn.sm', { href: d.storeUrl, target: '_blank', rel: 'noopener' }, 'Store ↗') : null,
  ].filter(Boolean);

  const alertStrip = attention.length
    ? h('div.dash-alerts',
      h('span.dash-alerts-title', 'Needs attention'),
      h('div.dash-alerts-pills', attention.map(([label, n, href, kind]) =>
        h('a.dash-alert-pill', { href, class: kind },
          h('span', label),
          h('strong', String(n))))))
    : null;

  const coreKpis = h('div.kpis.dash-kpis',
    kpi('In-Store Stock', c.physical, '#/inventory?stock=physical', 'On floor today'),
    s
      ? kpi('Synced Online', s.linked_items, '#/upc-matches?status=approved', pctOf(s.in_stock_linked, s.in_stock) + ' of in-stock')
      : kpi('Published Online', c.published, '#/products?status=published', 'of ' + fmtNum(c.total)),
    kpi('Special Orders', c.pendingSpecial, '#/orders?special=true', c.pendingSpecial ? 'Needs B2B PO' : 'All clear', c.pendingSpecial ? 'attn' : ''),
    kpi('Active Promos', c.activeCampaigns, '#/promotions', c.activeCampaigns ? 'Live / scheduled' : 'None active'));

  const quickNav = h('div.dash-shortcuts',
    h('a.dash-shortcut', { href: '#/products' }, h('strong', 'Item Search'), h('span.small.muted', 'Catalog & stock')),
    h('a.dash-shortcut', { href: '#/orders' }, h('strong', 'Special Orders'), h('span.small.muted', fmtNum(c.orders) + ' total')),
    h('a.dash-shortcut', { href: '#/purchasing' }, h('strong', 'Purchase Orders'), h('span.small.muted', 'Vendor B2B')),
    h('a.dash-shortcut', { href: '#/reports' }, h('strong', 'Reports'), h('span.small.muted', 'Collections & gaps')));

  const promosCard = card('Active Promotions', active.length
    ? dataTable({
      columns: [
        { key: 'name', label: 'Promotion', render: (r) => h('a', { href: '#/promotions/' + r.id }, h('strong', r.name)) },
        { key: 'adj', label: 'Discount', render: (r) => adjustmentLabel(r.adjustment) },
        { key: 'status', label: 'Status', render: (r) => campaignBadge(r.status) },
      ],
      rows: active.slice(0, 4),
    })
    : h('div.dash-empty',
      h('span.muted', 'No active promotions right now.'),
      ctx.can('pricing.write') ? h('a.btn.sm', { href: '#/promotions/new' }, 'Create one →') : null),
  { flush: !!active.length, actions: h('a.btn.ghost.sm', { href: '#/promotions' }, 'All →') });

  const ordersCard = card('Latest Orders', recentOrders.length
    ? dataTable({
      columns: [
        { key: 'number', label: 'Order', render: (r) => h('a', { href: '#/orders/' + r.id }, h('strong', r.number)) },
        { key: 'total', label: 'Total', num: true, render: (r) => money(r.total_cents) },
        { key: 'status', label: 'Status', render: (r) => orderBadge(r.internal_status) },
      ],
      rows: recentOrders,
    })
    : h('div.dash-empty', h('span.muted', 'No orders recorded yet.')),
  { flush: !!recentOrders.length, actions: h('a.btn.ghost.sm', { href: '#/orders' }, 'All →') });

  return h('div.stack.dash-root',
    pageHead('Hi, ' + ctx.me.user.name.split(' ')[0], subtitle, headerActions),
    alertStrip,
    coreKpis,
    quickNav,
    h('div.grid.grid-2', promosCard, ordersCard),
    syncDetailsDrawer(s, recentJobs));
}
