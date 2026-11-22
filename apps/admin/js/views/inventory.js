import { h } from '../ui/dom.js';
import { card, dataTable, pageHead } from '../ui/components.js';
import { availabilityBadge, ago } from '../ui/format.js';
import { catalogTable, itemSearchTabs } from './products.js?v=78';

export async function renderInventory(ctx) {
  const loc = await ctx.api.locations();
  const table = await catalogTable(ctx, {
    memoryKey: 'inventory',
    sort: { key: 'stock', dir: 'desc' },
    hideStatus: true,
    columns: () => [
      { key: 'title', label: 'Item', sortable: true, cls: 'title-cell', render: (r) => h('div', h('a', { href: '#/products/' + r.id }, r.title), h('div.sku', r.sku)) },
      { key: 'stock', label: 'In-Store (UBC)', num: true, sortable: true, render: (r) => String(r.physicalQty) },
      { key: 'reserved', label: 'Reserved', num: true, render: (r) => String(r.reservedQty) },
      { key: 'sellable', label: 'Sellable', num: true, render: (r) => h('strong', String(r.availability.sellablePhysical)) },
      { key: 'supplier', label: 'Vendor Catalog Qty (separate)', num: true, opt: true, render: (r) => {
        if (!r.offers.length) return h('span.muted', '—');
        return h('span', r.offers.map((o) => o.supplierCode + ' ' + o.qtyAvailable).join(' · '));
      } },
      { key: 'fresh', label: 'Feed Age', opt: true, render: (r) => (r.offers.length ? (r.availability.staleOffers.length ? h('span.badge.bad', r.availability.staleOffers.length + ' stale') : ago(r.offers[0].reportedAt)) : '—') },
      { key: 'avail', label: 'Web Availability', render: (r) => availabilityBadge(r.availability) },
    ],
  });
  return h('div.stack',
    pageHead('Item Search · In-Store Stock', 'Physical stock at UBC (Lightspeed R-Series) is tracked per shop location. Vendor Catalog quantities are shown separately and are never summed.'),
    itemSearchTabs('stock'),
    card('Shop Locations (Lightspeed R-Series)', dataTable({
      columns: [
        { key: 'name', label: 'Shop / Location' },
        { key: 'kind', label: 'Type', render: (r) => h('span.badge.ok', r.kind) },
        { key: 'skus', label: 'Items Stocked', num: true },
        { key: 'on_hand', label: 'Units On Hand', num: true },
        { key: 'reserved', label: 'Reserved', num: true },
      ],
      rows: loc.locations,
    }), { flush: true }),
    table.el);
}
