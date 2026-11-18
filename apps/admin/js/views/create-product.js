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
  const optName = h('input', { value: items.length === 1 ? 'Title' : 'Color', placeholder: 'Color, Size…' });
  const publishNowCb = h('input', { type: 'checkbox', checked: true });
  const valueInputs = {};
  const rows = items.map((it) => {
    const guess = items.length === 1 ? 'Default Title' : (it.title.slice(prefix.length).trim() || it.title);
    valueInputs[it.id] = h('input', { value: guess, style: { width: '100%' } });
    return h('tr',
      h('td', h('div', it.title), h('div.sku', (it.upc ? 'UPC ' + it.upc : 'No UPC (syncs by SKU)') + ' · System SKU ' + it.sku)),
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
      const r = await ctx.api.createShopifyProduct({
        variantIds: ids,
        title: title.value,
        vendor: vendor.value,
        productType: type.value,
        optionName: optName.value,
        values,
        publishNow: publishNowCb.checked,
      });
      m.close();
      toast((publishNowCb.checked ? 'Published live in Shopify' : 'Draft product created in Shopify') + ' with ' + r.variants + ' variant(s)');
      modal({
        title: publishNowCb.checked ? 'Published to Shopify' : 'Created in Shopify (draft)',
        body: [h('p', publishNowCb.checked
          ? 'The product is now Active in Shopify (price, sale price, and stock sync from Lightspeed). You can open it in Shopify to add photos or description.'
          : 'Add photos and a description in Shopify, then set it to Active. Price, sale price and stock already sync from Lightspeed.'),
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
  const createBtn = h('button.btn.primary', { onclick: (ev) => submit(ev.currentTarget) }, 'Create & sync to Shopify');
  m = modal({
    title: 'Create Shopify product from ' + items.length + ' Lightspeed item' + (items.length === 1 ? '' : 's'),
    wide: true,
    body: [
      h('p.muted', 'Creates this product in Shopify and links it to Lightspeed automatically (even if it does not have a UPC — price & stock sync directly by Shopify variant ID).'),
      h('div.form-grid', field('Product name', title), field('Brand / vendor', vendor), field('Product type', type), field('Option name', optName)),
      h('label.check', publishNowCb, h('strong', 'Publish live in Shopify right away (Active)'), h('span.small.muted', ' — uncheck to save as Draft first')),
      h('table.t', h('thead', h('tr', h('th', 'Lightspeed item'), h('th.num', 'Price'), h('th.num', 'Stock'), h('th', 'Option value'))), h('tbody', rows)),
      errHost,
    ],
    actions: [h('button.btn', { onclick: () => m.close() }, 'Cancel'), createBtn],
  });
}
