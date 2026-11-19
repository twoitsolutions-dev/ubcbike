import { h, mount } from '../ui/dom.js';
import { card, dataTable, errorBox, loading, pageHead, toast } from '../ui/components.js';
import { dateTime, money } from '../ui/format.js';

const KIND = {
  add: ['Matched', 'ok', 'Lightspeed item matched to a Shopify variant by UPC.'],
  repoint: ['Updated', 'warn', 'Shopify variant re-linked to the Lightspeed item with matching UPC.'],
  remove: ['Unmatched', 'bad', 'The UPC no longer matches or the Shopify variant is gone.'],
};

function priceCell(cents, compareCents) {
  if (cents === null || cents === undefined) return '—';
  return h('span', money(cents), compareCents && compareCents > cents ? h('span.muted', { style: { textDecoration: 'line-through', marginLeft: '6px' } }, money(compareCents)) : null);
}

/**
 * UPC Matches (view & filter only): all Lightspeed ↔ Shopify UPC matches are auto-approved.
 */
export async function renderUpcReview(ctx) {
  const canWrite = ctx.can('catalog.write');
  let status = ctx.query.status || 'approved';
  let kind = ctx.query.kind || '';
  let search = '';
  const host = h('div', loading('Loading UPC matches…'));
  const tabsHost = h('div.row');
  const searchInput = h('input.input', {
    type: 'search',
    placeholder: 'Filter by title, UPC, SKU or barcode…',
    style: { maxWidth: '340px' },
    oninput: (e) => {
      search = String(e.target.value || '').trim().toLowerCase();
      renderTable();
    },
  });

  let currentRows = [];

  const renderTable = () => {
    const filtered = search
      ? currentRows.filter((p) => {
        const hay = [p.ls_title, p.ls_upc, p.ls_sku, p.ls_item_id, p.shopify_title, p.shopify_barcode].filter(Boolean).join(' ').toLowerCase();
        return hay.includes(search);
      })
      : currentRows;

    const table = dataTable({
      columns: [
        { key: 'kind', label: 'Type', render: (p) => h('span.badge', { class: KIND[p.kind][1], title: KIND[p.kind][2] }, KIND[p.kind][0]) },
        { key: 'ls', label: 'Lightspeed item', cls: 'title-cell', render: (p) => h('div',
          h('strong', p.ls_title || '—'),
          h('div.sku', 'UPC ' + (p.ls_upc || '—') + (p.ls_item_id ? ' · LS #' + p.ls_item_id : '') + ' · stock ' + (p.ls_qty || 0))) },
        { key: 'sh', label: 'Shopify variant', cls: 'title-cell', render: (p) => h('div', h('div', p.shopify_title || '—'), h('div.sku', 'Barcode ' + (p.shopify_barcode || '—'))) },
        { key: 'now', label: 'Shopify now', num: true, opt: true, render: (p) => priceCell(p.shopify_price_cents, p.shopify_compare_at_cents) },
        { key: 'ls$', label: 'Lightspeed price', num: true, render: (p) => (p.kind === 'remove' ? '—' : priceCell(p.ls_price_cents, p.ls_compare_at_cents)) },
        { key: 'who', label: 'Matched', opt: true, render: (p) => (p.decided_at ? dateTime(p.decided_at) : (p.note || '—')) },
      ],
      rows: filtered,
      empty: search ? 'No matches match "' + search + '".' : 'No matches in this list.',
    });

    mount(host,
      card(null, table, { flush: true }),
      currentRows.length >= 1000 ? h('p.muted', 'Showing the first 1,000 matches. Use the search box to filter.') : null);
  };

  const draw = async () => {
    let data;
    try {
      data = await ctx.api.upcReview(status, kind || undefined);
    } catch (e) { mount(host, errorBox(e)); return; }
    if (!ctx.isCurrent()) return;
    const count = (st, k) => data.counts.filter((c) => c.status === st && (!k || c.kind === k)).reduce((n, c) => n + c.n, 0);

    mount(tabsHost,
      [['approved', 'Approved'], ['pending', 'Pending'], ['rejected', 'Rejected'], ['unlinked', 'Unlinked']].map(([k, label]) =>
        h('button.btn', { class: status === k ? 'primary' : '', onclick: () => { status = k; kind = ''; draw(); } }, label + ' (' + count(k) + ')')),
      h('span', { style: { width: '12px' } }),
      [['', 'All'], ['add', 'Matched'], ['repoint', 'Updated'], ['remove', 'Unmatched']].map(([k, label]) =>
        h('button.btn.sm', { class: kind === k ? 'primary' : '', onclick: () => { kind = k; draw(); } }, label + (k ? ' (' + count(status, k) + ')' : ''))));

    currentRows = data.proposals || [];
    renderTable();
  };

  draw();
  return h('div.stack',
    pageHead('UPC Matches (Lightspeed ↔ Shopify)',
      'All Lightspeed ↔ Shopify UPC matches are approved automatically. Use this view to search and filter matched items.',
      canWrite ? [
        h('button.btn', { onclick: async () => {
          try { await ctx.api.runUpcMatch(); toast('Matching started — refresh in about a minute'); } catch (e) { toast(e.message, 'bad'); }
        } }, 'Find matches now'),
      ] : []),
    h('div.row', { style: { justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' } },
      tabsHost,
      searchInput),
    host);
}
