import { h, mount } from '../ui/dom.js';
import { modal, pageHead, toast } from '../ui/components.js';
import { availabilityBadge, margin, money, pct, REASON_LABELS } from '../ui/format.js';
import { catalogTable, itemSearchTabs, renderItemPriceCell, sessionStorageSafeSet } from './products.js?v=90';
import { dollarsToCents } from './common.js?v=90';

/** Single-item price editor. Shows margin/MAP impact live; the server enforces the rules. */
export function openPriceEditor(ctx, item, onSaved) {
  const input = h('input', { type: 'number', inputmode: 'decimal', step: '0.01', min: '0.01', value: (item.priceCents / 100).toFixed(2), 'aria-label': 'New price in dollars' });
  const impact = h('div');
  const err = h('div');
  const update = () => {
    const cents = dollarsToCents(input.value);
    const m = cents ? margin(cents, item.costCents) : null;
    const notes = [];
    if (cents && item.mapPolicy !== 'none' && item.mapCents && cents < item.mapCents) notes.push(h('div.notice.bad', 'Below MAP (' + money(item.mapCents) + '). This will be rejected unless an authorised MAP exception exists.'));
    if (cents && item.costCents !== null && cents < item.costCents) notes.push(h('div.notice.bad', 'Below cost.'));
    if (item.costCents === null) notes.push(h('div.notice.warn', 'No cost on file — margin cannot be verified.'));
    mount(impact, h('dl.props',
      h('dt', 'Current'), h('dd', money(item.priceCents) + ' · margin ' + pct(margin(item.priceCents, item.costCents))),
      h('dt', 'New'), h('dd', h('strong', cents ? money(cents) : '—'), ' · margin ', h('strong', pct(m))),
      h('dt', 'Cost'), h('dd', money(item.costCents)),
      h('dt', 'MAP'), h('dd', item.mapPolicy === 'none' ? 'none' : money(item.mapCents))), notes);
  };
  input.addEventListener('input', update);
  update();
  const save = h('button.btn.primary', {
    onclick: async () => {
      const cents = dollarsToCents(input.value);
      if (!cents) return;
      save.disabled = true;
      mount(err);
      try {
        const r = await ctx.api.setPrice(item.id, cents, item.version);
        m.close();
        toast('Price updated' + (r.warnings && r.warnings.length ? ' (' + r.warnings.map((w) => REASON_LABELS[w] || w).join(', ') + ')' : ''), 'ok');
        onSaved();
      } catch (e) {
        save.disabled = false;
        const reasons = e.details && e.details.reasons ? ': ' + e.details.reasons.map((x) => REASON_LABELS[x] || x).join(', ') : '';
        mount(err, h('div.notice.bad', e.message + reasons));
      }
    },
  }, 'Save price');
  const m = modal({ title: 'Change price — ' + item.sku, body: [h('p.small.muted', item.title), h('label.field', 'New price ($)', input), impact, err], actions: [h('button.btn', { onclick: () => m.close() }, 'Cancel'), save] });
}

export async function renderPricing(ctx) {
  const table = await catalogTable(ctx, {
    memoryKey: 'pricing',
    sort: { key: 'margin', dir: 'asc' },
    columns: (c, reload) => [
      { key: 'title', label: 'Item', sortable: true, cls: 'title-cell', render: (r) => h('div', h('a', { href: '#/products/' + r.id }, r.title), h('div.sku', r.sku)) },
      { key: 'price', label: 'Price / Sale', num: true, sortable: true, render: renderItemPriceCell },
      { key: 'cost', label: 'Cost', num: true, opt: true, render: (r) => (r.costCents === null ? h('span.badge.warn', 'none') : money(r.costCents)) },
      { key: 'margin', label: 'Margin', num: true, sortable: true, render: (r) => {
        const m = margin(r.priceCents, r.costCents);
        return h('span', { class: m !== null && m < 0.15 ? 'badge bad' : m !== null && m < 0.25 ? 'badge warn' : '' }, pct(m));
      } },
      { key: 'map', label: 'MAP Floor', num: true, opt: true, render: (r) => (r.mapPolicy === 'none' ? h('span.muted', '—') : money(r.mapCents)) },
      { key: 'avail', label: 'Stock / Vendor', opt: true, render: (r) => availabilityBadge(r.availability) },
      { key: 'edit', label: '', render: (r) => (c.can('pricing.write') ? h('button.btn.sm', { onclick: () => openPriceEditor(c, r, reload) }, 'Edit') : null) },
    ],
    bulkActions: ctx.can('pricing.write') ? ({ filter }) => [
      h('button.btn.sm.primary', { onclick: () => { sessionStorageSafeSet('ubc-promo-selection', JSON.stringify(filter)); ctx.navigate('#/promotions/new?from=selection'); } }, 'Bulk price rule…'),
    ] : null,
  });
  return h('div.stack',
    pageHead('Item Search · Margins & MAP', 'Sorted by lowest margin first. Bulk price adjustments run through Promotions / Price Rules so MAP and margin floors always apply.',
      ctx.can('pricing.write') ? [h('a.btn.primary', { href: '#/promotions/new' }, 'New Price Rule / Promo')] : []),
    itemSearchTabs('margins'),
    table.el);
}
