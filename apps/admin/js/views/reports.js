import { h, mount, clear } from '../ui/dom.js';
import { card, dataTable, errorBox, loading, pageHead, toast } from '../ui/components.js';
import { dateTime } from '../ui/format.js';

export async function renderReports(ctx) {
  const host = h('div.stack', loading());

  const load = async (refresh) => {
    mount(host, loading());
    try {
      const r = await ctx.api.reportsCollectionGap(refresh);
      if (!ctx.isCurrent()) return;
      renderBody(r);
    } catch (e) {
      if (!ctx.isCurrent()) return;
      mount(host, errorBox(e));
    }
  };

  function exportCsv(items) {
    const esc = (v) => '"' + String(v === undefined || v === null ? '' : v).replace(/"/g, '""') + '"';
    const header = ['Title', 'Brand', 'Product Type', 'Inventory', 'Current Collections', 'Reason', 'Shopify Admin URL'].map(esc).join(',');
    const lines = items.map((it) => [
      it.title,
      it.vendor,
      it.productType,
      it.totalInventory,
      (it.collections || []).map((c) => c.title).join('; ') || 'None',
      it.reason,
      it.adminUrl || '',
    ].map(esc).join(','));
    const csv = [header].concat(lines).join('\n');
    const a = h('a', { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: 'shopify-products-outside-collections.csv' });
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function renderBody(r) {
    const s = r.summary || { totalActiveInStock: 0, inDeptCollections: 0, outsideDeptCollections: 0, outsideAllCollections: 0 };
    const allItems = r.items || [];
    const st = { tab: 'all_gap', q: '', typeFilter: '' };

    const tabsHost = h('div.seg-group');
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

    const drawTabs = () => {
      clear(tabsHost);
      [
        ['all_gap', 'Outside Department Collections (' + s.outsideDeptCollections + ')'],
        ['none', 'Outside ALL Collections (' + s.outsideAllCollections + ')'],
      ].forEach(([k, lbl]) => {
        tabsHost.appendChild(h('button.seg-btn', {
          type: 'button',
          class: st.tab === k ? 'on' : '',
          onclick: () => { st.tab = k; drawTabs(); drawTable(); },
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
                ? h('a', { href: it.adminUrl, target: '_blank', rel: 'noopener' }, h('strong', it.title), ' ↗')
                : h('strong', it.title),
              h('div.sku', it.vendor || '—')),
          },
          { key: 'type', label: 'Product Type', render: (it) => h('code', it.productType) },
          { key: 'qty', label: 'Stock', num: true, render: (it) => String(it.totalInventory) },
          {
            key: 'cols',
            label: 'Current Collections',
            opt: true,
            render: (it) => (it.collections && it.collections.length)
              ? it.collections.map((c) => c.title).join(', ')
              : h('span.badge.bad', 'None'),
          },
          { key: 'reason', label: 'Why Outside', render: (it) => h('span.small', it.reason) },
        ],
        rows,
        rowKey: (it) => it.id,
        empty: st.tab === 'none'
          ? 'Every active in-stock product is in at least one Shopify collection.'
          : 'All active in-stock products are inside department collections.',
      }));
    };

    drawTabs();
    drawTable();

    const kpis = h('div.kpis',
      h('div.kpi', h('div.label', 'Active In-Stock (Shopify)'), h('div.value', s.totalActiveInStock.toLocaleString('en-US')), h('div.sub', 'Active with qty > 0')),
      h('div.kpi', h('div.label', 'In Department Collections'), h('div.value', s.inDeptCollections.toLocaleString('en-US')), h('div.sub', 'Bikes, Components, Accessories, Apparel')),
      h('div.kpi', h('div.label', 'Outside Department'), h('div.value', s.outsideDeptCollections.toLocaleString('en-US')), h('div.sub', 'Missing dept-* / category rule')),
      h('div.kpi', h('div.label', 'Outside ALL Collections'), h('div.value', s.outsideAllCollections.toLocaleString('en-US')), h('div.sub', '0 collections total')));

    const typeChips = (r.typeBreakdown && r.typeBreakdown.length)
      ? card('Missing Products by Product Type (click to filter)', h('div.chips',
        r.typeBreakdown.slice(0, 24).map((tb) => h('button.chip', {
          type: 'button',
          class: st.typeFilter === tb.productType ? 'on' : '',
          onclick: () => {
            st.typeFilter = st.typeFilter === tb.productType ? '' : tb.productType;
            typeSelect.value = st.typeFilter;
            drawTable();
          },
        }, tb.productType + ' · ' + tb.count))))
      : null;

    const toolbar = h('div.toolbar',
      searchInput,
      typeSelect,
      h('button.btn.sm', { type: 'button', onclick: () => exportCsv(filteredRows()) }, 'Export CSV'),
      h('span.small.muted', r.generatedAt ? 'Checked: ' + dateTime(r.generatedAt) : ''));

    mount(host, h('div.stack',
      kpis,
      typeChips,
      card('Products Outside Collections', h('div.stack-sm', toolbar, tableHost), { flush: false, actions: tabsHost })));
  }

  load(false);

  return h('div.stack',
    pageHead('Reports · Collections Coverage', 'Audit active in-stock Shopify products that are missing from department collections or all collections.',
      [h('button.btn', { type: 'button', onclick: () => { toast('Refreshing live from Shopify…'); load(true); } }, '↻ Refresh live')]),
    host);
}
