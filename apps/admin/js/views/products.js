import { h, mount } from '../ui/dom.js';
import { card, confirmDialog, dataTable, loading, pageHead, pager, sectionTabs, toast, watchJob, progressBar, errorBox } from '../ui/components.js';
import { availabilityBadge, dateTime, margin, money, pct } from '../ui/format.js';
import { cleanFilter, describeFilter, filterBar, filterToQuery, remember } from './common.js?v=82';
import { openPriceEditor } from './pricing.js?v=82';
import { openCreateProduct, openCreateSeparateProducts } from './create-product.js?v=82';

const statusBadge = (s) => h('span.badge', { class: s === 'published' ? 'ok' : s === 'hidden' ? '' : 'warn' }, s);

export function itemSearchTabs(activeKey) {
  return sectionTabs([
    ['instock', 'In Stock', '#/products'],
    ['all', 'All Items', '#/products?stock=any'],
    ['out', 'Out of Stock', '#/products?stock=unavailable'],
    ['vendor', 'Vendor Catalog Only', '#/products?stock=virtual_only'],
    ['stock', 'Stock by Store', '#/inventory'],
    ['margins', 'Margins & MAP', '#/pricing'],
    ['ls-sheet', 'Lightspeed Sheet', '#/lightspeed-sheet'],
  ], activeKey);
}

/**
 * Shared catalog table used by Item Search (All Items, In-Store Stock, Margins & MAP).
 * Supports filters, sort, pagination and multi-selection (page or whole filter).
 */
export async function catalogTable(ctx, opts) {
  const facets = await ctx.api.facets();
  const key = opts.memoryKey;
  const mem = Object.assign({}, remember(key) || {});
  // Default view = items with stock. Out-of-stock / all items only when asked (tab or filter).
  if (ctx.query.stock === 'any') delete mem.stock;
  else if (ctx.query.stock) mem.stock = ctx.query.stock;
  else mem.stock = 'physical';
  if (ctx.query.status) mem.status = ctx.query.status;
  const initial = mem;
  const st = { filter: initial, sort: opts.sort || { key: 'title', dir: 'asc' }, offset: 0, limit: 50, selected: new Set(), allMatching: false, data: null };
  const tableHost = h('div', loading());
  const selHost = h('div');

  async function load() {
    remember(key, st.filter);
    mount(tableHost, loading());
    try {
      st.data = await ctx.api.items(Object.assign(filterToQuery(st.filter), { limit: st.limit, offset: st.offset, sort: st.sort.key, dir: st.sort.dir }));
      if (!ctx.isCurrent()) return;
      draw();
    } catch (e) { mount(tableHost, errorBox(e)); }
  }

  function selectionFilter() {
    return st.allMatching ? cleanFilter(st.filter) : { ids: Array.from(st.selected) };
  }
  function selectionCount() { return st.allMatching ? st.data.total : st.selected.size; }

  function drawSelection() {
    const n = st.data ? selectionCount() : 0;
    if (!n || !opts.bulkActions) { mount(selHost); return; }
    const pageAll = st.data.items.length && st.data.items.every((i) => st.selected.has(i.id));
    mount(selHost, h('div.selection-bar',
      h('strong', n.toLocaleString('en-US') + ' selected'),
      !st.allMatching && pageAll && st.data.total > st.data.items.length
        ? h('button.btn.sm', { onclick: () => { st.allMatching = true; drawSelection(); } }, 'Select all ' + st.data.total.toLocaleString('en-US') + ' matching')
        : null,
      h('span.spacer', { style: { flex: '1' } }),
      opts.bulkActions({ filter: selectionFilter(), count: n, clear: () => { st.selected.clear(); st.allMatching = false; draw(); }, reload: load }),
      h('button.btn.sm.ghost', { onclick: () => { st.selected.clear(); st.allMatching = false; draw(); } }, 'Clear')));
  }

  function draw() {
    const d = st.data;
    mount(tableHost,
      dataTable({
        columns: opts.columns(ctx, load),
        rows: d.items,
        sort: st.sort,
        onSort: (k) => { st.sort = { key: k, dir: st.sort.key === k && st.sort.dir === 'asc' ? 'desc' : 'asc' }; st.offset = 0; load(); },
        selectable: !!opts.bulkActions,
        selected: st.selected,
        onToggle: (rid, on) => { st.allMatching = false; if (on) st.selected.add(rid); else st.selected.delete(rid); draw(); },
        onToggleAll: (ids, on) => { st.allMatching = false; ids.forEach((i) => (on ? st.selected.add(i) : st.selected.delete(i))); draw(); },
        onRowClick: opts.onRowClick ? (r) => opts.onRowClick(r, load) : null,
        empty: 'No products match these filters.',
      }),
      pager({ total: d.total, limit: st.limit, offset: st.offset, onPage: (o) => { st.offset = o; load(); } }));
    drawSelection();
  }

  const filters = filterBar(facets, st.filter, (f) => { st.filter = f; st.offset = 0; st.selected.clear(); st.allMatching = false; load(); }, { hideStatus: opts.hideStatus });
  load();
  return { el: h('section.card', filters, selHost, tableHost), state: st, reload: load, describe: () => describeFilter(st.filter) };
}

