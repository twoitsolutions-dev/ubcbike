import { h, mount } from '../ui/dom.js';
import { card, pageHead } from '../ui/components.js';

const MANUALS = [
  {
    kicker: 'Manual 1 · Operations',
    title: 'UBC Commerce Hub Manual',
    desc: 'Daily workflow for Item Search, Special Orders, B2B Purchase Orders, Promotions, Reports, and Lightspeed sync.',
    file: 'docs/UBC_Commerce_Hub_Manual_Carlos.pdf',
    filename: 'UBC_Commerce_Hub_Manual_Carlos.pdf',
  },
  {
    kicker: 'Manual 2 · Storefront',
    title: 'Shopify Storefront & Admin Guide',
    desc: 'How Shopify products, collections, barcodes, inventory locations, and the live storefront work with the Hub.',
    file: 'docs/UBC_Shopify_Manual_Carlos.pdf',
    filename: 'UBC_Shopify_Manual_Carlos.pdf',
  },
  {
    kicker: 'Manual 3 · Global Content',
    title: 'Pages, Metaobjects & Theme Design Guide',
    desc: 'Where to edit tune-up prices, store hours, financing, Low Price Guarantee, Florida Law, and colors without code.',
    file: 'docs/UBC_Shopify_Content_and_Metaobjects_Manual_Carlos.pdf',
    filename: 'UBC_Shopify_Content_and_Metaobjects_Manual_Carlos.pdf',
  },
];

const MASTER_TABLE = [
  ['About UBC / UBC Difference', '/pages/about-us', 'Shopify Page', 'Online Store → Pages → UBC Difference', 'Warranty, Low Price Guarantee, Safety Tips, Florida Law'],
  ['Bike Service & Repair', '/pages/bike-service-repair', 'Metaobject', 'Content → Metaobjects → UBC Service Package', 'Tune-up prices, checklists, or add new packages'],
  ['Locations & Contact Us', '/pages/locations · /contact-us', 'Metaobject', 'Content → Metaobjects → UBC Store Location', 'Tampa & Alafia addresses (auto Google Maps), phones & hours'],
  ['Financing', '/pages/financing', 'Metaobject', 'Content → Metaobjects → UBC Financing Partner', 'Acima, Synchrony & Snap Finance text & Apply links'],
  ['Why Shop At UBC (5 Reasons)', '/pages/why-shop-at-ubc', 'Metaobject', 'Content → Metaobjects → UBC Policy & Guarantee Card', 'The 5 numbered Reasons cards (page_group = reasons)'],
  ['Buyer’s Guide — Bike Types', '/pages/buyers-guide', 'Metaobject', 'Content → Metaobjects → UBC Bike Type Guide', 'Road, Hybrid, Mountain, Comfort, Cruiser & Recumbent cards'],
  ['Buyer’s Guide — Size Chart', '/pages/buyers-guide', 'Metaobject', 'Content → Metaobjects → UBC Size Chart Row', 'XS through XL/XXL rider heights & frame sizes'],
  ['Colors & Card Shapes', 'All UBC pages', 'Theme Editor', 'Themes → Customize → UBC Page Layout', 'Background, card & button colors + corner radius (0–40px)'],
];

function figureBox(src, caption) {
  return h('figure.help-figure',
    h('a', { href: src, target: '_blank', rel: 'noopener', title: 'Click to open full size' },
      h('img', { src, alt: caption, loading: 'lazy' })),
    h('figcaption', caption));
}

function guideMetaobjects() {
  return h('div.stack',
    card('Global Content vs. Theme Design (Survives Any Theme Change)', h('div.stack',
      h('p.muted', 'All text, tune-up prices, store hours, financing links, and policies live globally in Shopify (Pages & Metaobjects) — never trapped inside a single theme. Zero extra JavaScript and 0% speed impact.'),
      h('div.help-shots-2',
        figureBox('img/guides/shopify-metaobjects.png', 'Shopify Admin → Content → Metaobjects: edit UBC Service Package, Store Location, Financing Partner, Bike Type Guide & Size Chart.'),
        figureBox('img/guides/about-editable.png', 'Live About UBC page (/pages/about-us): renders everything Carlos edits in Online Store → Pages → UBC Difference automatically.')),
      h('div.table-wrap',
        h('table.t',
          h('thead', h('tr', h('th', 'Page'), h('th', 'URL'), h('th', 'Type'), h('th', 'Where to Edit'), h('th', 'Controls'))),
          h('tbody', MASTER_TABLE.map((row) => h('tr',
            h('td', h('strong', row[0])),
            h('td', h('code', row[1])),
            h('td', h('span.badge', { class: row[2] === 'Metaobject' ? 'ok' : row[2] === 'Shopify Page' ? 'info' : 'warn' }, row[2])),
            h('td', row[3]),
            h('td', row[4])))))))));
}

