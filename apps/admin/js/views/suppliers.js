import { h, mount } from '../ui/dom.js';
import { card, dataTable, errorBox, loading, modal, pageHead, progressBar, toast, watchJob } from '../ui/components.js';
import { ago, money } from '../ui/format.js';
import { parseCsvHeader } from './csvhead.js';

const HEALTH = { demo_adapter: ['Demo adapter', 'violet'], not_connected: ['Not connected', 'bad'], configured: ['Configured — pending verification', 'warn'], connected: ['Connected', 'ok'], error: ['Error', 'bad'] };

export async function renderSuppliers(ctx) {
  const [sup, rev] = await Promise.all([ctx.api.suppliers(), ctx.api.matchReviews()]);
  const offersHost = h('div');
  const showOffers = async (code, unmatched) => {
    mount(offersHost, loading());
    try {
      const r = await ctx.api.supplierOffers(code, { limit: 100, unmatched: unmatched ? 'true' : undefined });
      mount(offersHost, card(code + ' offers' + (unmatched ? ' (not linked to a UBC product)' : ''), dataTable({
        columns: [
          { key: 'supplier_sku', label: 'Supplier SKU', render: (o) => h('code', o.supplier_sku) },
          { key: 'title', label: 'Description', cls: 'title-cell' },
          { key: 'upc', label: 'UPC', opt: true, render: (o) => (o.upc ? h('code', o.upc) : '—') },
          { key: 'cost', label: 'Cost', num: true, render: (o) => money(o.cost_cents) },
          { key: 'qty', label: 'Qty', num: true, render: (o) => String(o.qty_available) },
          { key: 'drop', label: 'Drop-ship', opt: true, render: (o) => (o.drop_ship ? 'Yes' : 'No') },
          { key: 'link', label: 'UBC product', render: (o) => (o.ubc_sku ? h('code', o.ubc_sku) : h('span.badge.warn', 'unmatched')) },
          { key: 'rep', label: 'Reported', opt: true, render: (o) => ago(o.reported_at) },
        ],
        rows: r.offers, rowKey: (o) => o.supplier_sku, empty: 'No offers.',
      }), { flush: true }));
    } catch (e) { mount(offersHost, errorBox(e)); }
  };

  const reviewHost = h('div');
  const drawReviews = (list) => mount(reviewHost, card('Equivalence review queue (' + list.length + ')', list.length
    ? dataTable({
      columns: [
        { key: 'offer', label: 'Supplier record', cls: 'title-cell', render: (r) => h('div', h('div', r.offer_title), h('div.sku', r.supplier_code + ' ' + r.supplier_sku + ' · ' + (r.offer_brand || '') + ' · MPN ' + (r.offer_mpn || '—') + ' · UPC ' + (r.offer_upc || '—'))) },
        { key: 'cand', label: 'Possible UBC match', cls: 'title-cell', render: (r) => h('div', h('div', r.candidate_title), h('div.sku', r.candidate_sku + ' · MPN ' + (r.candidate_mpn || '—') + ' · UPC ' + (r.candidate_upc || '—'))) },
        { key: 'why', label: 'Evidence', opt: true, render: (r) => h('div.chips', (r.reasons || []).map((x) => h('span.badge', x))) },
        { key: 'score', label: 'Score', num: true, render: (r) => Number(r.score).toFixed(2) },
        { key: 'act', label: '', render: (r) => ctx.can('catalog.write') ? h('div.row',
          h('button.btn.sm', { onclick: async () => { await ctx.api.resolveReview(r.id, 'approved'); toast('Linked as the same product', 'ok'); drawReviews((await ctx.api.matchReviews()).reviews); } }, 'Same product'),
          h('button.btn.sm', { onclick: async () => { await ctx.api.resolveReview(r.id, 'rejected'); toast('Kept separate'); drawReviews((await ctx.api.matchReviews()).reviews); } }, 'Different')) : null },
      ],
      rows: list,
    })
    : h('p.muted', 'No doubtful matches. Records with equal valid GTIN are linked automatically; everything else waits here.'), { flush: !!list.length }));
  drawReviews(rev.reviews);

  return h('div.stack',
    pageHead('Suppliers', 'Distributor catalogs and availability. Supplier stock is a virtual offer, never UBC inventory.'),
    h('div.grid.grid-3', sup.suppliers.map((s) => {
      const hs = HEALTH[s.health && s.health.status] || ['Unknown', ''];
      return h('section.card', h('div.integration',
        h('div.head', h('div.logo', { style: { background: s.code === 'QBP' ? '#0e7490' : s.code === 'JBI' ? '#7c2d12' : '#991b1b' } }, s.code.slice(0, 3)),
          h('div', h('h3', s.name), h('span.badge', { class: hs[1] }, hs[0]))),
        h('dl.props', h('dt', 'Offers'), h('dd', s.offers.toLocaleString('en-US')), h('dt', 'Unmatched'), h('dd', String(s.unmatched)),
          h('dt', 'Last report'), h('dd', ago(s.last_report)), h('dt', 'Methods'), h('dd', (s.methods || []).join(', '))),
        h('p.small.muted', s.notes),
        h('div.row',
          h('button.btn.sm', { onclick: () => showOffers(s.code, false) }, 'View offers'),
          h('button.btn.sm', { onclick: () => showOffers(s.code, true) }, 'Unmatched'),
          ctx.can('catalog.write') ? h('button.btn.sm', { onclick: () => openImport(ctx, s.code) }, 'Import feed (CSV)') : null)));
    })),
    reviewHost,
    offersHost);
}

