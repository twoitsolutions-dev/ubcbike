import { h } from '../ui/dom.js';
import { card, dataTable, pageHead } from '../ui/components.js';
import { availabilityBadge, ago } from '../ui/format.js';
import { catalogTable } from './products.js';

export async function renderInventory(ctx) {
  const loc = await ctx.api.locations();
  const table = await catalogTable(ctx, {
    memoryKey: 'inventory',
    sort: { key: 'stock', dir: 'desc' },
    hideStatus: true,
    columns: () => [
      { key: 'title', label: 'Product', sortable: true, cls: 'title-cell', render: (r) => h('div', h('a', { href: '#/products/' + r.id }, r.title), h('div.sku', r.sku)) },
      { key: 'stock', label: 'On hand (UBC)', num: true, sortable: true, render: (r) => String(r.physicalQty) },
      { key: 'reserved', label: 'Reserved', num: true, render: (r) => String(r.reservedQty) },
      { key: 'sellable', label: 'Sellable', num: true, render: (r) => h('strong', String(r.availability.sellablePhysical)) },
      { key: 'supplier', label: 'Supplier-reported (not UBC stock)', num: true, opt: true, render: (r) => {
        if (!r.offers.length) return h('span.muted', '—');
        return h('span', r.offers.map((o) => o.supplierCode + ' ' + o.qtyAvailable).join(' · '));
      } },
      { key: 'fresh', label: 'Supplier data', opt: true, render: (r) => (r.offers.length ? (r.availability.staleOffers.length ? h('span.badge.bad', r.availability.staleOffers.length + ' stale') : ago(r.offers[0].reportedAt)) : '—') },
      { key: 'avail', label: 'Online availability', render: (r) => availabilityBadge(r.availability) },
    ],
  });
  return h('div.stack',
    pageHead('Inventory', 'Physical stock owned by UBC is tracked per location. Supplier quantities are shown separately and are never added to UBC stock.'),
    card('Physical locations', dataTable({
      columns: [
        { key: 'name', label: 'Location' },
        { key: 'kind', label: 'Type', render: (r) => h('span.badge.ok', r.kind) },
        { key: 'skus', label: 'SKUs stocked', num: true },
        { key: 'on_hand', label: 'Units on hand', num: true },
        { key: 'reserved', label: 'Reserved', num: true },
      ],
      rows: loc.locations,
    }), { flush: true }),
    h('div.notice.info', 'Source of truth for physical stock: Lightspeed Retail R-Series (once authorised). Until then these figures are demonstration data.'),
    table.el);
}