async function runBulkStatus(ctx, filter, count, status, done) {
  const ok = await confirmDialog({
    title: (status === 'published' ? 'Publish ' : 'Hide ') + count.toLocaleString('en-US') + ' products?',
    message: status === 'published'
      ? 'All variants of the selected products become visible in the online store. This runs in the background.'
      : 'All variants of the selected products are removed from the online store (not deleted). This runs in the background.',
    confirmLabel: status === 'published' ? 'Publish' : 'Hide',
    danger: status === 'hidden',
  });
  if (!ok) return;
  const r = await ctx.api.bulkStatus(filter, status);
  const pb = progressBar();
  const lbl = h('span.small.muted', 'queued');
  const t = h('div.toast', h('div', 'Updating products… ', lbl), pb.el);
  document.getElementById('toasts').appendChild(t);
  try {
    const job = await watchJob(ctx.api, r.jobId, pb.bar, lbl);
    t.remove();
    if (job.status === 'succeeded') {
      const res = job.result || {};
      toast((status === 'published' ? 'Published ' : 'Hidden ') + res.products + ' products' + (typeof res.shopifyProducts === 'number' ? ' · ' + res.shopifyProducts + ' updated in Shopify' : ''), 'ok');
      if (res.notInShopify) {
        // Not in the online store yet: nothing to publish there until it is matched by UPC or created.
        toast(res.notInShopify + ' of them are not in the Shopify store yet (no product with that UPC). Create it with "Create Shopify product…" or check "UPC Matches".', 'bad');
      }
    }
    else toast('Bulk update failed: ' + job.last_error, 'bad');
  } catch (e) { t.remove(); toast(e.message, 'bad'); }
  done();
}

export function renderItemPriceCell(r) {
  if (r.compareAtCents && r.compareAtCents > r.priceCents) {
    return h('div',
      h('div', h('strong', money(r.priceCents)), ' ', h('span.badge.ok', 'Sale')),
      h('div.small.muted', 'Default ', h('s', money(r.compareAtCents))));
  }
  return money(r.priceCents);
}

