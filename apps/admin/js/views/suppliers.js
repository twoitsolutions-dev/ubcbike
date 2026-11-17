import { h, mount } from '../ui/dom.js';
import { card, confirmDialog, dataTable, errorBox, loading, modal, pageHead, progressBar, sectionTabs, toast, watchJob } from '../ui/components.js';
import { ago, money } from '../ui/format.js';
import { inferFeedMapping } from '../vendor/csv.js';
import { detectHeaderDelimiter, parseCsvHeader, splitCsvChunks } from './csvhead.js';

const HEALTH = { demo_adapter: ['Demo adapter', 'violet'], not_connected: ['Not connected', 'bad'], configured: ['Configured — pending verification', 'warn'], connected: ['Connected', 'ok'], error: ['Error', 'bad'] };

export function vendorCatalogTabs(activeKey) {
  return sectionTabs([
    ['catalogs', 'Vendor Catalogs & Matching', '#/suppliers'],
    ['sync', 'Feed Sync & MAP Quarantine', '#/pipeline'],
  ], activeKey);
}

export async function renderSuppliers(ctx) {
  const PAGE_SIZE = 100;
  let reviewOffset = 0;

  const [sup, initialRev] = await Promise.all([
    ctx.api.suppliers(),
    ctx.api.matchReviews({ limit: PAGE_SIZE, offset: 0 }),
  ]);

  const offersHost = h('div');
  const showOffers = async (code, unmatched) => {
    mount(offersHost, loading());
    try {
      const r = await ctx.api.supplierOffers(code, { limit: 100, unmatched: unmatched ? 'true' : undefined });
      mount(offersHost, card(code + ' Vendor Catalog' + (unmatched ? ' (unmatched items)' : ''), dataTable({
        columns: [
          { key: 'supplier_sku', label: 'Vendor Part #', render: (o) => h('code', o.supplier_sku) },
          { key: 'title', label: 'Item Description', cls: 'title-cell' },
          { key: 'upc', label: 'UPC', opt: true, render: (o) => (o.upc ? h('code', o.upc) : '—') },
          { key: 'cost', label: 'Dealer Cost', num: true, render: (o) => money(o.cost_cents) },
          { key: 'qty', label: 'Vendor Qty', num: true, render: (o) => String(o.qty_available) },
          { key: 'drop', label: 'Drop-ship', opt: true, render: (o) => (o.drop_ship ? 'Yes' : 'No') },
          { key: 'link', label: 'Linked UBC Item', render: (o) => (o.ubc_sku ? h('code', o.ubc_sku) : h('span.badge.warn', 'unmatched')) },
          { key: 'rep', label: 'Feed Sync', opt: true, render: (o) => ago(o.reported_at) },
        ],
        rows: r.offers, rowKey: (o) => o.supplier_sku, empty: 'No catalog items.',
      }), { flush: true }));
    } catch (e) { mount(offersHost, errorBox(e)); }
  };

  const reviewHost = h('div');
  const reloadReviews = async () => {
    const rev = await ctx.api.matchReviews({ limit: PAGE_SIZE, offset: reviewOffset });
    drawReviews(rev.reviews || [], typeof rev.total === 'number' ? rev.total : (rev.reviews || []).length);
  };

  const drawReviews = (list, total) => {
    const pager = total > PAGE_SIZE ? h('div.row', { style: { justifyContent: 'space-between', padding: '10px 16px' } },
      h('span.small.muted', 'Showing ' + (reviewOffset + 1) + '–' + Math.min(reviewOffset + list.length, total) + ' of ' + total.toLocaleString('en-US') + ' pending matches'),
      h('div.row',
        h('button.btn.sm', { disabled: reviewOffset <= 0, onclick: () => { reviewOffset = Math.max(0, reviewOffset - PAGE_SIZE); reloadReviews(); } }, 'Previous'),
        h('button.btn.sm', { disabled: reviewOffset + PAGE_SIZE >= total, onclick: () => { reviewOffset += PAGE_SIZE; reloadReviews(); } }, 'Next'))) : null;

    mount(reviewHost, card('Item Matching Review Queue (' + total.toLocaleString('en-US') + ')', list.length
      ? h('div.stack', dataTable({
        columns: [
          { key: 'offer', label: 'Vendor Catalog Item', cls: 'title-cell', render: (r) => h('div', h('div', r.offer_title), h('div.sku', r.supplier_code + ' ' + r.supplier_sku + ' · ' + (r.offer_brand || '') + ' · MPN ' + (r.offer_mpn || '—') + ' · UPC ' + (r.offer_upc || '—'))) },
          { key: 'cand', label: 'Possible UBC Item Match', cls: 'title-cell', render: (r) => h('div', h('div', r.candidate_title), h('div.sku', r.candidate_sku + ' · MPN ' + (r.candidate_mpn || '—') + ' · UPC ' + (r.candidate_upc || '—'))) },
          { key: 'why', label: 'Evidence', opt: true, render: (r) => h('div.chips', (r.reasons || []).map((x) => h('span.badge', x))) },
          { key: 'score', label: 'Score', num: true, render: (r) => Number(r.score).toFixed(2) },
          { key: 'act', label: '', render: (r) => ctx.can('catalog.write') ? h('div.row',
            h('button.btn.sm', { onclick: async () => { await ctx.api.resolveReview(r.id, 'approved'); toast('Linked as the same item', 'ok'); reloadReviews(); } }, 'Same item'),
            h('button.btn.sm', { onclick: async () => { await ctx.api.resolveReview(r.id, 'rejected'); toast('Kept separate'); reloadReviews(); } }, 'Different')) : null },
        ],
        rows: list,
      }), pager)
      : h('p.muted', 'No doubtful matches. Items with matching valid UPC/GTIN link automatically; everything else waits here for confirmation.'), { flush: !!list.length }));
  };

  drawReviews(
    initialRev.reviews || [],
    typeof initialRev.total === 'number' ? initialRev.total : (initialRev.reviews || []).length,
  );

  return h('div.stack',
    pageHead('Vendor Catalogs', 'Universal bike-industry catalog translator (QBP, JBI, Specialized & custom CSV/TSV feeds up to 40,000+ SKUs). Vendor quantities power Special Order availability — never mixed with UBC physical stock.'),
    vendorCatalogTabs('catalogs'),
    h('div.grid.grid-3', sup.suppliers.map((s) => {
      const hs = HEALTH[s.health && s.health.status] || ['Unknown', ''];
      return h('section.card', h('div.integration',
        h('div.head', h('div.logo', { style: { background: s.code === 'QBP' ? '#0e7490' : s.code === 'JBI' ? '#7c2d12' : '#991b1b' } }, s.code.slice(0, 3)),
          h('div', h('h3', s.name), h('span.badge', { class: hs[1] }, hs[0]))),
        h('dl.props', h('dt', 'Catalog Items'), h('dd', s.offers.toLocaleString('en-US')), h('dt', 'Unmatched'), h('dd', s.unmatched.toLocaleString('en-US')),
          h('dt', 'Last Sync'), h('dd', ago(s.last_report)), h('dt', 'Methods'), h('dd', (s.methods || []).join(', '))),
        h('p.small.muted', s.notes),
        h('div.row',
          h('button.btn.sm', { onclick: () => showOffers(s.code, false) }, 'Browse catalog'),
          h('button.btn.sm', { onclick: () => showOffers(s.code, true) }, 'Unmatched'),
          ctx.can('catalog.write') ? h('button.btn.sm', { onclick: () => openImport(ctx, s.code) }, 'Import CSV/TSV') : null,
          ctx.can('catalog.write') && s.unmatched > 0 ? h('button.btn.sm.primary', {
            onclick: async () => {
              const ok = await confirmDialog({
                title: 'Promote Unmatched ' + s.code + ' Items to Store Catalog',
                message: 'Create canonical UBC store products (Draft, MAP & margin guarded) for ' + s.unmatched.toLocaleString('en-US') + ' unmatched ' + s.code + ' offers and stage them for Shopify?',
                confirmLabel: 'Promote to Catalog',
              });
              if (!ok) return;
              try {
                const res = await ctx.api.promoteSupplierOffers(s.code, { publishStatus: 'draft', onlyInStock: false });
                if (res && res.jobId) await watchJob(ctx.api, res.jobId);
                toast('Promoted unmatched ' + s.code + ' items to store catalog.', 'ok');
                ctx.navigate('#/suppliers?r=' + Date.now());
              } catch (err) { toast(err.message || String(err), 'bad'); }
            },
          }, 'Promote Unmatched') : null)));
    })),
    reviewHost,
    offersHost);
}

