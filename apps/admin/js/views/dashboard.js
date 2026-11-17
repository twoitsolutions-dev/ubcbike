import { h } from '../ui/dom.js';
import { card, pageHead, dataTable } from '../ui/components.js';
import { ago, campaignBadge, channelBadge, adjustmentLabel, money, orderBadge } from '../ui/format.js';

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

/** Lightspeed ↔ Shopify (Workstand store) coverage: what Carlos has vs. what is already sellable online. */
function syncCoverageCard(s) {
  const n = (v) => (typeof v === 'number' ? v.toLocaleString('en-US') : '—');
  const row = (label, value, hint, href) => h(href ? 'a.attn-row' : 'div.attn-row', { href },
    h('span', label, hint ? h('div.sku', hint) : null), h('strong', value));
  return card('Lightspeed ↔ Shopify (matched by UPC)', h('div.stack',
    h('div.kpis',
      h('a.kpi', { href: '#/products' },
        h('div.label', 'In-stock items already online'),
        h('div.value', pctOf(s.in_stock_linked, s.in_stock)),
        h('div.hint', n(s.in_stock_linked) + ' of ' + n(s.in_stock) + ' items with stock in Lightspeed')),
      h('div.kpi',
        h('div.label', 'Lightspeed items found in Shopify'),
        h('div.value', n(s.linked_items)),
        h('div.hint', 'of ' + n(s.ls_with_upc) + ' with a UPC (' + n(s.ls_items) + ' items total)')),
      h('a.kpi', { href: '#/upc-matches' },
        h('div.label', 'Shopify store (Workstand)'),
        h('div.value', n(s.storeVariants)),
        h('div.hint', 'variants · ' + n(s.linked_variants) + ' synced from Lightspeed'))),
    h('div.attn-list',
      row('In stock, has UPC, but not in Shopify yet', n(s.in_stock_missing), 'Workstand has not uploaded these products (or the UPC differs)'),
      row('In stock without a UPC in Lightspeed', n(s.in_stock_no_upc), 'Add the UPC in Lightspeed so they can sync'),
      row('Units in stock that are online', n(s.units_linked) + ' / ' + n(s.units), null),
      row('Prices / stock that Workstand overwrote and the Hub put back (last 24 h)',
        n(s.overwrittenFixed24h && s.overwrittenFixed24h.prices) + ' / ' + n(s.overwrittenFixed24h && s.overwrittenFixed24h.stock), 'Should go to 0 once Workstand stops changing Lightspeed items'),
      row('Last Lightspeed sync · last check · last UPC search',
        ago(s.lastLightspeedSyncAt) + ' · ' + ago(s.lastReconcileAt) + ' · ' + ago(s.lastMatchAt), null))), { flush: false });
}

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
  if (c.awaitingApproval) attention.push(['Special Orders waiting for B2B PO', c.awaitingApproval, '#/orders?status=awaiting_approval', 'warn']);
  const exc = orders.orders.filter((o) => o.internal_status === 'exception').length;
  if (exc) attention.push(['Special Orders in Exception', exc, '#/orders?status=exception', 'bad']);
  if (c.openErrors) attention.push(['Unresolved sync errors', c.openErrors, '#/activity?tab=errors', 'bad']);
  if (c.deadJobs) attention.push(['Failed background jobs', c.deadJobs, '#/activity?tab=jobs', 'bad']);
  if (c.pendingMatchReviews) attention.push(['Vendor Catalog matches to review', c.pendingMatchReviews, '#/suppliers', 'warn']);
  if (c.upcReview) attention.push(['UPC matches to approve (Lightspeed ↔ Shopify)', c.upcReview, '#/upc-matches', 'warn']);

  const active = camps.campaigns.filter((x) => ['active', 'scheduled', 'applying', 'restoring'].indexOf(x.status) >= 0);
  const recentOrders = orders.orders.slice(0, 5);
  const recentJobs = d.recentJobs.slice(0, 5);

  const quickActions = h('div.quick-grid',
    ctx.can('pricing.write') ? h('a.quick-card.featured', { href: '#/promotions/new' },
      h('span.quick-kicker', 'Promotions / Price Rules'),
      h('span.quick-title', 'Launch a Promotion →'),
      h('span.quick-sub', 'Online flash sale or storewide event (Black Friday, Holiday, Clearance)')) : null,
    h('a.quick-card', { href: '#/purchasing' },
      h('span.quick-kicker', 'Inventory · B2B'),
      h('span.quick-title', 'Purchase Orders (B2B)'),
      h('span.quick-sub', c.pendingSpecial ? c.pendingSpecial + ' open Special Order(s) to place in B2B' : 'Copy Vendor Part # & buy in QBP, JBI or Specialized')),
    h('a.quick-card', { href: '#/orders' },
      h('span.quick-kicker', 'Inventory · Fulfillment'),
      h('span.quick-title', 'Special Orders'),
      h('span.quick-sub', c.orders.toLocaleString('en-US') + ' orders · In-Store Stock & Special Orders')),
    h('a.quick-card', { href: '#/products' },
      h('span.quick-kicker', 'Inventory · Catalog'),
      h('span.quick-title', 'Item Search'),
      h('span.quick-sub', 'Search items, In-Store Stock, Vendor Catalogs & Margins')));

  // Link to the store the Hub is actually connected to (Carlos's live store), not a test store.
  const themeBar = d.storeUrl ? card('Online store',
    h('div.row', { style: 'justify-content:space-between;flex-wrap:wrap;gap:12px' },
      h('span.muted', 'The Shopify store this Hub keeps in sync with Lightspeed.'),
      h('a.btn.primary.sm', { href: d.storeUrl, target: '_blank', rel: 'noopener' }, 'Open online store ↗'))) : null;

  return h('div.stack',
    pageHead('Welcome back, ' + ctx.me.user.name.split(' ')[0], 'University Bicycle Center — Online Store (Shopify), Store POS (Lightspeed R-Series) & Vendor B2B Hub',
      [ctx.can('pricing.write') ? h('a.btn.primary', { href: '#/promotions/new' }, 'New promotion') : null, h('a.btn', { href: '#/orders' }, 'Special Orders')]),
    quickActions,
    d.shopifySync ? syncCoverageCard(d.shopifySync) : null,
    themeBar,
    h('div.kpis',
      // With the Workstand-owned store, "online" = matched by UPC; Hub publish flags are not the store's truth.
      d.shopifySync
        ? kpi('Online (matched by UPC)', d.shopifySync.linked_items, '#/upc-matches?status=approved', 'Lightspeed items synced to Shopify')
        : kpi('Published online', c.published, '#/products?status=published', 'of ' + c.total.toLocaleString('en-US') + ' total items'),
      kpi('In-Store Stock (UBC)', c.physical, '#/inventory?stock=physical', 'Ready on floor today'),
      kpi('Vendor Catalog Only', c.virtualOnly, '#/products?stock=virtual_only', 'Special Order via distributor'),
      kpi('Out of stock', c.unavailable, '#/products?stock=unavailable', '0 store & 0 vendor'),
      kpi('Total orders', c.orders, '#/orders', 'Store stock + Special Orders'),
      kpi('Open Special Orders', c.pendingSpecial, '#/orders?special=true', 'Needs Vendor PO follow-up', c.pendingSpecial ? 'attn' : ''),
      kpi('Active Price Rules', c.activeCampaigns, '#/promotions', 'Live or scheduled promos'),
      kpi('System & Sync alerts', c.openErrors + c.deadJobs, '#/activity', c.openErrors + c.deadJobs ? 'Review in Settings & Sync' : 'All systems healthy', c.openErrors + c.deadJobs ? 'bad' : '')),
    h('div.grid.grid-2',
      card('Needs your attention', attention.length
        ? h('div.attn-list', attention.map(([label, n, href, kind]) => h('a.attn-row', { href }, h('span', label), h('span.badge', { class: kind }, String(n)))))
        : h('p.muted', 'All caught up — no urgent approvals, exceptions or sync errors waiting.'), { flush: !!attention.length }),
      card('Active & scheduled promotions', active.length
        ? dataTable({
          columns: [
            { key: 'name', label: 'Promotion', render: (r) => h('a', { href: '#/promotions/' + r.id }, h('strong', r.name)) },
            { key: 'channel', label: 'Where', opt: true, render: (r) => channelBadge(r.channel, r.summary) },
            { key: 'adj', label: 'Discount', render: (r) => adjustmentLabel(r.adjustment) },
            { key: 'status', label: 'Status', render: (r) => campaignBadge(r.status) },
          ],
          rows: active,
        })
        : h('p.muted', 'No active promotions right now.'), { flush: !!active.length, actions: h('a.btn.ghost.sm', { href: '#/promotions' }, 'View all →') })),
    h('div.grid.grid-2',
      card('Latest customer orders', dataTable({
        columns: [
          { key: 'number', label: 'Order', render: (r) => h('a', { href: '#/orders/' + r.id }, h('strong', r.number)) },
          { key: 'type', label: 'Fulfillment', opt: true, render: (r) => (r.is_special_order ? h('span.badge.violet', 'Special order') : h('span.badge', 'Store stock')) },
          { key: 'total', label: 'Total', num: true, render: (r) => money(r.total_cents) },
          { key: 'status', label: 'Status', render: (r) => orderBadge(r.internal_status) },
        ],
        rows: recentOrders,
      }), { flush: true, actions: h('a.btn.ghost.sm', { href: '#/orders' }, 'View all →') }),
      card('Recent sync activity', recentJobs.length
        ? dataTable({
          columns: [
            { key: 'type', label: 'Activity', render: (r) => h('strong', JOB_LABELS[r.type] || r.type) },
            { key: 'status', label: 'Status', render: (r) => h('span.badge', { class: r.status === 'succeeded' ? 'ok' : r.status === 'dead' ? 'bad' : 'info' }, r.status) },
            { key: 'when', label: 'When', num: true, render: (r) => ago(r.finished_at || r.created_at) },
          ],
          rows: recentJobs,
        })
        : h('p.muted', 'No background tasks yet. Bulk updates, promotions and feed imports show up here.'), { flush: !!recentJobs.length, actions: h('a.btn.ghost.sm', { href: '#/activity' }, 'Activity & Logs →') })));
}