export async function renderProducts(ctx) {
  const table = await catalogTable(ctx, {
    memoryKey: 'products',
    columns: (c, reload) => [
      { key: 'title', label: 'Item', sortable: true, cls: 'title-cell', render: (r) => h('div', h('a', { href: '#/products/' + r.id }, r.title), h('div.sku', r.sku)) },
      { key: 'brand', label: 'Brand', sortable: true, opt: true },
      { key: 'category', label: 'Category', opt: true },
      { key: 'price', label: 'Price / Sale', num: true, sortable: true, render: renderItemPriceCell },
      { key: 'margin', label: 'Margin', num: true, sortable: true, opt: true, render: (r) => pct(margin(r.priceCents, r.costCents)) },
      { key: 'avail', label: 'Stock / Vendor', render: (r) => availabilityBadge(r.availability) },
      { key: 'status', label: 'Web Status', render: (r) => statusBadge(r.status) },
      { key: 'edit', label: '', opt: true, render: (r) => (c.can('pricing.write') ? h('button.btn.sm', { onclick: () => openPriceEditor(c, r, reload) }, 'Price') : null) },
    ],
    bulkActions: ctx.can('catalog.write') ? ({ filter, count, clear, reload }) => [
      h('button.btn.sm', { onclick: () => runBulkStatus(ctx, filter, count, 'published', () => { clear(); reload(); }) }, 'Publish'),
      h('button.btn.sm', { onclick: () => runBulkStatus(ctx, filter, count, 'hidden', () => { clear(); reload(); }) }, 'Hide'),
      ctx.can('pricing.write') ? h('button.btn.sm', {
        onclick: () => { sessionStorageSafeSet('ubc-promo-selection', JSON.stringify(filter)); ctx.navigate('#/promotions/new?from=selection'); },
      }, 'Create promotion…') : null,
      // 1 item → Create in Shopify; 2+ items → Create Matrix (1 product with variants) OR Create Separate (1 product each).
      filter.ids && filter.ids.length === 1 && ctx.api.kind === 'http' ? h('button.btn.sm', {
        title: 'Create this item in Shopify',
        onclick: () => openCreateProduct(ctx, filter.ids, () => { clear(); reload(); }),
      }, 'Create in Shopify…') : null,
      filter.ids && filter.ids.length > 1 && ctx.api.kind === 'http' ? h('button.btn.sm', {
        title: 'Combine selected items as color/size variants into ONE Shopify product',
        onclick: () => openCreateProduct(ctx, filter.ids, () => { clear(); reload(); }),
      }, 'Create Matrix in Shopify…') : null,
      filter.ids && filter.ids.length > 1 && ctx.api.kind === 'http' ? h('button.btn.sm', {
        title: 'Create one separate Shopify product for each selected item',
        onclick: () => openCreateSeparateProducts(ctx, filter.ids, () => { clear(); reload(); }),
      }, 'Create Separate in Shopify…') : null,
    ] : null,
  });
  const fs = table.state.filter.stock;
  const activeTab = fs === 'virtual_only' ? 'vendor' : fs === 'unavailable' ? 'out' : fs === 'physical' ? 'instock' : 'all';
  return h('div.stack',
    pageHead('Item Search', 'Shows items with stock by default. Use the tabs or the Availability filter to see out-of-stock or vendor-catalog-only items.'),
    itemSearchTabs(activeTab),
    table.el);
}

export function sessionStorageSafeSet(k, v) { try { window.sessionStorage.setItem(k, v); } catch (e) { window.__ubcMem = window.__ubcMem || {}; window.__ubcMem[k] = v; } }
export function sessionStorageSafeGet(k) { try { return window.sessionStorage.getItem(k) || (window.__ubcMem && window.__ubcMem[k]) || null; } catch (e) { return (window.__ubcMem && window.__ubcMem[k]) || null; } }

