import { h, mount } from '../ui/dom.js';
import { card, dataTable, errorBox, loading, pageHead, pager, toast } from '../ui/components.js';
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
  const cache = { shopify: null, noUpc: null, margin: null, sales: {}, aging: {} };
  let activeReport = ctx.query.report || 'collections';
  let salesDays = ctx.query.days || '30';
  let agingDays = ctx.query.minDays || '30';
  const tabsHost = h('div.rep-tabs');
  const bodyHost = h('div.stack.rep-body', loading('Loading report…'));

  const TABS = [
    ['collections', 'Collections'],
    ['photos', 'No Photos'],
    ['no_upc', 'No UPC'],
    ['margin', 'Cost, MAP & Margin'],
    ['sales', 'Sales & Margin'],
    ['aging', 'Days Without Sales'],
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

  async function ensureSales(days, refresh) {
    if (!refresh && cache.sales[days]) return cache.sales[days];
    cache.sales[days] = await ctx.api.reportsSalesProfitability(days);
    return cache.sales[days];
  }

  async function ensureAging(minDays, refresh) {
    if (!refresh && cache.aging[minDays]) return cache.aging[minDays];
    cache.aging[minDays] = await ctx.api.reportsDaysWithoutSales(minDays);
    return cache.aging[minDays];
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
      } else if (activeReport === 'sales') {
        const r = await ensureSales(salesDays, refresh);
        if (!ctx.isCurrent()) return;
        renderSalesReport(r);
      } else if (activeReport === 'aging') {
        const r = await ensureAging(agingDays, refresh);
        if (!ctx.isCurrent()) return;
        renderAgingReport(r);
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
    const s = r.summary || { totalIssues: 0, noCostCount: 0, negativeMarginCount: 0, mapViolationCount: 0 };
    const items = r.items || [];
    let filterMode = 'all';
    let q = '';

    const modeSelect = h('select.rep-select', {
      onchange: (e) => { filterMode = e.target.value; list.redraw(); },
    },
    h('option', { value: 'all' }, 'All issues (' + s.totalIssues + ')'),
    h('option', { value: 'neg' }, 'Negative Margin (' + (s.negativeMarginCount || 0) + ')'),
    h('option', { value: 'map' }, 'MAP Violation (' + (s.mapViolationCount || 0) + ')'),
    h('option', { value: 'nocost' }, 'Missing Cost (' + (s.noCostCount || 0) + ')'));

    const searchInput = h('input.rep-search', {
      type: 'search',
      placeholder: 'Search title, brand, SKU…',
      oninput: (e) => { q = (e.target.value || '').trim().toLowerCase(); list.redraw(); },
    });

    const list = renderPaginatedCard({
      title: 'In-stock catalog health: Cost > Retail, MAP floor & missing cost',
      meta: s.totalIssues.toLocaleString('en-US') + ' items',
      toolbar: h('div.rep-filters', searchInput, modeSelect),
      getRows: () => items.filter((it) => {
        if (filterMode === 'neg' && it.issue !== 'negative_margin') return false;
        if (filterMode === 'map' && it.issue !== 'map_violation') return false;
        if (filterMode === 'nocost' && it.issue !== 'no_cost') return false;
        if (q && !(it.title + ' ' + it.brand + ' ' + it.sku).toLowerCase().includes(q)) return false;
        return true;
      }),
      columns: [
        {
          key: 'title',
          label: 'Item',
          cls: 'title-cell',
          render: (it) => h('div',
            h('a', { href: '#/products/' + it.id }, h('strong', it.title)),
            h('div.sku', (it.brand || '—') + ' · SKU ' + it.sku + ' · Qty ' + it.physicalQty)),
        },
        { key: 'price', label: 'Price', num: true, render: (it) => money(it.priceCents) },
        { key: 'cost', label: 'Cost', num: true, opt: true, render: (it) => (it.costCents && it.costCents > 0 ? money(it.costCents) : h('span.badge.warn', 'No cost')) },
        { key: 'map', label: 'MAP', num: true, opt: true, render: (it) => (it.mapCents && it.mapCents > 0 ? money(it.mapCents) : '—') },
        {
          key: 'margin',
          label: 'Alert / Margin',
          num: true,
          render: (it) => (it.issue === 'map_violation'
            ? h('span.badge.bad', 'Below MAP')
            : it.marginPct === null
              ? h('span.badge.warn', 'No cost')
              : h('span.badge.bad', pct(it.marginPct))),
        },
        {
          key: 'fix',
          label: 'Action',
          render: (it) => h('a.btn.sm', { href: '#/lightspeed-sheet?stock=physical&q=' + encodeURIComponent(it.sku) }, 'Bulk Sheet →'),
        },
      ],
      empty: 'No negative margin, MAP violation, or missing cost items in stock!',
      onCsv: (rows) => downloadCsv(
        'catalog-health-margin-and-map-issues.csv',
        ['Title', 'Brand', 'SKU', 'In-Store Qty', 'Price', 'Cost', 'MAP', 'Issue', 'Shopify Admin URL'],
        rows.map((it) => [it.title, it.brand, it.sku, it.physicalQty, (it.priceCents / 100).toFixed(2), it.costCents ? (it.costCents / 100).toFixed(2) : '', it.mapCents ? (it.mapCents / 100).toFixed(2) : '', it.issue, it.adminUrl || '']),
      ),
    });

    mount(bodyHost,
      h('div.kpis.dash-kpis',
        kpiBox('Negative margin', s.negativeMarginCount || 0, s.negativeMarginCount ? 'bad' : ''),
        kpiBox('MAP violations', s.mapViolationCount || 0, s.mapViolationCount ? 'bad' : ''),
        kpiBox('Missing cost', s.noCostCount || 0, s.noCostCount ? 'attn' : ''),
        kpiBox('Total issues', s.totalIssues || 0)),
      list.el);
  }

  function renderSalesReport(r) {
    const s = r.summary || { orderCount: 0, unitsSold: 0, revenueCents: 0, knownCostCents: 0, grossProfitCents: 0, marginPct: null };
    const topSkus = r.topSkus || [];
    const camps = r.campaigns || [];
    let q = '';

    const rangeSel = h('select.rep-select', {
      onchange: (e) => { salesDays = e.target.value; loadActive(true); },
    },
    h('option', { value: '7', selected: salesDays === '7' }, 'Last 7 days'),
    h('option', { value: '30', selected: salesDays === '30' }, 'Last 30 days'),
    h('option', { value: '90', selected: salesDays === '90' }, 'Last 90 days'),
    h('option', { value: 'all', selected: salesDays === 'all' }, 'All time'));

    const searchInput = h('input.rep-search', {
      type: 'search',
      placeholder: 'Filter SKU or product title…',
      oninput: (e) => { q = (e.target.value || '').trim().toLowerCase(); skuCard.redraw(); },
    });

    const campCard = card('Campaign Profitability (Online + POS Promos)', camps.length
      ? dataTable({
        columns: [
          { key: 'name', label: 'Promotion', render: (c) => h('a', { href: '#/promotions/' + c.id }, h('strong', c.name)) },
          { key: 'status', label: 'Status', render: (c) => h('span.badge', { class: c.status === 'active' ? 'ok' : '' }, c.status) },
          { key: 'orders', label: 'Orders', num: true, render: (c) => String(c.ordersCount || 0) },
          { key: 'units', label: 'Units', num: true, render: (c) => String(c.unitsSold || 0) },
          { key: 'rev', label: 'Revenue', num: true, render: (c) => money(c.revenueCents) },
          { key: 'profit', label: 'Est. Profit', num: true, opt: true, render: (c) => money(c.grossProfitCents) },
          { key: 'margin', label: 'Margin', num: true, render: (c) => (c.marginPct === null ? '—' : pct(c.marginPct)) },
        ],
        rows: camps,
      })
      : h('div.dash-empty', h('span.muted', 'No active or completed promotions in this window yet.')),
    { flush: !!camps.length });

    const skuCard = renderPaginatedCard({
      title: 'Top Selling Web SKUs & Margin',
      meta: topSkus.length + ' SKUs',
      toolbar: h('div.rep-filters', rangeSel, searchInput),
      getRows: () => (!q ? topSkus : topSkus.filter((it) => (it.sku + ' ' + it.title).toLowerCase().includes(q))),
      columns: [
        {
          key: 'title',
          label: 'Product / SKU',
          cls: 'title-cell',
          render: (it) => h('div',
            it.variantId ? h('a', { href: '#/products/' + it.variantId }, h('strong', it.title)) : h('strong', it.title),
            h('div.sku', 'SKU ' + it.sku + ' · ' + it.ordersCount + ' order(s)')),
        },
        { key: 'units', label: 'Units', num: true, render: (it) => String(it.unitsSold || 0) },
        { key: 'rev', label: 'Revenue', num: true, render: (it) => money(it.revenueCents) },
        { key: 'cost', label: 'Est. Cost', num: true, opt: true, render: (it) => (it.costCents ? money(it.costCents) : '—') },
        { key: 'margin', label: 'Margin', num: true, render: (it) => (it.marginPct === null ? '—' : h('span.badge', { class: it.marginPct < 0.15 ? 'warn' : 'ok' }, pct(it.marginPct))) },
      ],
      empty: 'No Shopify web orders recorded in this period yet.',
      onCsv: (rows) => downloadCsv(
        'ubc-web-sales-profitability.csv',
        ['SKU', 'Title', 'Orders', 'Units', 'Revenue ($)', 'Est Cost ($)', 'Est Profit ($)', 'Margin %'],
        rows.map((it) => [it.sku, it.title, it.ordersCount, it.unitsSold, (it.revenueCents / 100).toFixed(2), (it.costCents / 100).toFixed(2), (it.grossProfitCents / 100).toFixed(2), it.marginPct === null ? '' : (it.marginPct * 100).toFixed(1) + '%']),
      ),
    });

    mount(bodyHost,
      h('div.kpis.dash-kpis',
        kpiBox('Web orders', s.orderCount || 0),
        kpiBox('Gross revenue', money(s.revenueCents || 0)),
        kpiBox('Est. gross profit', money(s.grossProfitCents || 0), s.grossProfitCents > 0 ? 'ok' : ''),
        kpiBox('Avg. margin', s.marginPct === null ? '—' : pct(s.marginPct))),
      campCard,
      skuCard.el);
  }

  function renderAgingReport(r) {
    const s = r.summary || {};
    const dayInput = h('input', {
      type: 'number',
      min: '0',
      max: '3650',
      value: String(agingDays),
      placeholder: 'Days…',
      title: 'Minimum days without sale (0 = all in-stock)',
      style: 'width:84px',
      onkeydown: (e) => {
        if (e.key === 'Enter') {
          const n = Math.max(0, Math.min(3650, Math.floor(Number(dayInput.value) || 0)));
          agingDays = String(n);
          loadActive(true);
        }
      },
    });
    const dayApplyBtn = h('button.btn.sm', {
      type: 'button',
      onclick: () => {
        const n = Math.max(0, Math.min(3650, Math.floor(Number(dayInput.value) || 0)));
        agingDays = String(n);
        loadActive(true);
      },
    }, 'Apply');
    const daySel = h('select', {
      onchange: (e) => { agingDays = e.target.value; dayInput.value = agingDays; loadActive(true); },
    },
    [['30', '30+ days'], ['60', '60+ days'], ['90', '90+ days'], ['180', '180+ days'], ['0', 'All in-stock']]
      .map(([v, lbl]) => h('option', { value: v, selected: agingDays === v }, lbl)));
    const sheetBtn = h('a.btn.sm.primary', {
      href: '#/lightspeed-sheet?stock=physical&minDays=' + encodeURIComponent(agingDays),
    }, 'Edit in Bulk Sheet →');
    const syncSalesBtn = ctx.api.reportsSyncLightspeedSales
      ? h('button.btn.sm', {
        type: 'button',
        onclick: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          btn.textContent = 'Syncing Lightspeed…';
          try {
            const res = await ctx.api.reportsSyncLightspeedSales();
            if (res.status === 'missing_sales_scope') {
              toast('Lightspeed token lacks sales read scope (403). Re-authorize with Sales read if needed.', 'bad');
            } else {
              toast('Synced ' + (res.salesLinesSeen || 0) + ' Lightspeed sale lines (' + (res.variantsUpdated || 0) + ' items updated).', 'ok');
              loadActive(true);
            }
          } catch (err) {
            toast(err.message || 'Could not sync Lightspeed sales', 'bad');
          } finally {
            btn.disabled = false;
            btn.textContent = '↻ Sync Lightspeed Sales';
          }
        },
      }, '↻ Sync Lightspeed Sales')
      : null;

    const agingCard = renderPaginatedCard({
      title: 'In-Stock Inventory · Days Without Sales (Top 500 by Capital Tied Up)',
      meta: 'Generated ' + dateTime(r.generatedAt),
      toolbar: [h('span.small.muted', 'Days ≥'), dayInput, dayApplyBtn, daySel, syncSalesBtn, sheetBtn],
      getRows: (q) => (r.rows || []).filter((it) => !q || (it.sku + ' ' + it.upc + ' ' + it.title + ' ' + it.brand + ' ' + it.category).toLowerCase().includes(q)),
      columns: [
        { key: 'sku', label: 'SKU / UPC', render: (it) => h('div', h('strong.mono', it.sku), it.upc ? h('div.small.muted.mono', it.upc) : null) },
        { key: 'title', label: 'Item', render: (it) => h('div', h('span', it.title), it.brand ? h('div.small.muted', it.brand + (it.category ? ' · ' + it.category : '')) : null) },
        { key: 'onHand', label: 'On Hand', num: true, render: (it) => String(it.onHand) },
        { key: 'cost', label: 'Stock Cost', num: true, render: (it) => (it.stockCostCents ? money(it.stockCostCents) : '—') },
        { key: 'days', label: 'Days No Sale', num: true, render: (it) => h('span.badge', { class: it.daysWithoutSale === null || it.daysWithoutSale >= 90 ? 'warn' : '' }, it.daysWithoutSale === null ? 'No recent sale' : (it.daysWithoutSale + ' d')) },
        { key: 'act', label: '', render: (it) => h('a.btn.sm', { href: '#/lightspeed-sheet?stock=physical&q=' + encodeURIComponent(it.sku) }, 'Bulk Sheet →') },
      ],
      empty: 'No in-stock items match this aging window.',
      onCsv: (rows) => downloadCsv(
        'ubc-days-without-sales.csv',
        ['SKU', 'UPC', 'Title', 'Brand', 'Category', 'On Hand', 'Unit Cost ($)', 'Stock Cost ($)', 'Retail ($)', 'Days Without Sale'],
        rows.map((it) => [it.sku, it.upc, it.title, it.brand, it.category, it.onHand, (it.costCents / 100).toFixed(2), (it.stockCostCents / 100).toFixed(2), (it.priceCents / 100).toFixed(2), it.daysWithoutSale === null ? 'No Hub sale' : it.daysWithoutSale]),
      ),
    });

    mount(bodyHost,
      h('div.kpis.dash-kpis',
        kpiBox('In-stock SKUs', s.totalSkus || 0),
        kpiBox('Units on hand', s.totalUnits || 0),
        kpiBox('Capital tied up (Cost)', money(s.totalCostCents || 0), 'warn'),
        kpiBox('No recorded Hub sale', s.neverSoldCount || 0)),
      agingCard.el);
  }

  const refreshBtn = ctx.api.refreshSkuIndex && (!ctx.can || ctx.can('catalog.write'))
    ? h('button.btn.sm', {
      type: 'button',
      onclick: async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = 'Refreshing…';
        try {
          await ctx.api.refreshSkuIndex();
          toast('Web SKU/MPN search index refresh queued — live in ~10s.', 'ok');
        } catch (err) {
          toast(err.message || 'Could not queue index refresh', 'bad');
        } finally {
          btn.disabled = false;
          btn.textContent = '↻ Search Index';
        }
      },
    }, '↻ Search Index')
    : null;

  drawTabs();
  loadActive(false);

  return h('div.stack.rep-root',
    pageHead('Reports', 'Catalog health, Cost/MAP alerts, Web Sales & Campaign Profitability', refreshBtn ? [refreshBtn] : []),
    tabsHost,
    bodyHost);
}
