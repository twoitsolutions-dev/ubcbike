// Adopts the user's `ubc-sobre-dawn-v9` export as the canonical base in
// `apps/dawn-ubc-theme` and upgrades it to `UBC sobre Dawn v10`:
//   1. Preserves 100% of UBC Tampa FL brand assets (logos, Archivo variable font,
//      #213549/#CCBB8D/#FEFDF3 palette, 16 WebP bike/part cutouts, 7 ES5 motion sections).
//   2. Upgrades `snippets/ubc-availability.liquid` + `assets/ubc-brand.css` + locales
//      to render `ubc.click_and_collect_only` (In-Store Pickup in Tampa for complete bikes).
//   3. Adds `snippets/ubc-cart-fulfillment-notice.liquid` into Dawn's Cart Drawer & Cart Footer.
//   4. Polishes `header-group.json` & `footer-group.json` (replaces generic "Welcome to our store").
//   5. Wires `templates/index.json` 3D Build Carousel to live cycling handles on TwoIT Sandbox
//      and adds smart asset fallback in `ubc-product-showcase.liquid` when product media is empty.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const v9Src = 'C:/Users/PMC/.gemini/antigravity/brain/b52a5da2-98e9-4fe1-9336-f1c3a32b9d9b/scratch/ubc-sobre-dawn-v9';
const target = resolve('apps/dawn-ubc-theme');

console.log('1/6 Copying ubc-sobre-dawn-v9 cleanly into apps/dawn-ubc-theme...');
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(v9Src, target, { recursive: true });

// 2. Update config/settings_schema.json -> UBC sobre Dawn v10
console.log('2/6 Updating theme_info -> UBC sobre Dawn v10...');
const schemaPath = resolve(target, 'config/settings_schema.json');
const schemaJson = JSON.parse(await readFile(schemaPath, 'utf8'));
if (Array.isArray(schemaJson) && schemaJson[0]?.name === 'theme_info') {
  schemaJson[0] = {
    name: 'theme_info',
    theme_name: 'UBC sobre Dawn v10',
    theme_version: '10.0.0',
    theme_author: 'TwoIT Solutions LLC · University Bicycle Center',
    theme_documentation_url: 'https://help.shopify.com/manual/online-store/themes',
    theme_support_url: 'https://support.shopify.com/',
  };
}
await writeFile(schemaPath, JSON.stringify(schemaJson, null, 2) + '\n', 'utf8');

// Also enable show_vendor in config/settings_data.json so Specialized / Surly / Continental / Bell show cleanly
const dataPath = resolve(target, 'config/settings_data.json');
const dataJson = JSON.parse(await readFile(dataPath, 'utf8'));
if (dataJson.presets?.Dawn) {
  dataJson.presets.Dawn.show_vendor = true;
  dataJson.presets.Dawn.predictive_search_show_vendor = true;
  dataJson.presets.Dawn.predictive_search_show_price = true;
}
await writeFile(dataPath, JSON.stringify(dataJson, null, 2) + '\n', 'utf8');

// 3. Upgrade ALL locales/*.json + snippets/ubc-availability.liquid + assets/ubc-brand.css
console.log('3/6 Upgrading ubc-availability.liquid, locales & ubc-brand.css with ubc.click_and_collect_only...');
const { readdir } = await import('node:fs/promises');
const localesDir = resolve(target, 'locales');
for (const entry of await readdir(localesDir)) {
  if (!entry.endsWith('.json') || entry.includes('.schema.')) continue;
  const locPath = resolve(localesDir, entry);
  const locJson = JSON.parse(await readFile(locPath, 'utf8'));
  if (locJson.ubc?.products?.availability) {
    locJson.ubc.products.availability.pickup_only = 'In-store pickup only · Tampa';
    locJson.ubc.products.pickup_only_explainer =
      'Per authorized brand policy, complete bicycles include certified UBC mechanic assembly & safety inspection and are picked up ready to ride at our Tampa store.';
    await writeFile(locPath, JSON.stringify(locJson, null, 2) + '\n', 'utf8');
  }
}