export async function renderProductDetail(ctx) {
  const d = await ctx.api.item(ctx.params.id);
  const it = d.item;
  const av = d.availability;
  const m = margin(it.priceCents, it.costCents);
  const linkedToShopify = !!(it.shopifyVariantId || (d.externalIds || []).some((e) => e.system === 'shopify'));
  return h('div.stack',
    pageHead(it.title, it.brand + ' · ' + it.category + ' · SKU ' + it.sku, [
      h('a.btn', { href: '#/products' }, '← Item Search'),
      d.shopifyAdminUrl
        ? h('a.btn', { href: d.shopifyAdminUrl, target: '_blank', rel: 'noopener' }, 'Open in Shopify ↗')
        : null,
      !linkedToShopify && ctx.can('catalog.write') && ctx.api.kind === 'http'
        ? h('button.btn', { onclick: () => openCreateProduct(ctx, [it.id], () => ctx.navigate('#/products/' + it.id + '?r=' + Date.now())) }, 'Create in Shopify…')
        : null,
      ctx.can('pricing.write') ? h('button.btn.primary', { onclick: () => openPriceEditor(ctx, it, () => ctx.navigate('#/products/' + it.id + '?r=' + Date.now())) }, 'Change price') : null,
    ].filter(Boolean)),
    h('div.grid.grid-2',
      card('Item Identity & Pricing', h('dl.props',
        h('dt', 'System SKU (Lightspeed System ID)'), h('dd', h('code', it.sku)),
        h('dt', 'UPC / EAN'), h('dd', it.upc ? h('code', it.upc) : h('span.muted', 'none')),
        h('dt', 'Manufacturer Part #'), h('dd', it.mpn ? h('code', it.mpn) : '—'),
        h('dt', 'Default Price'), h('dd', h('strong', money(it.compareAtCents && it.compareAtCents > it.priceCents ? it.compareAtCents : it.priceCents))),
        h('dt', 'Sale Price'), h('dd', it.compareAtCents && it.compareAtCents > it.priceCents
          ? h('span', h('strong', money(it.priceCents)), ' ', h('span.badge.ok', 'Active Sale'))
          : h('span.muted', 'None')),
        h('dt', 'Lightspeed Avg. Cost'), h('dd', it.costCents === null
          ? h('span.badge.warn', 'No cost on file')
          : h('div.row', { style: { gap: '8px', flexWrap: 'wrap' } }, [
            h('strong', money(it.costCents)),
            it.costCents > it.priceCents
              ? h('span.badge.warn', 'Cost > Retail in Lightspeed — check PO/Lot cost or Default Price')
              : h('span.muted.small', '(synced from Lightspeed POS)'),
            it.lightspeedItemId ? h('a.btn.sm.ghost', { href: '#/lightspeed-sheet' }, 'Edit in Bulk Sheet →') : null,
          ])),
        h('dt', 'Margin'), h('dd', pct(m)),
        h('dt', 'MAP Floor'), h('dd', it.mapPolicy === 'none' ? 'No MAP policy' : money(it.mapCents) + ' (' + it.mapPolicy.toUpperCase() + ')'),
        h('dt', 'Web Status'), h('dd', statusBadge(it.status)),
        h('dt', 'Updated'), h('dd', dateTime(it.updatedAt) + ' · version ' + it.version),
        h('dt', 'External IDs'), h('dd', d.externalIds.length ? d.externalIds.map((e) => h('div', h('span.muted', e.system + ': '), h('code', e.external_id))) : h('span.muted', 'Not linked to Shopify/Lightspeed yet')))),
      card('In-Store Stock & Vendor Catalogs (never summed)', h('div.stack',
        h('div.row', availabilityBadge(av)),
        h('dl.props',
          h('dt', 'In-Store On Hand (UBC)'), h('dd', String(it.physicalQty)),
          d.locationLevels && d.locationLevels.length
            ? [h('dt', 'By Shop Location'), h('dd', d.locationLevels.map((l) => l.name + ': ' + l.on_hand).join(' · '))]
            : null,
          h('dt', 'Reserved for Orders'), h('dd', String(it.reservedQty)),
          h('dt', 'Sellable from UBC'), h('dd', h('strong', String(av.sellablePhysical))),
          h('dt', 'Shopify Rule'), h('dd', 'Qty ' + av.shopify.publishedQty + ' · ' + (av.shopify.inventoryPolicy === 'continue' ? 'continue selling (Special Order, ' + av.shopify.leadTimeDays + ' days)' : 'stop at zero'))),
        dataTable({
          columns: [
            { key: 'supplierCode', label: 'Vendor' },
            { key: 'supplierSku', label: 'Vendor Part #', render: (o) => h('code', o.supplierSku) },
            { key: 'cost', label: 'Cost', num: true, render: (o) => money(o.costCents) },
            { key: 'qty', label: 'Vendor Qty', num: true, render: (o) => String(o.qtyAvailable) },
            { key: 'fresh', label: 'Feed Sync', render: (o) => {
              const stale = av.staleOffers.some((s) => s.supplierSku === o.supplierSku);
              return h('span', { class: stale ? 'badge bad' : '' }, stale ? 'stale' : dateTime(o.reportedAt));
            } },
          ],
          rows: it.offers, rowKey: (o) => o.supplierSku, empty: 'No Vendor Catalog offers for this item.',
        })))),
    card('Price history', dataTable({
      columns: [
        { key: 'when', label: 'When', render: (r) => dateTime(r.created_at) },
        { key: 'from', label: 'From', num: true, render: (r) => money(r.old_price_cents) },
        { key: 'to', label: 'To', num: true, render: (r) => money(r.new_price_cents) },
        { key: 'source', label: 'Source', render: (r) => h('span.badge', r.source) },
      ],
      rows: d.priceHistory, rowKey: (r) => r.created_at + r.new_price_cents, empty: 'No price changes recorded.',
    }), { flush: true }));
}
