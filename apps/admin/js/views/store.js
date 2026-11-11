import { h, mount, clear, debounce } from '../ui/dom.js';
import { card, loading, pageHead, toast } from '../ui/components.js';
import { availabilityBadge, money } from '../ui/format.js';

/**
 * Simulated storefront to demonstrate the end-to-end flow (cart → checkout →
 * order → special order). The real public store is the Shopify theme in
 * apps/shopify-theme; checkout and payments always stay in Shopify.
 */
export async function renderStore(ctx) {
  const st = { q: '', category: '', cart: [], offset: 0 };
  const grid = h('div', loading());
  const cartHost = h('div');
  const facets = await ctx.api.facets();

  const load = async () => {
    const r = await ctx.api.items({ status: 'published', q: st.q || undefined, categories: st.category || undefined, limit: 24, offset: st.offset, sort: 'title' });
    if (!ctx.isCurrent()) return;
    mount(grid, h('div.store-grid', r.items.map((it) => {
      const av = it.availability;
      const canBuy = av.status !== 'unavailable';
      return h('div.product-card',
        h('div.ph', 'Demo image placeholder', h('br'), it.brand),
        h('div.name', it.title),
        h('div.price', money(it.priceCents)),
        availabilityBadge(av),
        h('div.small.muted', av.status === 'in_stock' ? 'Pick up today at UBC or ship' : av.status === 'special_order' ? 'Ordered from distributor · ready in ~' + av.estimatedLeadDays + ' days' : 'Currently unavailable'),
        h('button.btn', { class: canBuy ? 'primary' : '', disabled: !canBuy, onclick: () => add(it) }, canBuy ? 'Add to cart' : 'Unavailable'));
    })), r.items.length ? null : h('div.empty', 'No products found.'),
    h('div.pager', h('span', r.total + ' products'), h('span.spacer'),
      h('button.btn.sm', { disabled: st.offset === 0, onclick: () => { st.offset = Math.max(0, st.offset - 24); load(); } }, '‹ Prev'),
      h('button.btn.sm', { disabled: st.offset + 24 >= r.total, onclick: () => { st.offset += 24; load(); } }, 'Next ›')));
  };

  const add = (it) => {
    const line = st.cart.find((l) => l.item.id === it.id);
    if (line) line.qty += 1; else st.cart.push({ item: it, qty: 1 });
    toast('Added: ' + it.title);
    drawCart();
  };

  const name = h('input', { type: 'text', value: 'Jane', maxlength: '60', 'aria-label': 'Customer first name' });
  const method = h('select', [h('option', { value: 'pickup' }, 'Pickup at UBC'), h('option', { value: 'ship' }, 'Ship to my address')]);
  const drawCart = () => {
    const total = st.cart.reduce((s, l) => s + l.item.priceCents * l.qty, 0);
    mount(cartHost, card('Cart (' + st.cart.reduce((s, l) => s + l.qty, 0) + ')', st.cart.length ? h('div',
      st.cart.map((l) => h('div.cart-line',
        h('div.t', h('div', l.item.title), h('div.small.muted', money(l.item.priceCents) + ' · ' + (l.item.availability.status === 'special_order' ? 'special order' : 'in stock'))),
        h('input', { type: 'number', min: '1', max: '20', value: String(l.qty), style: { width: '64px' }, 'aria-label': 'Quantity', onchange: (e) => { l.qty = Math.max(1, Math.min(20, Number(e.target.value) || 1)); drawCart(); } }),
        h('button.btn.sm.ghost', { 'aria-label': 'Remove', onclick: () => { st.cart = st.cart.filter((x) => x !== l); drawCart(); } }, '✕'))),
      h('div.row', { style: { justifyContent: 'space-between', margin: '12px 0' } }, h('strong', 'Total'), h('strong', money(total))),
      h('div.form-grid', h('label.field', 'Customer name', name), h('label.field', 'Delivery', method)),
      h('div.notice.info', { style: { margin: '12px 0' } }, 'Simulated checkout. In production the customer pays in Shopify Checkout and Shopify sends an orders/create webhook to the Integration Engine.'),
      h('button.btn.primary', { style: { width: '100%' }, onclick: checkout }, 'Complete demo purchase'))
      : h('p.muted', 'Your cart is empty.')));
  };

  const checkout = async () => {
    if (!st.cart.length) return;
    try {
      const r = await ctx.api.checkout({ lines: st.cart.map((l) => ({ itemId: l.item.id, qty: l.qty })), method: method.value, customerName: name.value.trim() || 'Customer' });
      st.cart = [];
      drawCart();
      toast('Order ' + r.orderNumber + ' placed', 'ok');
      setTimeout(async () => {
        const list = await ctx.api.orders({ q: r.orderNumber });
        if (list.orders[0]) ctx.navigate('#/orders/' + list.orders[0].id);
        else ctx.navigate('#/orders');
      }, 1500);
    } catch (e) { toast(e.message, 'bad'); }
  };

  const search = h('input', { type: 'search', placeholder: 'Search the store', oninput: debounce((e) => { st.q = e.target.value; st.offset = 0; load(); }, 250) });
  const cat = h('select', { onchange: (e) => { st.category = e.target.value; st.offset = 0; load(); } },
    [h('option', { value: '' }, 'All categories')].concat(facets.categories.map((c) => h('option', { value: c.value }, c.value))));
  drawCart();
  load();
  if (!ctx.can('orders.write')) clear(cartHost);
  return h('div.stack',
    pageHead('Store (simulated)', 'Customer view of availability: UBC stock vs. special order. The real storefront is the Shopify theme.'),
    h('div.grid', { style: { gridTemplateColumns: 'minmax(0, 1fr)' } },
      h('section.card', h('div.filters', h('label.field.grow', 'Search', search), h('label.field', 'Category', cat)), h('div.card-body', grid)),
      cartHost));
}
