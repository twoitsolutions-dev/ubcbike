import type { CatalogItem, ItemFilter } from '@ubc/shared';
import { computeAvailability, type AvailabilitySettings, DEFAULT_AVAILABILITY } from './availability.js';
import { marginPct } from './pricing.js';

export type SortKey = 'title' | 'brand' | 'price' | 'margin' | 'stock' | 'updated';

/** In-memory filter used by the browser demo and by tests. The API applies the same semantics in SQL. */
export function matchesFilter(
  item: CatalogItem,
  f: ItemFilter,
  settings: AvailabilitySettings = DEFAULT_AVAILABILITY,
  now: Date = new Date(),
): boolean {
  if (f.ids && f.ids.length && !f.ids.includes(item.id)) return false;
  if (f.excludeIds && f.excludeIds.length && f.excludeIds.includes(item.id)) return false;
  if (f.status && f.status !== 'any' && item.status !== f.status) return false;
  if (f.categories?.length && !f.categories.includes(item.category)) return false;
  if (f.brands?.length && !f.brands.includes(item.brand)) return false;
  if (f.suppliers?.length && !item.offers.some((o) => f.suppliers!.includes(o.supplierCode))) return false;
  if (f.priceMinCents !== undefined && item.priceCents < f.priceMinCents) return false;
  if (f.priceMaxCents !== undefined && item.priceCents > f.priceMaxCents) return false;
  if (f.marginMinPct !== undefined || f.marginMaxPct !== undefined) {
    const m = marginPct(item.priceCents, item.costCents);
    if (m === null) return false;
    if (f.marginMinPct !== undefined && m < f.marginMinPct) return false;
    if (f.marginMaxPct !== undefined && m > f.marginMaxPct) return false;
  }
  if (f.stock && f.stock !== 'any') {
    const av = computeAvailability(item, settings, now).status;
    if (f.stock === 'physical' && av !== 'in_stock') return false;
    if (f.stock === 'virtual_only' && av !== 'special_order') return false;
    if (f.stock === 'unavailable' && av !== 'unavailable') return false;
  }
  if (f.q) {
    const q = f.q.trim().toLowerCase();
    if (q) {
      const hay = `${item.title} ${item.brand} ${item.sku} ${item.upc ?? ''} ${item.mpn ?? ''}`.toLowerCase();
      if (!q.split(/\s+/).every((t) => hay.includes(t))) return false;
    }
  }
  return true;
}

export function sortItems(items: CatalogItem[], key: SortKey, dir: 'asc' | 'desc'): CatalogItem[] {
  const m = dir === 'asc' ? 1 : -1;
  const val = (i: CatalogItem): number | string => {
    switch (key) {
      case 'title': return i.title.toLowerCase();
      case 'brand': return i.brand.toLowerCase();
      case 'price': return i.priceCents;
      case 'margin': return marginPct(i.priceCents, i.costCents) ?? -1;
      case 'stock': return i.physicalQty - i.reservedQty;
      case 'updated': return i.updatedAt;
    }
  };
  return items.sort((a, b) => {
    const va = val(a);
    const vb = val(b);
    return va < vb ? -m : va > vb ? m : 0;
  });
}
