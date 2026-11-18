import { h, mount } from '../ui/dom.js';
import { modal, toast } from '../ui/components.js';
import { money } from '../ui/format.js';

/** Longest common leading words of several titles ("BIKE JUPITER DEFIANT BLK" + "... WHT" → "BIKE JUPITER DEFIANT"). */
function commonPrefix(titles) {
  const split = titles.map((t) => String(t || '').trim().split(/\s+/));
  const out = [];
  for (let i = 0; i < split[0].length; i++) {
    const w = split[0][i];
    if (split.every((s) => s[i] && s[i].toLowerCase() === w.toLowerCase())) out.push(w); else break;
  }
  return out.join(' ');
}

/**
 * "Create Shopify product": several Lightspeed items (same product, different color/size) become ONE
 * draft product in Shopify with one variant each (UPC as barcode). For products Workstand does not have.
 */
export async function openCreateProduct(ctx, ids, done) {
  if (ids.length < 1 || ids.length > 100) { toast('Select between 1 and 100 items', 'bad'); return; }
  let items;
  try {
    items = (await Promise.all(ids.map((id) => ctx.api.item(id)))).map((r) => r.item);
  } catch (e) { toast(e.message, 'bad'); return; }
  const prefix = items.length > 1 ? commonPrefix(items.map((i) => i.title)) : items[0].title;
  const title = h('input', { value: prefix.replace(/^BIKE\s+/i, ''), placeholder: 'Product name shown online' });
  const vendor = h('input', { value: items[0].brand || '' });
  const type = h('input', { value: items[0].category || '' });
  const optName = h('input', { value: 'Color', placeholder: 'Color, Size…' });
  const valueInputs = {};
  const rows = items.map((it) => {
    const guess = it.title.slice(prefix.length).trim() || it.title;
    valueInputs[it.id] = h('input', { value: guess, style: { width: '100%' } });
    return h('tr',
      h('td', h('div', it.title), h('div.sku', 'UPC ' + (it.upc || '— missing') + ' · System SKU ' + it.sku)),
      h('td.num', money(it.priceCents)),
      h('td.num', String(it.physicalQty || 0)),
      h('td', valueInputs[it.id]));
  });
  const errHost = h('div');
  const field = (label, input) => h('label.field', h('span', label), input);
  let m;
  const submit = async (btn) => {
    btn.disabled = true;
    mount(errHost);
    const values = {};
    Object.keys(valueInputs).forEach((k) => { values[k] = valueInputs[k].value; });
    try {
      const r = await ctx.api.createShopifyProduct({ variantIds: ids, title: title.value, vendor: vendor.value, productType: type.value, optionName: optName.value, values });
      m.close();
      toast('Draft product created in Shopify with ' + r.variants + ' variant(s)');
      modal({
        title: 'Created in Shopify (draft)',
        body: [h('p', 'Add photos and a description in Shopify, then set it to Active. Price, sale price and stock already sync from Lightspeed.'),
          h('a.btn.primary', { href: r.adminUrl, target: '_blank', rel: 'noopener' }, 'Open in Shopify ↗')],
        actions: [],
      });
      if (done) done();
    } catch (e) {
      btn.disabled = false;
      const problems = (e.details && e.details.problems) || [];
      mount(errHost, h('div.notice.bad', h('strong', e.message), problems.length ? h('ul', problems.map((p) => h('li', p))) : null));
    }
  };
  const createBtn = h('button.btn.primary', { onclick: (ev) => submit(ev.currentTarget) }, 'Create draft in Shopify');
  m = modal({
    title: 'Create Shopify product from ' + items.length + ' Lightspeed item' + (items.length === 1 ? '' : 's'),
    wide: true,
    body: [
      h('p.muted', 'Use this for products Workstand does not have (e.g. Jupiter). Each selected item becomes one variant (color/size) with its Lightspeed UPC as barcode. The product is created as a DRAFT so you can add photos before publishing.'),
      h('div.form-grid', field('Product name', title), field('Brand / vendor', vendor), field('Product type', type), field('Option name', optName)),
      h('table.t', h('thead', h('tr', h('th', 'Lightspeed item'), h('th.num', 'Price'), h('th.num', 'Stock'), h('th', 'Option value'))), h('tbody', rows)),
      errHost,
    ],
    actions: [h('button.btn', { onclick: () => m.close() }, 'Cancel'), createBtn],
  });
}