const availabilityLiquid = `{%- comment -%}
  Renders omnichannel availability & Click-and-Collect rules published by UBC Commerce Hub:
    variant.metafields.ubc.availability           -> in_stock | special_order | unavailable
    variant.metafields.ubc.lead_time_days         -> integer business days (special orders)
    variant.metafields.ubc.click_and_collect_only -> boolean (e.g. Specialized complete bikes)
  Supplier quantities are never published as stock: special-order variants use
  inventory policy "continue" with 0 units. Falls back to Shopify inventory.
  Usage:
    Compact (cards / showcase): {% render 'ubc-availability', variant: v %}
    Detailed (PDP):             {% render 'ubc-availability', variant: v, detailed: true %}
{%- endcomment -%}
{%- liquid
  assign status = variant.metafields.ubc.availability.value
  if status == blank
    if variant.available and variant.inventory_quantity > 0
      assign status = 'in_stock'
    elsif variant.available
      assign status = 'special_order'
    else
      assign status = 'unavailable'
    endif
  endif
  assign lead = variant.metafields.ubc.lead_time_days.value
  assign pickup_only = variant.metafields.ubc.click_and_collect_only.value
-%}
<div class="ubc-availability-group" data-ubc-availability-wrap>
  <div class="ubc-availability-pills">
    <span class="availability availability--{{ status }}" data-availability>
      {%- case status -%}
        {%- when 'in_stock' -%}
          {{ 'ubc.products.availability.in_stock' | t }}
        {%- when 'special_order' -%}
          {%- if lead != blank -%}
            {{ 'ubc.products.availability.special_order_days' | t: days: lead }}
          {%- else -%}
            {{ 'ubc.products.availability.special_order' | t }}
          {%- endif -%}
        {%- else -%}
          {{ 'ubc.products.availability.unavailable' | t }}
      {%- endcase -%}
    </span>
    {%- if pickup_only -%}
      <span class="availability availability--pickup" data-pickup-badge>
        In-store pickup only &middot; Tampa
      </span>
    {%- endif -%}
  </div>
  {%- if detailed and pickup_only -%}
    <p class="ubc-pickup-callout" data-pickup-callout>
      <strong>In-Store Pickup Only (Tampa Showroom):</strong> Complete bicycles include certified UBC mechanic assembly &amp; safety inspection and must be picked up in store.
    </p>
  {%- elsif detailed and status == 'special_order' -%}
    <p class="ubc-special-note">{{ 'ubc.products.special_order_explainer' | t }}</p>
  {%- endif -%}
</div>
`;
await writeFile(resolve(target, 'snippets/ubc-availability.liquid'), availabilityLiquid, 'utf8');

const brandCssPath = resolve(target, 'assets/ubc-brand.css');
let brandCss = await readFile(brandCssPath, 'utf8');
if (!brandCss.includes('.availability--pickup')) {
  brandCss += `
/* v10 UBC Commerce Hub Omnichannel Additions (Click & Collect + Cart Drawer Notice) */
.ubc-availability-group{display:flex;flex-direction:column;gap:6px;margin-top:6px}
.ubc-availability-pills{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.ubc-availability-pills .availability{margin-top:0}
.availability--pickup{background:#213549;color:#CCBB8D;border:1px solid rgba(204,187,141,.45)}
.ubc-pickup-callout{margin:6px 0 0;padding:10px 14px;border-radius:12px;background:#f3f1e7;border-left:3px solid #213549;color:#14202d;font-size:13.5px;line-height:1.5}
.ubc-cart-notice{margin:0 0 12px;padding:11px 14px;border-radius:12px;background:#f3f1e7;border:1px solid #e4e1d3;color:#14202d;font-size:13px;line-height:1.45;display:flex;flex-direction:column;gap:6px}
.ubc-cart-notice strong{color:#213549}
`;
  await writeFile(brandCssPath, brandCss, 'utf8');
}

// Pass `detailed: true` in sections/main-product.liquid and sections/ubc-main-product-spin.liquid
const mainProdPath = resolve(target, 'sections/main-product.liquid');
let mainProd = await readFile(mainProdPath, 'utf8');
mainProd = mainProd.replace(
  "{% render 'ubc-availability', variant: product.selected_or_first_available_variant %}",
  "{% render 'ubc-availability', variant: product.selected_or_first_available_variant, detailed: true %}",
);
await writeFile(mainProdPath, mainProd, 'utf8');

const spinProdPath = resolve(target, 'sections/ubc-main-product-spin.liquid');
let spinProd = await readFile(spinProdPath, 'utf8');
spinProd = spinProd.replace(
  "{% render 'ubc-availability', variant: v %}",
  "{% render 'ubc-availability', variant: v, detailed: true %}",
);
await writeFile(spinProdPath, spinProd, 'utf8');