function openImport(ctx, code) {
  const file = h('input', { type: 'file', accept: '.csv,text/csv' });
  const mapHost = h('div');
  const status = h('div');
  let text = '';
  const fields = [['supplierSku', 'Supplier SKU *'], ['brand', 'Brand *'], ['title', 'Description *'], ['upc', 'UPC/EAN'], ['mpn', 'Manufacturer part #'], ['cost', 'Dealer cost'], ['map', 'MAP'], ['msrp', 'MSRP'], ['qty', 'Qty available'], ['dropShip', 'Drop-ship flag'], ['leadDays', 'Lead days']];
  const selects = {};
  const licensed = h('input', { type: 'checkbox' });
  file.addEventListener('change', () => {
    const f = file.files && file.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      text = String(reader.result || '');
      const header = parseCsvHeader(text);
      mount(mapHost, h('div.form-grid', fields.map(([k, label]) => {
        const guess = header.find((c) => c.toLowerCase().replace(/[^a-z]/g, '').indexOf(k.toLowerCase().replace(/days|ship/, '')) >= 0) || '';
        selects[k] = h('select', [h('option', { value: '' }, '— not in file —')].concat(header.map((c) => h('option', { value: c, selected: c === guess }, c))));
        return h('label.field', label, selects[k]);
      })), h('label.check', licensed, 'Our agreement allows republishing this supplier’s descriptions/images'));
    };
    reader.readAsText(f);
  });
  const go = h('button.btn.primary', {
    onclick: async () => {
      if (!text) { mount(status, h('div.notice.warn', 'Choose a CSV file first.')); return; }
      const mapping = {};
      Object.keys(selects).forEach((k) => { if (selects[k].value) mapping[k] = selects[k].value; });
      if (!mapping.supplierSku || !mapping.brand || !mapping.title) { mount(status, h('div.notice.warn', 'Map at least SKU, brand and description.')); return; }
      go.disabled = true;
      const pb = progressBar();
      const lbl = h('span.small.muted');
      mount(status, h('div.stack', pb.el, lbl));
      try {
        const r = await ctx.api.importFeed(code, { csv: text, mapping, contentLicensed: licensed.checked });
        const job = await watchJob(ctx.api, r.jobId, pb.bar, lbl);
        if (job.status !== 'succeeded') throw new Error(job.last_error || 'Import failed');
        const s = job.result;
        mount(status, h('div.notice.ok', 'Imported ' + s.upserted + ' records: ' + s.autoMatched + ' auto-matched (GTIN), ' + s.review + ' sent to review, ' + s.unmatched + ' new/unmatched' + (s.rowErrorCount ? ', ' + s.rowErrorCount + ' rows rejected' : '') + '.'));
        go.disabled = false;
      } catch (e) { mount(status, h('div.notice.bad', e.message)); go.disabled = false; }
    },
  }, 'Import');
  const m = modal({
    title: 'Import ' + code + ' catalog feed', wide: true,
    body: [h('p.small.muted', 'Use only files the supplier authorises you to use. Rows are validated; doubtful product matches go to the review queue instead of creating duplicates.'), h('label.field', 'CSV file', file), mapHost, status],
    actions: [h('button.btn', { onclick: () => { m.close(); ctx.navigate('#/suppliers?r=' + Date.now()); } }, 'Close'), go],
  });
}
