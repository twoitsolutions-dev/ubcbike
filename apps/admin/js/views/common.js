import { h, debounce } from '../ui/dom.js';
import { chips, searchableChips } from '../ui/components.js';

/** Convert dollars text → cents (or undefined). */
export function dollarsToCents(v) {
  if (v === '' || v === null || v === undefined) return undefined;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return isFinite(n) && n >= 0 ? Math.round(n * 100) : undefined;
}

/**
 * Combined filter bar: search, category/brand/supplier chips, price range,
 * margin range, stock and publication status. Calls onChange(filter).
 */
export function filterBar(facets, filter, onChange, opts) {
  const o = opts || {};
  const f = Object.assign({}, filter);
  const toggle = h('button.btn', { type: 'button', 'aria-expanded': o.expanded ? 'true' : 'false' }, 'More filters');

  const countExtra = () => {
    let n = 0;
    if (f.categories && f.categories.length) n++;
    if (f.brands && f.brands.length) n++;
    if (f.suppliers && f.suppliers.length) n++;
    if (f.priceMinCents !== undefined || f.priceMaxCents !== undefined) n++;
    if (f.marginMinPct !== undefined || f.marginMaxPct !== undefined) n++;
    toggle.textContent = n ? 'More filters (' + n + ')' : 'More filters';
  };

  const emit = () => { countExtra(); onChange(Object.assign({}, f)); };
  const emitSoon = debounce(emit, 250);

  const q = h('input', { type: 'search', placeholder: 'Item, Brand, SKU, UPC or Part #…', value: f.q || '', 'aria-label': 'Search', oninput: (e) => { f.q = e.target.value; emitSoon(); } });
  const sel = (label, key, options) => h('label.field', label, h('select', {
    onchange: (e) => { f[key] = e.target.value || undefined; emit(); },
  }, options.map(([v, t]) => h('option', { value: v, selected: (f[key] || '') === v }, t))));
  const num = (label, key, placeholder, toValue, fromValue) => h('label.field', label, h('input', {
    type: 'number', inputmode: 'decimal', min: '0', step: 'any', placeholder, value: f[key] === undefined ? '' : fromValue(f[key]),
    oninput: (e) => { f[key] = toValue(e.target.value); emitSoon(); },
  }));
  const pctIn = (v) => (v === '' ? undefined : Number(v) / 100);
  const pctOut = (v) => String(Math.round(v * 1000) / 10);
  const centsOut = (v) => String(v / 100);

  const more = h('div.filters', { hidden: !o.expanded },
    h('label.field.grow', 'Categories', searchableChips(facets.categories.map((c) => ({ value: c.value, n: c.n })), f.categories, (v) => { f.categories = v; emit(); }, { placeholder: 'Search categories…', limit: 16 })),
    h('label.field.grow', 'Brands', searchableChips(facets.brands.map((b) => ({ value: b.value, n: b.n })), f.brands, (v) => { f.brands = v; emit(); }, { placeholder: 'Search brands…', limit: 18 })),
    h('label.field.grow', 'Vendors', chips(facets.suppliers.map((s) => ({ value: s.value, label: s.value })), f.suppliers, (v) => { f.suppliers = v; emit(); })),
    num('Min price ($)', 'priceMinCents', '0', dollarsToCents, centsOut),
    num('Max price ($)', 'priceMaxCents', 'any', dollarsToCents, centsOut),
    num('Min margin (%)', 'marginMinPct', '0', pctIn, pctOut),
    num('Max margin (%)', 'marginMaxPct', '100', pctIn, pctOut));

  toggle.addEventListener('click', () => {
    more.hidden = !more.hidden;
    toggle.setAttribute('aria-expanded', more.hidden ? 'false' : 'true');
  });
  const reset = h('button.btn.ghost', { type: 'button', onclick: () => { Object.keys(f).forEach((k) => delete f[k]); countExtra(); onChange({}); } }, 'Clear');
  countExtra();

  return h('div',
    h('div.filters',
      h('label.field.grow', 'Item Search', q),
      sel('Availability', 'stock', [['', 'Any'], ['physical', 'In-Store Stock (UBC)'], ['virtual_only', 'Vendor Catalog Only (Special Order)'], ['unavailable', 'Out of Stock']]),
      o.hideStatus ? null : sel('Web Status', 'status', [['', 'Any'], ['published', 'Published'], ['hidden', 'Hidden'], ['draft', 'Draft']]),
      h('div.row', toggle, reset)),
    more);
}

export function filterToQuery(f) {
  return {
    q: f.q, categories: f.categories, brands: f.brands, suppliers: f.suppliers, stock: f.stock, status: f.status,
    priceMinCents: f.priceMinCents, priceMaxCents: f.priceMaxCents, marginMinPct: f.marginMinPct, marginMaxPct: f.marginMaxPct,
  };
}

/** Strip undefined/empty values so the API's strict schema accepts it. */
export function cleanFilter(f) {
  const out = {};
  Object.keys(f || {}).forEach((k) => {
    const v = f[k];
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) return;
    out[k] = v;
  });
  return out;
}

export function describeFilter(f) {
  const parts = [];
  if (f.q) parts.push('“' + f.q + '”');
  if (f.categories && f.categories.length) parts.push(f.categories.join(', '));
  if (f.brands && f.brands.length) parts.push(f.brands.length > 3 ? f.brands.length + ' brands' : f.brands.join(', '));
  if (f.suppliers && f.suppliers.length) parts.push('via ' + f.suppliers.join('/'));
  if (f.stock) parts.push({ physical: 'in stock', virtual_only: 'supplier-only', unavailable: 'unavailable' }[f.stock]);
  if (f.status) parts.push(f.status);
  if (f.ids) parts.push(f.ids.length + ' selected items');
  return parts.length ? parts.join(' · ') : 'All products';
}

/** Session-only memory for filters per page (no persistence needed). */
const memory = {};
export function remember(key, value) { if (value !== undefined) memory[key] = value; return memory[key]; }