function guideCreateShopify() {
  return card('Creating Products in Shopify from Lightspeed (Single, Matrix & Separate)', h('div.stack',
    h('div.help-split',
      h('div.stack-sm',
        h('ol.help-steps',
          h('li', h('strong', '1 single item: '), 'Open any unlinked item in ', h('a', { href: '#/products' }, 'Item Search'), ' → click ', h('code', 'Create in Shopify…'), ' in Item Details (or check its box in the list).'),
          h('li', h('strong', 'Matrix (1 product with colors/sizes): '), 'Check 2 or more related Lightspeed items in ', h('a', { href: '#/products' }, 'Item Search'), ' and click ', h('code', 'Create Matrix in Shopify…'), '. All selected items become variants of one Shopify product.'),
          h('li', h('strong', 'Separate (bulk independent products): '), 'Check 2 or more different items and click ', h('code', 'Create Separate in Shopify…'), '. Edit titles if needed and create them all in one click.'),
          h('li', h('strong', 'Draft vs. Live: '), 'Leave "Publish live right away" checked to go Active immediately, or uncheck it to create Drafts first so you can add photos in Shopify.'),
          h('li', h('strong', 'Automatic UPC matching: '), 'All matching UPCs between Lightspeed and Shopify are now auto-approved — view or search them anytime in ', h('a', { href: '#/upc-matches' }, 'UPC Matches'), '.'))),
      figureBox('img/guides/hub-create-shopify.png', 'Item Search in UBC Commerce Hub: select 1 item for Create in Shopify, or 2+ items for Create Matrix vs. Create Separate.'))));
}

function guideStorefront() {
  return card('Product Pages & Store Stock Badges', h('div.stack',
    h('div.help-split',
      h('div.stack-sm',
        h('ol.help-steps',
          h('li', h('strong', 'Clean white product page: '), 'Styled with a crisp white background, one large main photo, and horizontal thumbnails underneath.'),
          h('li', h('strong', 'Clear variants & buy box: '), 'Color and Size buttons have clean borders (dark navy when selected, crossed out when sold out), with Quantity directly above the solid ADD TO CART button.'),
          h('li', h('strong', 'In-Store Stock vs. Warehouse: '), 'Items with physical stock show ', h('code', 'UBC Tampa'), ', ', h('code', 'Alafia Park'), ', or ', h('code', 'In Stock at UBC'), '. Only true special-order items show ', h('code', 'At Warehouse · Available to Order'), '.'),
          h('li', h('strong', 'Zero-prefix UPCs: '), 'Shopify barcodes work with or without leading ', h('code', '00'), ' — the Hub normalizes all barcodes to 14-digit GTIN automatically.'))),
      figureBox('img/guides/product-pdp.png', 'Live Specialized Camber product page on ubcbike.com: crisp white background, thumbnail row below main image, solid ADD TO CART & green pickup card.'))));
}

function guidePromosReports() {
  return card('Promotions, Reports & Lightspeed Sync', h('div.stack',
    h('ol.help-steps',
      h('li', h('strong', 'Promotions / Price Rules: '), 'Go to ', h('a', { href: '#/promotions/new' }, '+ New Promotion'), '. Discounts calculate from Lightspeed Default Price, margin uses Average Cost, and brand filters come directly from Shopify.'),
      h('li', h('strong', 'Collections Coverage Report: '), 'Open ', h('a', { href: '#/reports' }, 'Reports'), ' to see every active in-stock Shopify product that is missing from department collections or missing from ALL collections, filter by Product Type, or export CSV.'),
      h('li', h('strong', '1-Click Lightspeed Reconnect: '), 'Lightspeed syncs automatically every few minutes with automatic token rotation. If Lightspeed ever revokes access externally, go to ', h('a', { href: '#/integrations' }, 'Settings & Sync → Connections'), ' and click ', h('code', 'Reconnect Lightspeed'), ' — no terminal needed.'))));
}

export async function renderHelp() {
  let activeTab = 'content';
  const tabsHost = h('div.seg-group');
  const guideHost = h('div');

  const TABS = [
    ['content', 'Pages & Metaobjects', guideMetaobjects],
    ['create', 'Create in Shopify', guideCreateShopify],
    ['storefront', 'Product Pages & Stock', guideStorefront],
    ['ops', 'Promos, Reports & Sync', guidePromosReports],
  ];

  const drawGuide = () => {
    mount(tabsHost, TABS.map(([id, label]) =>
      h('button.seg-btn', {
        type: 'button',
        class: activeTab === id ? 'on' : '',
        onclick: () => { activeTab = id; drawGuide(); },
      }, label)));
    const found = TABS.find((t) => t[0] === activeTab) || TABS[0];
    mount(guideHost, found[2]());
  };

  drawGuide();

  const pdfGrid = h('div.grid.grid-3', MANUALS.map((m) =>
    h('section.card.help-pdf-card',
      h('div.card-body.stack-sm',
        h('span.small.muted', { style: { fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.06em' } }, m.kicker),
        h('h3', { style: { margin: '0', fontSize: '15px' } }, m.title),
        h('p.small.muted', { style: { margin: '0', flex: '1' } }, m.desc),
        h('div.row', { style: { marginTop: '8px' } },
          h('a.btn.primary.sm', { href: m.file, target: '_blank', rel: 'noopener' }, 'Open PDF ↗'),
          h('a.btn.sm', { href: m.file, download: m.filename }, 'Download'))))));

  return h('div.stack',
    pageHead('Help & Guides', 'Printable PDF manuals for Carlos + visual step-by-step guides with real screenshots'),
    pdfGrid,
    h('div.row', tabsHost),
    guideHost);
}
