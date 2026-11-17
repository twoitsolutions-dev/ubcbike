import { h, mount } from '../ui/dom.js';
import { card, confirmDialog, dataTable, errorBox, loading, pageHead, toast } from '../ui/components.js';
import { dateTime, money } from '../ui/format.js';

const KIND = {
  add: ['New match', 'ok', 'Lightspeed item found in Shopify with the same UPC. Approving sends its Lightspeed price, sale price and stock to that Shopify variant.'],
  repoint: ['Changed match', 'warn', 'This Shopify variant is linked to one Lightspeed item, but its UPC now belongs to a different one.'],
  remove: ['No longer matches', 'bad', 'The UPC no longer matches (or the Shopify variant is gone). Approving stops syncing it; Shopify keeps its current price.'],
};

function priceCell(cents, compareCents) {
  if (cents === null || cents === undefined) return '—';
  return h('span', money(cents), compareCents && compareCents > cents ? h('span.muted', { style: { textDecoration: 'line-through', marginLeft: '6px' } }, money(compareCents)) : null);
}

/**
 * UPC Matches: the nightly job only PROPOSES Lightspeed ↔ Shopify matches by UPC.
 * Nothing changes in Shopify until Carlos approves them here.
 */
export async function renderUpcReview(ctx) {
  const canWrite = ctx.can('catalog.write');
  let status = ctx.query.status || 'pending';
  let kind = ctx.query.kind || '';
  const selected = new Set();
  const host = h('div', loading('Loading UPC matches…'));
  const tabsHost = h('div.row');
  const actionsHost = h('div.row');

  const draw = async () => {
    selected.clear();
    let data;
    try {
      data = await ctx.api.upcReview(status, kind || undefined);
    } catch (e) { mount(host, errorBox(e)); return; }
    if (!ctx.isCurrent()) return;
    const count = (st, k) => data.counts.filter((c) => c.status === st && (!k || c.kind === k)).reduce((n, c) => n + c.n, 0);

    mount(tabsHost,
      [['pending', 'To review'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['unlinked', 'Unlinked']].map(([k, label]) =>
        h('button.btn', { class: status === k ? 'primary' : '', onclick: () => { status = k; kind = ''; draw(); } }, label + ' (' + count(k) + ')')),
      h('span', { style: { width: '12px' } }),
      [['', 'All'], ['add', 'New matches'], ['repoint', 'Changed'], ['remove', 'No longer match']].map(([k, label]) =>
        h('button.btn.sm', { class: kind === k ? 'primary' : '', onclick: () => { kind = k; draw(); } }, label + (k ? ' (' + count(status, k) + ')' : ''))));

    const act = async (decision) => {
      const ids = Array.from(selected);
      if (!ids.length) { toast('Select at least one row', 'bad'); return; }
      const words = { approve: ['Approve', 'The selected matches start syncing price, sale price and stock from Lightspeed to Shopify within seconds.'],
        reject: ['Reject', 'The selected matches are discarded and will not be proposed again.'],
        unlink: ['Unlink', 'The selected items stop syncing from Lightspeed. Shopify keeps its current price until Workstand changes it.'] }[decision];
      const ok = await confirmDialog({ title: words[0] + ' ' + ids.length + ' match' + (ids.length === 1 ? '' : 'es') + '?', message: words[1], confirmLabel: words[0], danger: decision !== 'approve' });
      if (!ok) return;
      try {
        const r = await ctx.api.decideUpc(ids, decision);
        toast(words[0] + 'd ' + r.updated);
        ctx.refreshBadges();
        draw();
      } catch (e) { toast(e.message, 'bad'); }
    };
    mount(actionsHost,
      canWrite && status === 'pending' ? [
        h('button.btn.primary', { onclick: () => act('approve') }, 'Approve selected'),
        h('button.btn', { onclick: () => act('reject') }, 'Reject selected'),
      ] : null,
      canWrite && status === 'approved' ? h('button.btn', { onclick: () => act('unlink') }, 'Unlink selected') : null);

    const rows = data.proposals;
    const table = () => dataTable({
      selectable: canWrite && (status === 'pending' || status === 'approved'),
      selected,
      rowKey: (p) => p.id,
      onToggle: (id, on) => { if (on) selected.add(id); else selected.delete(id); },
      onToggleAll: (ids, on) => { ids.forEach((id) => { if (on) selected.add(id); else selected.delete(id); }); mount(tableHost, table()); },
      columns: [
        { key: 'kind', label: 'Type', render: (p) => h('span.badge', { class: KIND[p.kind][1], title: KIND[p.kind][2] }, KIND[p.kind][0]) },
        { key: 'ls', label: 'Lightspeed item', cls: 'title-cell', render: (p) => h('div',
          h('strong', p.ls_title || '—'),
          h('div.sku', 'UPC ' + (p.ls_upc || '—') + (p.ls_item_id ? ' · LS #' + p.ls_item_id : '') + ' · stock ' + (p.ls_qty || 0)),
          p.kind === 'repoint' ? h('div.sku', 'Currently linked to: ' + (p.old_ls_title || '—') + ' (UPC ' + (p.old_ls_upc || '—') + ')') : null) },
        { key: 'sh', label: 'Shopify variant', cls: 'title-cell', render: (p) => h('div', h('div', p.shopify_title || '—'), h('div.sku', 'Barcode ' + (p.shopify_barcode || '—'))) },
        { key: 'now', label: 'Shopify now', num: true, opt: true, render: (p) => priceCell(p.shopify_price_cents, p.shopify_compare_at_cents) },
        { key: 'ls$', label: 'Lightspeed price', num: true, render: (p) => (p.kind === 'remove' ? '—' : priceCell(p.ls_price_cents, p.ls_compare_at_cents)) },
        status === 'pending' ? null : { key: 'who', label: 'Decided', opt: true, render: (p) => (p.decided_at ? dateTime(p.decided_at) + (p.decided_by ? ' · ' + p.decided_by : '') : (p.note || '—')) },
      ].filter(Boolean),
      rows,
      empty: status === 'pending' ? 'Nothing to review. New matches appear here every night.' : 'No matches in this list.',
    });
    const tableHost = h('div', table());
    mount(host, card(null, tableHost, { flush: true }), rows.length >= 1000 ? h('p.muted', 'Showing the first 1,000. Approve or reject these to see the rest.') : null);
  };

  draw();
  return h('div.stack',
    pageHead('UPC Matches (Lightspeed ↔ Shopify)',
      'Every night the Hub looks for Lightspeed items whose UPC matches a variant in the Shopify store. Nothing changes in Shopify until you approve a match here.',
      canWrite ? [h('button.btn', { onclick: async () => {
        try { await ctx.api.runUpcMatch(); toast('Matching started — refresh in about a minute'); } catch (e) { toast(e.message, 'bad'); }
      } }, 'Find matches now')] : null),
    tabsHost,
    actionsHost,
    host);
}