// 4. Add Cart Drawer & Cart Footer omnichannel notice
console.log('4/6 Adding Smart Omnichannel Fulfillment Notice to Cart Drawer & Cart Footer...');
const cartNoticeLiquid = `{%- if cart != empty -%}
  {%- liquid
    assign has_pickup_only = false
    assign has_special_order = false
    assign max_lead_days = 0
    for item in cart.items
      assign v = item.variant
      if v.metafields.ubc.click_and_collect_only.value == true
        assign has_pickup_only = true
      endif
      if v.metafields.ubc.availability.value == 'special_order'
        assign has_special_order = true
        assign ld = v.metafields.ubc.lead_time_days.value | plus: 0
        if ld > max_lead_days
          assign max_lead_days = ld
        endif
      endif
    endfor
  -%}
  {%- if has_pickup_only or has_special_order -%}
    <div class="ubc-cart-notice" role="status">
      {%- if has_pickup_only -%}
        <div><strong>In-Store Pickup in Tampa:</strong> Complete bikes include professional UBC mechanic assembly and are picked up at our showroom.</div>
      {%- endif -%}
      {%- if has_special_order -%}
        <div><strong>Special Order Included:</strong> Distributor-fulfilled items arrive in {% if max_lead_days > 0 %}about {{ max_lead_days }} days{% else %}3–5 business days{% endif %}.</div>
      {%- endif -%}
    </div>
  {%- endif -%}
{%- endif -%}
`;
await writeFile(resolve(target, 'snippets/ubc-cart-fulfillment-notice.liquid'), cartNoticeLiquid, 'utf8');

const cartDrawerPath = resolve(target, 'snippets/cart-drawer.liquid');
let cartDrawer = await readFile(cartDrawerPath, 'utf8');
if (!cartDrawer.includes('ubc-cart-fulfillment-notice')) {
  cartDrawer = cartDrawer.replace(
    '<div class="cart-drawer__footer"',
    "{% render 'ubc-cart-fulfillment-notice' %}\n        <div class=\"cart-drawer__footer\"",
  );
  await writeFile(cartDrawerPath, cartDrawer, 'utf8');
}

const mainCartFooterPath = resolve(target, 'sections/main-cart-footer.liquid');
let mainCartFooter = await readFile(mainCartFooterPath, 'utf8');
if (!mainCartFooter.includes('ubc-cart-fulfillment-notice')) {
  mainCartFooter = mainCartFooter.replace(
    '<div class="cart__blocks">',
    '<div class="cart__blocks">\n        {% render \'ubc-cart-fulfillment-notice\' %}',
  );
  await writeFile(mainCartFooterPath, mainCartFooter, 'utf8');
}

// 5. Enhance ubc-product-showcase.liquid media fallback when live products don't have uploaded photos yet
console.log('5/6 Adding smart dealer cutout fallback in ubc-product-showcase.liquid...');
const showcasePath = resolve(target, 'sections/ubc-product-showcase.liquid');
let showcase = await readFile(showcasePath, 'utf8');
const smartFallback = `{%- else -%}
                  {%- assign ptype_down = product.type | downcase -%}
                  {%- assign ptitle_down = product.title | downcase -%}
                  {%- if ptitle_down contains 'tarmac' or ptype_down contains 'road' -%}
                    <img src="{{ 'ubc-bike-tarmac-sl9.webp' | asset_url }}" width="1400" height="850" loading="lazy" alt="{{ product.title | escape }}">
                  {%- elsif ptitle_down contains 'gravel' or ptype_down contains 'gravel' or ptype_down contains 'frame' -%}
                    <img src="{{ 'ubc-bike-diverge.webp' | asset_url }}" width="1400" height="850" loading="lazy" alt="{{ product.title | escape }}">
                  {%- elsif ptype_down contains 'tire' -%}
                    <img src="{{ 'ubc-part-tires.webp' | asset_url }}" width="900" height="600" loading="lazy" alt="{{ product.title | escape }}">
                  {%- else -%}
                    {% render 'ubc-bike-illustration' %}
                  {%- endif -%}
                {%- endif -%}`;
