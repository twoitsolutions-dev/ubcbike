import { h, mount, clear } from '../ui/dom.js';
import { card, dataTable, errorBox, loading, pageHead } from '../ui/components.js';
import { dateTime, money, pct } from '../ui/format.js';

function downloadCsv(filename, header, rows) {
  const esc = (v) => '"' + String(v === undefined || v === null ? '' : v).replace(/"/g, '""') + '"';
  const csv = [header.map(esc).join(',')].concat(rows.map((r) => r.map(esc).join(','))).join('\n');
  const a = h('a', { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export async function renderReports(ctx) {
  const cache = { shopify: null, noUpc: null, margin: null };
  let activeReport = ctx.query.report || 'collections';
  const tabsHost = h('div.seg-group');
  const bodyHost = h('div.stack', loading('Loading report…'));

  const TABS = [
    ['collections', 'Collections Coverage'],
    ['photos', 'No Photos (Shopify)'],
    ['no_upc', 'Stock Without UPC'],
    ['margin', 'No Cost / Negative Margin'],
  ];

  const drawTabs = () => {
    mount(tabsHost, TABS.map(([id, label]) =>
      h('button.seg-btn', {
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

  function renderCollectionsReport(r) {
    const s = r.summary || { totalActiveInStock: 0, inDeptCollections: 0, outsideDeptCollections: 0, outsideAllCollections: 0 };
    const allItems = r.items || [];
    const st = { tab: 'all_gap', q: '', typeFilter: '' };
    const subTabs = h('div.seg-group');
    const tableHost = h('div');

    const typeSelect = h('select', {
      onchange: (e) => { st.typeFilter = e.target.value; drawTable(); },
    }, [h('option', { value: '' }, 'All product types (' + (r.typeBreakdown ? r.typeBreakdown.length : 0) + ')')].concat(
      (r.typeBreakdown || []).map((tb) => h('option', { value: tb.productType }, tb.productType + ' (' + tb.count + ')')),
    ));
    const searchInput = h('input', {
      type: 'search',
      placeholder: 'Search title, brand, or product type…',
      oninput: (e) => { st.q = (e.target.value || '').trim().toLowerCase(); drawTable(); },
    });

    const filteredRows = () => allItems.filter((it) => {
      if (st.tab === 'none' && it.gapType !== 'no_collections') return false;
      if (st.typeFilter && it.productType !== st.typeFilter) return false;
      if (st.q) {
        const hay = (it.title + ' ' + it.vendor + ' ' + it.productType + ' ' + it.reason).toLowerCase();
        if (!hay.includes(st.q)) return false;
      }
      return true;
    });

    const drawSubTabs = () => {
      clear(subTabs);
      [
        ['all_gap', 'Outside Dept Collections (' + s.outsideDeptCollections + ')'],
        ['none', 'Outside ALL Collections (' + s.outsideAllCollections + ')'],
      ].forEach(([k, lbl]) => {
        subTabs.appendChild(h('button.seg-btn', {
          type: 'button',
          class: st.tab === k ? 'on' : '',
          onclick: () => { st.tab = k; drawSubTabs(); drawTable(); },
        }, lbl));
      });
    };

    const drawTable = () => {
      const rows = filteredRows();
      mount(tableHost, dataTable({
        columns: [
          {
            key: 'title',
            label: 'Product',
            cls: 'title-cell',
            render: (it) => h('div',
              it.adminUrl
                ? h('a', { href: it.adminUrl, target: '_blank', rel: 'noopener' }, h('strong', it.title))
                : h('strong', it.title),
              h('div.sku', (it.vendor || '—') + ' · Type: ' + it.productType)),
          },
          { key: 'inv', label: 'Stock', num: true, render: (it) => String(it.totalInventory || 0) },
          {
            key: 'cols',
            label: 'Current Collections',
            opt: true,
            render: (it) => (it.collections && it.collections.length
              ? it.collections.map((c) => c.title).join(', ')
              : h('span.badge.bad', 'None')),
          },
          { key: 'reason', label: 'Why', opt: true },
        ],
        rows,
        empty: 'Every active in-stock product is inside a department collection!',
      }));
    };

    drawSubTabs();
    drawTable();

    mount(bodyHost,
      h('div.kpis',
        h('div.kpi', h('div.label', 'Active in-stock (Shopify)'), h('div.value', s.totalActiveInStock.toLocaleString('en-US'))),
        h('div.kpi', h('div.label', 'In dept collections'), h('div.value', s.inDeptCollections.toLocaleString('en-US'))),
        h('div.kpi', { class: s.outsideDeptCollections ? 'attn' : '' }, h('div.label', 'Outside dept collections'), h('div.value', s.outsideDeptCollections.toLocaleString('en-US'))),
        h('div.kpi', { class: s.outsideAllCollections ? 'bad' : '' }, h('div.label', 'Outside ALL collections'), h('div.value', s.outsideAllCollections.toLocaleString('en-US')))),
      card('Products outside collections', h('div.stack',
        h('div.row-between',
          subTabs,
          h('div.row',
            h('button.btn.sm', {
              onclick: () => downloadCsv(
                'shopify-products-outside-collections.csv',
                ['Title', 'Brand', 'Product Type', 'Inventory', 'Current Collections', 'Reason', 'Shopify Admin URL'],
                filteredRows().map((it) => [it.title, it.vendor, it.productType, it.totalInventory, (it.collections || []).map((c) => c.title).join('; ') || 'None', it.reason, it.adminUrl || '']),
              ),
            }, 'Export CSV'),
            h('button.btn.sm', { onclick: () => loadActive(true) }, 'Refresh'))),
        h('div.row', { style: { gap: '8px' } }, searchInput, typeSelect),
        tableHost), { actions: h('span.small.muted', r.generatedAt ? 'Checked ' + dateTime(r.generatedAt) : '') }));
  }

  function renderNoPhotosReport(r) {
    const items = r.noPhotoItems || [];
    const total = (r.summary && r.summary.totalActiveInStock) || 0;
    let q = '';
    const tableHost = h('div');
    const searchInput = h('input', {
      type: 'search',
      placeholder: 'Search title, brand, or product type…',
      oninput: (e) => { q = (e.target.value || '').trim().toLowerCase(); drawTable(); },
    });

    const filtered = () => (!q ? items : items.filter((it) => (it.title + ' ' + it.vendor + ' ' + it.productType).toLowerCase().includes(q)));

    const drawTable = () => {
      mount(tableHost, dataTable({
        columns: [
          {
            key: 'title',
            label: 'Product (click to add photo in Shopify)',
            cls: 'title-cell',
            render: (it) => h('div',
              it.adminUrl ? h('a', { href: it.adminUrl, target: '_blank', rel: 'noopener' }, h('strong', it.title)) : h('strong', it.title),
              h('div.sku', (it.vendor || '—') + ' · Type: ' + (it.productType || '—'))),
          },
          { key: 'inv', label: 'Stock', num: true, render: (it) => String(it.totalInventory || 0) },
        ],
        rows: filtered(),
        empty: 'Every active in-stock Shopify product has a photo!',
      }));
    };
    drawTable();

    mount(bodyHost,
      h('div.kpis',
        h('div.kpi', h('div.label', 'Active in-stock (Shopify)'), h('div.value', total.toLocaleString('en-US'))),
        h('div.kpi', { class: items.length ? 'attn' : '' }, h('div.label', 'Missing photo'), h('div.value', items.length.toLocaleString('en-US'))),
        h('div.kpi', h('div.label', 'With photo'), h('div.value', Math.max(0, total - items.length).toLocaleString('en-US')))),
      card('Active in-stock Shopify products with no photos', h('div.stack',
        h('div.row-between',
          searchInput,
          h('div.row',
            h('button.btn.sm', {
              onclick: () => downloadCsv(
                'shopify-products-without-photos.csv',
                ['Title', 'Brand', 'Product Type', 'Inventory', 'Shopify Admin URL'],
                filtered().map((it) => [it.title, it.vendor, it.productType, it.totalInventory, it.adminUrl || '']),
              ),
            }, 'Export CSV'),
            h('button.btn.sm', { onclick: () => loadActive(true) }, 'Refresh'))),
        tableHost)));
  }

  function renderNoUpcReport(r) {
    const s = r.summary || { totalInStock: 0, missingUpc: 0, totalUnits: 0 };
    const items = r.items || [];
    let q = '';
    const tableHost = h('div');
    const searchInput = h('input', {
      type: 'search',
      placeholder: 'Search title, brand, category, or SKU…',
      oninput: (e) => { q = (e.target.value || '').trim().toLowerCase(); drawTable(); },
    });

    const filtered = () => (!q ? items : items.filter((it) => (it.title + ' ' + it.brand + ' ' + it.category + ' ' + it.sku + ' ' + it.mpn).toLowerCase().includes(q)));

    const drawTable = () => {
      mount(tableHost, dataTable({
        columns: [
          {
            key: 'title',
            label: 'Lightspeed item',
            cls: 'title-cell',
            render: (it) => h('div',
              h('a', { href: '#/products/' + it.id }, h('strong', it.title)),
              h('div.sku', 'SKU ' + it.sku + (it.mpn ? ' · MPN ' + it.mpn : ''))),
          },
          { key: 'brand', label: 'Brand', opt: true },
          { key: 'category', label: 'Category', opt: true },
          { key: 'price', label: 'Price', num: true, render: (it) => money(it.priceCents) },
          { key: 'qty', label: 'In-Store Qty', num: true, render: (it) => String(it.physicalQty || 0) },
        ],
        rows: filtered(),
        empty: 'All in-stock Lightspeed items have a UPC!',
      }));
    };
    drawTable();

    mount(bodyHost,
      h('div.kpis',
        h('div.kpi', h('div.label', 'In-stock items (Lightspeed)'), h('div.value', s.totalInStock.toLocaleString('en-US'))),
        h('div.kpi', { class: s.missingUpc ? 'attn' : '' }, h('div.label', 'Missing UPC'), h('div.value', s.missingUpc.toLocaleString('en-US'))),
        h('div.kpi', h('div.label', 'Units without UPC'), h('div.value', s.totalUnits.toLocaleString('en-US')))),
      card('In-Store Stock Without UPC (add UPC in Lightspeed or Create in Shopify)', h('div.stack',
        h('div.row-between',
          searchInput,
          h('div.row',
            h('button.btn.sm', {
              onclick: () => downloadCsv(
                'lightspeed-in-stock-without-upc.csv',
                ['Title', 'Brand', 'Category', 'System SKU', 'MPN', 'Price', 'In-Store Qty'],
                filtered().map((it) => [it.title, it.brand, it.category, it.sku, it.mpn, (it.priceCents / 100).toFixed(2), it.physicalQty]),
              ),
            }, 'Export CSV'),
            h('button.btn.sm', { onclick: () => loadActive(true) }, 'Refresh'))),
        tableHost)));
  }

  function renderMarginReport(r) {
    const s = r.summary || { totalIssues: 0, noCostCount: 0, negativeMarginCount: 0 };
    const items = r.items || [];
    let filterMode = 'all';
    let q = '';
    const subTabs = h('div.seg-group');
    const tableHost = h('div');
    const searchInput = h('input', {
      type: 'search',
      placeholder: 'Search title, brand, or SKU…',
      oninput: (e) => { q = (e.target.value || '').trim().toLowerCase(); drawTable(); },
    });

    const filtered = () => items.filter((it) => {
      if (filterMode === 'neg' && it.issue !== 'negative_margin') return false;
      if (filterMode === 'nocost' && it.issue !== 'no_cost') return false;
      if (q && !(it.title + ' ' + it.brand + ' ' + it.sku).toLowerCase().includes(q)) return false;
      return true;
    });

    const drawSub = () => {
      clear(subTabs);
      [
        ['all', 'All (' + s.totalIssues + ')'],
        ['neg', 'Negative Margin (' + s.negativeMarginCount + ')'],
        ['nocost', 'Missing Cost (' + s.noCostCount + ')'],
      ].forEach(([k, lbl]) => {
        subTabs.appendChild(h('button.seg-btn', {
          type: 'button',
          class: filterMode === k ? 'on' : '',
          onclick: () => { filterMode = k; drawSub(); drawTable(); },
        }, lbl));
      });
    };

    const drawTable = () => {
      mount(tableHost, dataTable({
        columns: [
          {
            key: 'title',
            label: 'Lightspeed item',
            cls: 'title-cell',
            render: (it) => h('div',
              h('a', { href: '#/products/' + it.id }, h('strong', it.title)),
              h('div.sku', (it.brand || '—') + ' · SKU ' + it.sku)),
          },
          { key: 'qty', label: 'Qty', num: true, render: (it) => String(it.physicalQty || 0) },
          { key: 'price', label: 'Price', num: true, render: (it) => money(it.priceCents) },
          { key: 'cost', label: 'Cost', num: true, render: (it) => (it.costCents && it.costCents > 0 ? money(it.costCents) : h('span.badge.warn', 'No cost')) },
          { key: 'margin', label: 'Margin', num: true, render: (it) => (it.marginPct === null ? '—' : h('span.badge.bad', pct(it.marginPct))) },
        ],
        rows: filtered(),
        empty: 'No missing cost or negative margin items in stock!',
      }));
    };

    drawSub();
    drawTable();

    mount(bodyHost,
      h('div.kpis',
        h('div.kpi', { class: s.negativeMarginCount ? 'bad' : '' }, h('div.label', 'Negative margin'), h('div.value', s.negativeMarginCount.toLocaleString('en-US'))),
        h('div.kpi', { class: s.noCostCount ? 'attn' : '' }, h('div.label', 'Missing cost'), h('div.value', s.noCostCount.toLocaleString('en-US'))),
        h('div.kpi', h('div.label', 'Total in-stock issues'), h('div.value', s.totalIssues.toLocaleString('en-US')))),
      card('In-Store Items With Missing Cost or Negative Margin', h('div.stack',
        h('div.row-between',
          subTabs,
          h('div.row',
            h('button.btn.sm', {
              onclick: () => downloadCsv(
                'lightspeed-margin-and-cost-issues.csv',
                ['Title', 'Brand', 'SKU', 'In-Store Qty', 'Price', 'Cost', 'Issue'],
                filtered().map((it) => [it.title, it.brand, it.sku, it.physicalQty, (it.priceCents / 100).toFixed(2), it.costCents ? (it.costCents / 100).toFixed(2) : '', it.issue]),
              ),
            }, 'Export CSV'),
            h('button.btn.sm', { onclick: () => loadActive(true) }, 'Refresh'))),
        searchInput,
        tableHost)));
  }

  drawTabs();
  loadActive(false);

  return h('div.stack',
    pageHead('Reports', 'Catalog health across Shopify & Lightspeed — Collections, Photos, UPCs & Margins'),
    h('div.row', tabsHost),
    bodyHost);
}
