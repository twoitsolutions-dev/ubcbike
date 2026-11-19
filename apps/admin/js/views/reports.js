import { h, mount } from '../ui/dom.js';
import { card, dataTable, errorBox, loading, pageHead, pager } from '../ui/components.js';
import { dateTime, money, pct } from '../ui/format.js';

const PAGE_SIZE = 25;

function downloadCsv(filename, header, rows) {
  const esc = (v) => '"' + String(v === undefined || v === null ? '' : v).replace(/"/g, '""') + '"';
  const csv = [header.map(esc).join(',')].concat(rows.map((r) => r.map(esc).join(','))).join('\n');
  const a = h('a', { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function kpiBox(label, value, cls) {
  return h('div.kpi.dash-kpi', { class: cls || '' },
    h('div.label', label),
    h('div.value', typeof value === 'number' ? value.toLocaleString('en-US') : value));
}

export async function renderReports(ctx) {
  const cache = { shopify: null, noUpc: null, margin: null };
  let activeReport = ctx.query.report || 'collections';
  const tabsHost = h('div.rep-tabs');
  const bodyHost = h('div.stack.rep-body', loading('Loading report…'));

  const TABS = [
    ['collections', 'Collections'],
    ['photos', 'No Photos'],
    ['no_upc', 'No UPC'],
    ['margin', 'Cost & Margin'],
  ];

  const drawTabs = () => {
    mount(tabsHost, TABS.map(([id, label]) =>
      h('button.rep-tab', {
        type: 'button',
        class: activeReport === id ? 'on' : '',
        onclick: () => {
          activeReport = id;
          drawTabs();
          loadActive(false);
        },
      }, label)));
  };

  async function ensureShopify(refresh) {
    if (!refresh && cache.shopify) return cache.shopify;
    cache.shopify = await ctx.api.reportsCollectionGap(refresh);
    return cache.shopify;
  }

  async function ensureNoUpc(refresh) {
    if (!refresh && cache.noUpc) return cache.noUpc;
    cache.noUpc = await ctx.api.reportsNoUpc();
    return cache.noUpc;
  }

  async function ensureMargin(refresh) {
    if (!refresh && cache.margin) return cache.margin;
    cache.margin = await ctx.api.reportsMarginIssues();
    return cache.margin;
  }

  async function loadActive(refresh) {
    mount(bodyHost, loading('Loading report…'));
    try {
      if (activeReport === 'collections') {
        const r = await ensureShopify(refresh);
        if (!ctx.isCurrent()) return;
        renderCollectionsReport(r);
      } else if (activeReport === 'photos') {
        const r = await ensureShopify(refresh);
        if (!ctx.isCurrent()) return;
        renderNoPhotosReport(r);
      } else if (activeReport === 'no_upc') {
        const r = await ensureNoUpc(refresh);
        if (!ctx.isCurrent()) return;
        renderNoUpcReport(r);
      } else if (activeReport === 'margin') {
        const r = await ensureMargin(refresh);
        if (!ctx.isCurrent()) return;
        renderMarginReport(r);
      }
    } catch (e) {
      if (!ctx.isCurrent()) return;
      mount(bodyHost, errorBox(e));
    }
  }

  function renderPaginatedCard({ title, meta, toolbar, getRows, columns, empty, onCsv }) {
    let offset = 0;
    const listHost = h('div');

    const draw = (resetPage) => {
      if (resetPage) offset = 0;
      const rows = getRows();
      if (offset >= rows.length && offset > 0) offset = 0;
      const slice = rows.slice(offset, offset + PAGE_SIZE);
      mount(listHost,
        dataTable({ columns, rows: slice, empty }),
        rows.length > PAGE_SIZE ? pager({
          total: rows.length,
          limit: PAGE_SIZE,
          offset,
          onPage: (next) => {
            offset = next;
            draw(false);
            window.scrollTo({ top: 0, behavior: 'smooth' });
          },
        }) : null);
    };

    draw(true);
    return {
      redraw: () => draw(true),
      el: card(title, h('div.stack-sm',
        h('div.rep-toolbar',
          toolbar,
          h('div.rep-toolbar-actions',
            h('button.btn.sm', { type: 'button', onclick: () => onCsv(getRows()) }, 'CSV'),
            h('button.btn.sm', { type: 'button', onclick: () => loadActive(true), title: 'Refresh' }, '↻'))),
        listHost), { actions: meta ? h('span.small.muted', meta) : null }),
    };
  }

  function renderCollectionsReport(r) {
    const s = r.summary || { totalActiveInStock: 0, inDeptCollections: 0, outsideDeptCollections: 0, outsideAllCollections: 0 };
    const allItems = r.items || [];
    const st = { scope: 'all_gap', q: '', typeFilter: '' };

    const scopeSelect = h('select.rep-select', {
      onchange: (e) => { st.scope = e.target.value; list.redraw(); },
    },
    h('option', { value: 'all_gap' }, 'Outside Dept (' + s.outsideDeptCollections + ')'),
    h('option', { value: 'none' }, 'Outside ALL (' + s.outsideAllCollections + ')'));

    const typeSelect = h('select.rep-select', {
      onchange: (e) => { st.typeFilter = e.target.value; list.redraw(); },
    }, [h('option', { value: '' }, 'All types (' + (r.typeBreakdown ? r.typeBreakdown.length : 0) + ')')].concat(
      (r.typeBreakdown || []).map((tb) => h('option', { value: tb.productType }, tb.productType + ' (' + tb.count + ')')),
    ));

    const searchInput = h('input.rep-search', {
      type: 'search',
      placeholder: 'Search title, brand, type…',
      oninput: (e) => { st.q = (e.target.value || '').trim().toLowerCase(); list.redraw(); },
    });

    const list = renderPaginatedCard({
      title: 'Products outside collections',
      meta: r.generatedAt ? dateTime(r.generatedAt) : '',
      toolbar: h('div.rep-filters', searchInput, scopeSelect, typeSelect),
      getRows: () => allItems.filter((it) => {
        if (st.scope === 'none' && it.gapType !== 'no_collections') return false;
        if (st.typeFilter && it.productType !== st.typeFilter) return false;
        if (st.q && !(it.title + ' ' + it.vendor + ' ' + it.productType + ' ' + it.reason).toLowerCase().includes(st.q)) return false;
        return true;
      }),
      columns: [
        {
          key: 'title',
          label: 'Product',
          cls: 'title-cell',
          render: (it) => h('div',
            it.adminUrl ? h('a', { href: it.adminUrl, target: '_blank', rel: 'noopener' }, h('strong', it.title)) : h('strong', it.title),
            h('div.sku', (it.vendor || '—') + ' · ' + it.productType)),
        },
        { key: 'inv', label: 'Qty', num: true, render: (it) => String(it.totalInventory || 0) },
        {
          key: 'tags',
          label: 'Current Tags',
          opt: true,
          render: (it) => (it.tags && it.tags.length
            ? h('div.chips', it.tags.slice(0, 8).map((t) => h('span.badge', t)))
            : h('span.badge.warn', 'None')),
        },
        {
          key: 'missing',
          label: 'Missing Tags',
          render: (it) => (it.missingTags && it.missingTags.length
            ? h('div.chips', it.missingTags.map((t) => h('span.badge.bad', t)))
            : h('span.badge.ok', 'All tags OK')),
        },
        {
          key: 'cols',
          label: 'Collections',
          opt: true,
          render: (it) => (it.collections && it.collections.length ? it.collections.map((c) => c.title).join(', ') : h('span.badge.bad', 'None')),
        },
      ],
      empty: 'Every active in-stock product is inside a department collection!',
      onCsv: (rows) => downloadCsv(
        'shopify-products-outside-collections.csv',
        ['Title', 'Brand', 'Product Type', 'Inventory', 'Current Tags', 'Missing Tags', 'Current Collections', 'Reason', 'Shopify Admin URL'],
        rows.map((it) => [
          it.title,
          it.vendor,
          it.productType,
          it.totalInventory,
          (it.tags || []).join('; ') || 'None',
          (it.missingTags || []).join('; ') || 'None',
          (it.collections || []).map((c) => c.title).join('; ') || 'None',
          it.reason,
          it.adminUrl || '',
        ]),
      ),
    });

    mount(bodyHost,
      h('div.kpis.dash-kpis',
        kpiBox('Active in-stock', s.totalActiveInStock),
        kpiBox('In dept collections', s.inDeptCollections),
        kpiBox('Outside dept', s.outsideDeptCollections, s.outsideDeptCollections ? 'attn' : ''),
        kpiBox('Outside ALL', s.outsideAllCollections, s.outsideAllCollections ? 'bad' : '')),
      list.el);
  }

  function renderNoPhotosReport(r) {
    const items = r.noPhotoItems || [];
    const total = (r.summary && r.summary.totalActiveInStock) || 0;
    let q = '';

    const searchInput = h('input.rep-search', {
      type: 'search',
      placeholder: 'Search title, brand, type…',
      oninput: (e) => { q = (e.target.value || '').trim().toLowerCase(); list.redraw(); },
    });

    const list = renderPaginatedCard({
      title: 'Shopify products missing photos',
      meta: items.length.toLocaleString('en-US') + ' total',
      toolbar: h('div.rep-filters', searchInput),
      getRows: () => (!q ? items : items.filter((it) => (it.title + ' ' + it.vendor + ' ' + it.productType).toLowerCase().includes(q))),
      columns: [
        {
          key: 'title',
          label: 'Product (tap to add photo)',
          cls: 'title-cell',
          render: (it) => h('div',
            it.adminUrl ? h('a', { href: it.adminUrl, target: '_blank', rel: 'noopener' }, h('strong', it.title)) : h('strong', it.title),
            h('div.sku', (it.vendor || '—') + ' · ' + (it.productType || '—'))),
        },
        { key: 'inv', label: 'Qty', num: true, render: (it) => String(it.totalInventory || 0) },
      ],
      empty: 'Every active in-stock Shopify product has a photo!',
      onCsv: (rows) => downloadCsv(
        'shopify-products-without-photos.csv',
        ['Title', 'Brand', 'Product Type', 'Inventory', 'Shopify Admin URL'],
        rows.map((it) => [it.title, it.vendor, it.productType, it.totalInventory, it.adminUrl || '']),
      ),
    });

    mount(bodyHost,
      h('div.kpis.dash-kpis',
        kpiBox('Active in-stock', total),
        kpiBox('Missing photo', items.length, items.length ? 'attn' : ''),
        kpiBox('With photo', Math.max(0, total - items.length))),
      list.el);
  }

  function renderNoUpcReport(r) {
    const s = r.summary || { totalInStock: 0, missingUpc: 0, totalUnits: 0 };
    const items = r.items || [];
    let q = '';

    const searchInput = h('input.rep-search', {
      type: 'search',
      placeholder: 'Search title, brand, SKU…',
      oninput: (e) => { q = (e.target.value || '').trim().toLowerCase(); list.redraw(); },
    });

    const list = renderPaginatedCard({
      title: 'Shopify-matched items without UPC',
      meta: s.missingUpc.toLocaleString('en-US') + ' items',
      toolbar: h('div.rep-filters', searchInput),
      getRows: () => (!q ? items : items.filter((it) => (it.title + ' ' + it.brand + ' ' + it.category + ' ' + it.sku + ' ' + it.mpn).toLowerCase().includes(q))),
      columns: [
        {
          key: 'title',
          label: 'Matched item',
          cls: 'title-cell',
          render: (it) => h('div',
            h('a', { href: '#/products/' + it.id }, h('strong', it.title)),
            h('div.sku', 'SKU ' + it.sku + (it.brand ? ' · ' + it.brand : ''))),
        },
        { key: 'category', label: 'Category', opt: true },
        { key: 'price', label: 'Price', num: true, render: (it) => money(it.priceCents) },
        { key: 'qty', label: 'Qty', num: true, render: (it) => String(it.physicalQty || 0) },
      ],
      empty: 'All Shopify-matched in-stock items have a UPC!',
      onCsv: (rows) => downloadCsv(
        'shopify-matched-without-upc.csv',
        ['Title', 'Brand', 'Category', 'System SKU', 'MPN', 'Price', 'In-Store Qty', 'Shopify Admin URL'],
        rows.map((it) => [it.title, it.brand, it.category, it.sku, it.mpn, (it.priceCents / 100).toFixed(2), it.physicalQty, it.adminUrl || '']),
      ),
    });

    mount(bodyHost,
      h('div.kpis.dash-kpis',
        kpiBox('Shopify-matched in stock', s.totalInStock),
        kpiBox('Missing UPC', s.missingUpc, s.missingUpc ? 'attn' : ''),
        kpiBox('Units w/o UPC', s.totalUnits)),
      list.el);
  }

  function renderMarginReport(r) {
    const s = r.summary || { totalIssues: 0, noCostCount: 0, negativeMarginCount: 0 };
    const items = r.items || [];
    let filterMode = 'all';
    let q = '';

    const modeSelect = h('select.rep-select', {
      onchange: (e) => { filterMode = e.target.value; list.redraw(); },
    },
    h('option', { value: 'all' }, 'All issues (' + s.totalIssues + ')'),
    h('option', { value: 'neg' }, 'Negative Margin (' + s.negativeMarginCount + ')'),
    h('option', { value: 'nocost' }, 'Missing Cost (' + s.noCostCount + ')'));

    const searchInput = h('input.rep-search', {
      type: 'search',
      placeholder: 'Search title, brand, SKU…',
      oninput: (e) => { q = (e.target.value || '').trim().toLowerCase(); list.redraw(); },
    });

    const list = renderPaginatedCard({
      title: 'Shopify-matched: missing cost & negative margin',
      meta: s.totalIssues.toLocaleString('en-US') + ' items',
      toolbar: h('div.rep-filters', searchInput, modeSelect),
      getRows: () => items.filter((it) => {
        if (filterMode === 'neg' && it.issue !== 'negative_margin') return false;
        if (filterMode === 'nocost' && it.issue !== 'no_cost') return false;
        if (q && !(it.title + ' ' + it.brand + ' ' + it.sku).toLowerCase().includes(q)) return false;
        return true;
      }),
      columns: [
        {
          key: 'title',
          label: 'Matched item',
          cls: 'title-cell',
          render: (it) => h('div',
            h('a', { href: '#/products/' + it.id }, h('strong', it.title)),
            h('div.sku', (it.brand || '—') + ' · Qty ' + it.physicalQty)),
        },
        { key: 'price', label: 'Price', num: true, render: (it) => money(it.priceCents) },
        { key: 'cost', label: 'Cost', num: true, opt: true, render: (it) => (it.costCents && it.costCents > 0 ? money(it.costCents) : h('span.badge.warn', 'No cost')) },
        { key: 'margin', label: 'Margin', num: true, render: (it) => (it.marginPct === null ? h('span.badge.warn', 'No cost') : h('span.badge.bad', pct(it.marginPct))) },
      ],
      empty: 'No missing cost or negative margin items among Shopify-matched stock!',
      onCsv: (rows) => downloadCsv(
        'shopify-matched-margin-and-cost-issues.csv',
        ['Title', 'Brand', 'SKU', 'In-Store Qty', 'Price', 'Cost', 'Issue', 'Shopify Admin URL'],
        rows.map((it) => [it.title, it.brand, it.sku, it.physicalQty, (it.priceCents / 100).toFixed(2), it.costCents ? (it.costCents / 100).toFixed(2) : '', it.issue, it.adminUrl || '']),
      ),
    });

    mount(bodyHost,
      h('div.kpis.dash-kpis',
        kpiBox('Negative margin', s.negativeMarginCount, s.negativeMarginCount ? 'bad' : ''),
        kpiBox('Missing cost', s.noCostCount, s.noCostCount ? 'attn' : ''),
        kpiBox('Total issues', s.totalIssues)),
      list.el);
  }

  drawTabs();
  loadActive(false);

  return h('div.stack.rep-root',
    pageHead('Reports', 'Shopify-matched catalog health — Collections, Photos, UPCs & Margins'),
    tabsHost,
    bodyHost);
}