showcase = showcase.replace(
  "{%- else -%}\n                  {% render 'ubc-bike-illustration' %}\n                {%- endif -%}",
  smartFallback,
);
await writeFile(showcasePath, showcase, 'utf8');

// 6. Polish header-group.json, footer-group.json, and templates/index.json build handles
console.log('6/6 Polishing announcement bar, footer & live Build Carousel handles...');
const headerGroup = {
  name: 't:sections.header.name',
  type: 'header',
  sections: {
    'announcement-bar': {
      type: 'announcement-bar',
      blocks: {
        'announcement-bar-0': {
          type: 'announcement',
          settings: {
            text: 'University Bicycle Center · Tampa, FL · Free In-Store Pickup & Expert Mechanic Assembly',
            link: '',
          },
        },
      },
      block_order: ['announcement-bar-0'],
      settings: {
        auto_rotate: false,
        change_slides_speed: 5,
        color_scheme: 'scheme-4',
        show_line_separator: true,
        show_social: false,
        enable_country_selector: false,
        enable_language_selector: false,
      },
    },
    header: {
      type: 'header',
      settings: {
        logo_position: 'middle-left',
        mobile_logo_position: 'center',
        menu: 'main-menu',
        menu_type_desktop: 'dropdown',
        sticky_header_type: 'on-scroll-up',
        show_line_separator: true,
        color_scheme: 'scheme-3',
        menu_color_scheme: 'scheme-1',
        enable_country_selector: false,
        enable_language_selector: false,
        margin_bottom: 0,
        padding_top: 20,
        padding_bottom: 20,
      },
    },
  },
  order: ['announcement-bar', 'header'],
};
await writeFile(resolve(target, 'sections/header-group.json'), JSON.stringify(headerGroup, null, 2) + '\n', 'utf8');

const footerGroup = {
  name: 't:sections.footer.name',
  type: 'footer',
  sections: {
    footer: {
      type: 'footer',
      blocks: {
        ubc_tampa: {
          type: 'text',
          settings: {
            heading: 'University Bicycle Center · Tampa',
            subtext: '<p>Serving Tampa riders since 1972. Authorized Specialized, Surly, Continental &amp; Bell dealer — assembled, fitted, and serviced in store.</p>',
          },
        },
        ubc_omnichannel: {
          type: 'text',
          settings: {
            heading: 'In-Stock & Special Orders',
            subtext: '<p><strong>In stock at UBC:</strong> Ready today for free Tampa pickup or fast shipping.<br/><strong>Special order:</strong> Ordered directly from our authorized U.S. distributors in 3–5 days.</p>',
          },
        },
      },
      block_order: ['ubc_tampa', 'ubc_omnichannel'],
      settings: {
        color_scheme: 'scheme-4',
        newsletter_enable: true,
        newsletter_heading: 'Join the UBC Tampa Ride & Service Dispatch',
        enable_follow_on_shop: false,
        show_social: true,
        enable_country_selector: false,
        enable_language_selector: false,
        payment_enable: true,
        show_policy: true,
        margin_top: 0,
        padding_top: 44,
        padding_bottom: 40,
      },
    },
  },
  order: ['footer'],
};
await writeFile(resolve(target, 'sections/footer-group.json'), JSON.stringify(footerGroup, null, 2) + '\n', 'utf8');

const indexPath = resolve(target, 'templates/index.json');
const indexJson = JSON.parse(await readFile(indexPath, 'utf8'));
if (indexJson.sections?.builds?.blocks) {
  if (indexJson.sections.builds.blocks.b1?.settings) {
    indexJson.sections.builds.blocks.b1.settings.product = 'specialized-tarmac-sl7-sport-56cm';
    indexJson.sections.builds.blocks.b1.settings.pieces = [
      'bell-z20-mips-road-helmet-medium',
      'continental-grand-prix-5000-700x28c-tire',
    ];
  }
  if (indexJson.sections.builds.blocks.b2?.settings) {
    indexJson.sections.builds.blocks.b2.settings.product = 'surly-midnight-special-frame-54cm';
    indexJson.sections.builds.blocks.b2.settings.pieces = [
      'continental-grand-prix-5000-700x28c-tire',
      'bell-z20-mips-road-helmet-medium',
    ];
  }
}
await writeFile(indexPath, JSON.stringify(indexJson, null, 2) + '\n', 'utf8');

console.log('Upgrade complete! apps/dawn-ubc-theme is now UBC sobre Dawn v10.');