function openImport(ctx, code) {
  const file = h('input', { type: 'file', accept: '.csv,.tsv,.txt,text/csv,text/tab-separated-values' });
  const mapHost = h('div');
  const status = h('div');
  let text = '';
  const fields = [
    ['supplierSku', 'Supplier SKU / Part # *'],
    ['brand', 'Brand' + (code === 'SPECIALIZED' ? ' (optional)' : ' *')],
    ['title', 'Item Description *'],
    ['upc', 'UPC / EAN / GTIN'],
    ['mpn', 'Manufacturer Part #'],
    ['category', 'Category / Dept'],
    ['cost', 'Dealer Cost'],
    ['map', 'MAP / UMAP'],
    ['msrp', 'MSRP / Retail'],
    ['qty', 'Qty Available'],
    ['dropShip', 'Drop-ship Flag'],
    ['leadDays', 'Lead Days'],
    ['size', 'Size / Frame'],
    ['color', 'Color / Finish'],
    ['matrixRef', 'Parent Matrix / Model'],
    ['imageUrl', 'Image URL'],
  ];
  const selects = {};
  const licensed = h('input', { type: 'checkbox' });
  const autoPromote = h('input', { type: 'checkbox' });

  file.addEventListener('change', () => {
    const f = file.files && file.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      text = String(reader.result || '');
      const sep = detectHeaderDelimiter(text);
      const sepName = sep === '\t' ? 'TAB-delimited (TSV)' : sep === ';' ? 'Semicolon (;)' : sep === '|' ? 'Pipe (|)' : 'Comma (CSV)';
      const header = parseCsvHeader(text);
      const inferred = inferFeedMapping(header);
      mount(mapHost,
        h('div.notice.info', 'Detected format: ' + sepName + ' · ' + header.length + ' columns auto-translated for ' + code + '.'),
        h('div.form-grid', fields.map(([k, label]) => {
          const guess = inferred[k] || '';
          selects[k] = h('select', [h('option', { value: '' }, '— not in file —')].concat(header.map((c) => h('option', { value: c, selected: c === guess }, c))));
          return h('label.field', label, selects[k]);
        })),
        h('label.check', licensed, 'Our dealer agreement allows republishing this supplier’s descriptions & images'),
        h('label.check', autoPromote, 'Automatically promote unmatched items as Draft store products (staged for Shopify)'));
    };
    reader.readAsText(f);
  });

  const go = h('button.btn.primary', {
    onclick: async () => {
      if (!text) { mount(status, h('div.notice.warn', 'Choose a CSV or TSV file first.')); return; }
      const mapping = {};
      Object.keys(selects).forEach((k) => { if (selects[k].value) mapping[k] = selects[k].value; });
      if (!mapping.supplierSku || !mapping.title || (!mapping.brand && code !== 'SPECIALIZED')) {
        mount(status, h('div.notice.warn', 'Map at least Supplier SKU, Brand and Description.'));
        return;
      }
      go.disabled = true;
      const pb = progressBar();
      const lbl = h('span.small.muted');
      mount(status, h('div.stack', pb.el, lbl));
      try {
        const split = splitCsvChunks(text, 2500);
        if (split.chunks.length > 1) {
          const totals = { upserted: 0, autoMatched: 0, review: 0, unmatched: 0, rowErrorCount: 0, promoted: 0 };
          for (let idx = 0; idx < split.chunks.length; idx++) {
            const pctDone = Math.round(((idx) / split.chunks.length) * 100);
            pb.bar.style.width = pctDone + '%';
            lbl.textContent = 'Streaming batch ' + (idx + 1) + ' of ' + split.chunks.length + ' (' + split.totalDataRows.toLocaleString('en-US') + ' total SKUs)…';
            const part = await ctx.api.importFeedChunk(code, {
              csv: split.chunks[idx],
              mapping,
              contentLicensed: licensed.checked,
              chunkIndex: idx,
              totalChunks: split.chunks.length,
              autoPromoteNew: autoPromote.checked,
            });
            totals.upserted += part.upserted || 0;
            totals.autoMatched += part.autoMatched || 0;
            totals.review += part.review || 0;
            totals.unmatched += part.unmatched || 0;
            totals.rowErrorCount += part.rowErrorCount || 0;
            if (part.promoted && part.promoted.variantsPromoted) totals.promoted += part.promoted.variantsPromoted;
          }
          pb.bar.style.width = '100%';
          mount(status, h('div.notice.ok',
            'Imported ' + totals.upserted.toLocaleString('en-US') + ' records across ' + split.chunks.length + ' batches: ' +
            totals.autoMatched.toLocaleString('en-US') + ' auto-matched (GTIN), ' +
            totals.review.toLocaleString('en-US') + ' sent to review, ' +
            totals.unmatched.toLocaleString('en-US') + ' unmatched' +
            (totals.promoted ? ' (' + totals.promoted.toLocaleString('en-US') + ' promoted to store catalog)' : '') +
            (totals.rowErrorCount ? ', ' + totals.rowErrorCount + ' rows skipped' : '') + '.'));
        } else {
          const r = await ctx.api.importFeed(code, {
            csv: text,
            mapping,
            contentLicensed: licensed.checked,
            autoPromoteNew: autoPromote.checked,
          });
          const job = await watchJob(ctx.api, r.jobId, pb.bar, lbl);
          if (job.status !== 'succeeded') throw new Error(job.last_error || 'Import failed');
          const s = job.result;
          mount(status, h('div.notice.ok',
            'Imported ' + s.upserted.toLocaleString('en-US') + ' records: ' +
            s.autoMatched.toLocaleString('en-US') + ' auto-matched (GTIN), ' +
            s.review.toLocaleString('en-US') + ' sent to review, ' +
            s.unmatched.toLocaleString('en-US') + ' new/unmatched' +
            (s.promoted && s.promoted.variantsPromoted ? ' (' + s.promoted.variantsPromoted.toLocaleString('en-US') + ' promoted to store catalog)' : '') +
            (s.rowErrorCount ? ', ' + s.rowErrorCount + ' rows rejected' : '') + '.'));
        }
        go.disabled = false;
      } catch (e) { mount(status, h('div.notice.bad', e.message)); go.disabled = false; }
    },
  }, 'Import Catalog');

  const m = modal({
    title: 'Import ' + code + ' catalog feed (CSV / TSV / Pipe / Semicolon)', wide: true,
    body: [
      h('p.small.muted', 'Automatically translates QBP, JBI, Specialized or custom feeds up to 40,000+ SKUs. Large files stream automatically in 2,500-row batches; MAP & margin floors are enforced before Shopify.'),
      h('label.field', 'Catalog file (.csv, .tsv, .txt)', file),
      mapHost,
      status,
    ],
    actions: [h('button.btn', { onclick: () => { m.close(); ctx.navigate('#/suppliers?r=' + Date.now()); } }, 'Close'), go],
  });
}
