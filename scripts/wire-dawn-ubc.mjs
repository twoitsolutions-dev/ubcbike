// Idempotently wires UBC Commerce Hub's modern styling, omnichannel scripts,
// and `ubc.*` metafield blocks into Shopify Dawn v16 (`apps/dawn-ubc-theme`).
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const dawnRoot = resolve('apps/dawn-ubc-theme');

async function patchFile(relPath, transform) {
  const full = resolve(dawnRoot, relPath);
  const raw = await readFile(full, 'utf8');
  const next = transform(raw);
  if (next !== raw) {
    await writeFile(full, next, 'utf8');
    console.log(`Wired ${relPath}`);
  } else {
    console.log(`Already wired ${relPath}`);
  }
}

// 1. config/settings_schema.json — Theme metadata
await patchFile('config/settings_schema.json', (src) => {
  const parsed = JSON.parse(src);
  if (Array.isArray(parsed) && parsed[0]?.name === 'theme_info') {
    parsed[0] = {
      name: 'theme_info',
      theme_name: 'UBC Modern Cycling (Dawn)',
      theme_version: '1.0.0',
      theme_author: 'TwoIT Solutions LLC',
      theme_documentation_url: 'https://help.shopify.com/manual/online-store/themes',
      theme_support_url: 'https://support.shopify.com/',
    };
  }
  return JSON.stringify(parsed, null, 2) + '\n';
});

// 2. layout/theme.liquid — Load ubc-modern.css and ubc-omnichannel.js
await patchFile('layout/theme.liquid', (src) => {
  let out = src;
  if (!out.includes('ubc-modern.css')) {
    out = out.replace(
      "{{ 'base.css' | asset_url | stylesheet_tag }}",
      "{{ 'base.css' | asset_url | stylesheet_tag }}\n    {{ 'ubc-modern.css' | asset_url | stylesheet_tag }}",
    );
  }
  if (!out.includes('ubc-omnichannel.js')) {
    out = out.replace(
      '</body>',
      "    <script src=\"{{ 'ubc-omnichannel.js' | asset_url }}\" defer=\"defer\"></script>\n  </body>",
    );
  }
  return out;
});

// 3. sections/main-product.liquid — Native `ubc_fulfillment` OS 2.0 block
await patchFile('sections/main-product.liquid', (src) => {
  let out = src;
  if (!out.includes("when 'ubc_fulfillment'")) {
    out = out.replace(
      "{%- when 'custom_liquid' -%}",
      "{%- when 'ubc_fulfillment' -%}\n                  {% render 'ubc-dawn-fulfillment', product: product, block_attributes: block.shopify_attributes %}\n                {%- when 'custom_liquid' -%}",
    );
  }
  if (!out.includes('"type": "ubc_fulfillment"')) {
    out = out.replace(
      '"blocks": [',
      `"blocks": [\n    {\n      "type": "ubc_fulfillment",\n      "name": "UBC Omnichannel Status",\n      "limit": 1\n    },`,
    );
  }
  return out;
});

// 4. snippets/card-product.liquid — Live `ubc.*` availability & pickup pills
await patchFile('snippets/card-product.liquid', (src) => {
  if (src.includes('ubc-dawn-card-badge')) return src;
  return src.replace(
    "{% render 'price', product: card_product, price_class: '', show_compare_at_price: true %}",
    "{% render 'price', product: card_product, price_class: '', show_compare_at_price: true %}\n              {% render 'ubc-dawn-card-badge', card_product: card_product %}",
  );
});

// 5. snippets/cart-drawer.liquid — Omnichannel pickup & special-order summary
await patchFile('snippets/cart-drawer.liquid', (src) => {
  if (src.includes('ubc-cart-fulfillment-notice')) return src;
  return src.replace(
    '<div class="cart-drawer__footer"',
    "{% render 'ubc-cart-fulfillment-notice' %}\n        <div class=\"cart-drawer__footer\"",
  );
});

console.log('UBC Modern Cycling wiring on Shopify Dawn complete.');
