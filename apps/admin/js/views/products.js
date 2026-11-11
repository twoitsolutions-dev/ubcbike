import { h, mount } from '../ui/dom.js';
import { card, confirmDialog, dataTable, loading, pageHead, pager, toast, watchJob, progressBar, errorBox } from '../ui/components.js';
import { availabilityBadge, dateTime, margin, money, pct } from '../ui/format.js';
import { cleanFilter, describeFilter, filterBar, filterToQuery, remember } from './common.js';
import { openPriceEditor } from './pricing.js';

const statusBadge = (s) => h('span.badge', { class: s === 'published' ? 'ok' : s === 'hidden' ? '' : 'warn' }, s);

/**
 * Shared catalog table used by Products, Prices & margins and Inventory.
 * Supports filters, sort, pagination and multi-selection (page or whole filter).
 */
export async function catalogTable(ctx, opts) {
  const facets = await ctx.api.facets();
  const key = opts.memoryKey;
  const initial = Object.assign({}, remember(key) || {}, ctx.query.stock ? { stock: ctx.query.stock } : {}, ctx.query.status ? { status: ctx.query.status } : {});
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
    if (job.status === 'succeeded') toast((status === 'published' ? 'Published ' : 'Hidden ') + job.result.products + ' products', 'ok');
    else toast('Bulk update failed: ' + job.last_error, 'bad');
  } catch (e) { t.remove(); toast(e.message, 'bad'); }
  done();
}

export async function renderProducts(ctx) {
  const table = await catalogTable(ctx, {
    memoryKey: 'products',
    columns: () => [
      { key: 'title', label: 'Product', sortable: true, cls: 'title-cell', render: (r) => h('div', h('a', { href: '#/products/' + r.id }, r.title), h('div.sku', r.sku)) },
      { key: 'brand', label: 'Brand', sortable: true, opt: true },
      { key: 'category', label: 'Category', opt: true },
      { key: 'price', label: 'Price', num: true, sortable: true, render: (r) => money(r.priceCents) },
      { key: 'margin', label: 'Margin', num: true, sortable: true, opt: true, render: (r) => pct(margin(r.priceCents, r.costCents)) },
      { key: 'avail', label: 'Availability', render: (r) => availabilityBadge(r.availability) },
      { key: 'status', label: 'Status', render: (r) => statusBadge(r.status) },
    ],
    bulkActions: ctx.can('catalog.write') ? ({ filter, count, clear, reload }) => [
      h('button.btn.sm', { onclick: () => runBulkStatus(ctx, filter, count, 'published', () => { clear(); reload(); }) }, 'Publish'),
      h('button.btn.sm', { onclick: () => runBulkStatus(ctx, filter, count, 'hidden', () => { clear(); reload(); }) }, 'Hide'),
      ctx.can('pricing.write') ? h('button.btn.sm', {
        onclick: () => { sessionStorageSafeSet('ubc-promo-selection', JSON.stringify(filter)); ctx.navigate('#/promotions/new?from=selection'); },
      }, 'Create promotion…') : null,
    ] : null,
  });
  return h('div.stack', pageHead('Products', 'Unified catalog: UBC stock and supplier (virtual) offers, without duplicates'), table.el);
}

export function sessionStorageSafeSet(k, v) { try { window.sessionStorage.setItem(k, v); } catch (e) { window.__ubcMem = window.__ubcMem || {}; window.__ubcMem[k] = v; } }
export function sessionStorageSafeGet(k) { try { return window.sessionStorage.getItem(k) || (window.__ubcMem && window.__ubcMem[k]) || null; } catch (e) { return (window.__ubcMem && window.__ubcMem[k]) || null; } }

export async function renderProductDetail(ctx) {
  const d = await ctx.api.item(ctx.params.id);
  const it = d.item;
  const av = d.availability;
  const m = margin(it.priceCents, it.costCents);
  return h('div.stack',
    pageHead(it.title, it.brand + ' · ' + it.category + ' · SKU ' + it.sku, [
      h('a.btn', { href: '#/products' }, '← Products'),
      ctx.can('pricing.write') ? h('button.btn.primary', { onclick: () => openPriceEditor(ctx, it, () => ctx.navigate('#/products/' + it.id + '?r=' + Date.now())) }, 'Change price') : null,
    ]),
    h('div.grid.grid-2',
      card('Identity & pricing', h('dl.props',
        h('dt', 'SKU (UBC)'), h('dd', h('code', it.sku)),
        h('dt', 'UPC / GTIN'), h('dd', it.upc ? h('code', it.upc) : h('span.muted', 'none')),
        h('dt', 'Manufacturer part #'), h('dd', it.mpn ? h('code', it.mpn) : '—'),
        h('dt', 'Price'), h('dd', h('strong', money(it.priceCents))),
        h('dt', 'Cost'), h('dd', it.costCents === null ? h('span.badge.warn', 'No cost on file') : money(it.costCents)),
        h('dt', 'Margin'), h('dd', pct(m)),
        h('dt', 'MAP'), h('dd', it.mapPolicy === 'none' ? 'No MAP policy' : money(it.mapCents) + ' (' + it.mapPolicy.toUpperCase() + ')'),
        h('dt', 'Status'), h('dd', statusBadge(it.status)),
        h('dt', 'Updated'), h('dd', dateTime(it.updatedAt) + ' · version ' + it.version),
        h('dt', 'External IDs'), h('dd', d.externalIds.length ? d.externalIds.map((e) => h('div', h('span.muted', e.system + ': '), h('code', e.external_id))) : h('span.muted', 'Not linked to Shopify/Lightspeed yet')))),
      card('Availability (physical and virtual are never mixed)', h('div.stack',
        h('div.row', availabilityBadge(av)),
        h('dl.props',
          h('dt', 'Physical on hand (UBC)'), h('dd', String(it.physicalQty)),
          h('dt', 'Reserved for orders'), h('dd', String(it.reservedQty)),
          h('dt', 'Sellable from UBC'), h('dd', h('strong', String(av.sellablePhysical))),
          h('dt', 'Shopify representation'), h('dd', 'Qty ' + av.shopify.publishedQty + ' · ' + (av.shopify.inventoryPolicy === 'continue' ? 'continue selling (special order, ' + av.shopify.leadTimeDays + ' days)' : 'stop at zero'))),
        dataTable({
          columns: [
            { key: 'supplierCode', label: 'Supplier' },
            { key: 'supplierSku', label: 'Supplier SKU', render: (o) => h('code', o.supplierSku) },
            { key: 'cost', label: 'Cost', num: true, render: (o) => money(o.costCents) },
            { key: 'qty', label: 'Qty reported', num: true, render: (o) => String(o.qtyAvailable) },
            { key: 'fresh', label: 'Reported', render: (o) => {
              const stale = av.staleOffers.some((s) => s.supplierSku === o.supplierSku);
              return h('span', { class: stale ? 'badge bad' : '' }, stale ? 'stale' : dateTime(o.reportedAt));
            } },
          ],
          rows: it.offers, rowKey: (o) => o.supplierSku, empty: 'No supplier offers for this item.',
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
