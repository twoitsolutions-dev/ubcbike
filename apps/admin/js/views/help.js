import { h, mount } from '../ui/dom.js';
import { pageHead } from '../ui/components.js';

const GUIDES = [
  {
    id: 'hub',
    badge: 'Guide 1 · Hub',
    title: 'UBC Hub Guide',
    desc: 'Dashboard, Create in Shopify (Single / Matrix / Separate), Promotions, Reports, UPC Matches & Lightspeed Reconnect.',
    thumb: 'img/guides/hub-create-shopify.png',
    html: 'docs/UBC_Commerce_Hub_Interactive_Walkthrough.html',
    pdf: 'docs/UBC_Commerce_Hub_Manual_Carlos.pdf',
    pdfName: 'UBC_Commerce_Hub_Manual_Carlos.pdf',
  },
  {
    id: 'store',
    badge: 'Guide 2 · Storefront',
    title: 'UBC Store Guide',
    desc: 'Lightspeed ↔ Shopify sync, white product pages, stock badges, System SKUs, and fixing photos or collections.',
    thumb: 'img/guides/product-pdp.png',
    html: 'docs/UBC_Shopify_Store_Interactive_Walkthrough.html',
    pdf: 'docs/UBC_Shopify_Manual_Carlos.pdf',
    pdfName: 'UBC_Shopify_Manual_Carlos.pdf',
  },
  {
    id: 'metaobjects',
    badge: 'Guide 3 · Content',
    title: 'Pages & Metaobjects',
    desc: 'Edit tune-up prices, store hours, financing, Low Price Guarantee, Florida Law, and colors without code.',
    thumb: 'img/guides/shopify-metaobjects.png',
    html: 'docs/UBC_Shopify_Interactive_Walkthrough.html',
    pdf: 'docs/UBC_Shopify_Content_and_Metaobjects_Manual_Carlos.pdf',
    pdfName: 'UBC_Shopify_Content_and_Metaobjects_Manual_Carlos.pdf',
  },
];

export async function renderHelp(ctx) {
  let activeId = (ctx.query && ctx.query.guide) || null;
  const host = h('div.stack.rep-root');

  const draw = () => {
    const selected = activeId ? GUIDES.find((g) => g.id === activeId) : null;

    if (!selected) {
      const grid = h('div.help-card-grid', GUIDES.map((g) =>
        h('article.card.help-guide-card',
          h('div.help-card-thumb', { onclick: () => { activeId = g.id; draw(); } },
            h('img', { src: g.thumb, alt: g.title, loading: 'lazy' }),
            h('span.help-play-pill', '▶ Interactive Guide')),
          h('div.card-body.stack-sm',
            h('span.small.muted', { style: { fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.06em' } }, g.badge),
            h('h3', { style: { margin: '0', fontSize: '16px', cursor: 'pointer' }, onclick: () => { activeId = g.id; draw(); } }, g.title),
            h('p.small.muted', { style: { margin: '0', flex: '1' } }, g.desc),
            h('div.row', { style: { marginTop: '8px' } },
              h('button.btn.primary.sm', { type: 'button', onclick: () => { activeId = g.id; draw(); } }, 'Open guide →'),
              h('a.btn.sm', { href: g.pdf, target: '_blank', rel: 'noopener' }, 'PDF ↗'))))));

      mount(host,
        pageHead('Help & Guides', 'Choose a guide to launch the interactive walkthrough or open the printable PDF'),
        grid,
        h('div.small.muted', { style: { textAlign: 'center', paddingTop: '8px' } },
          'Manuals & platform built by ',
          h('a', { href: 'https://www.twoitsolutions.com', target: '_blank', rel: 'noopener' }, h('strong', 'TwoIT Solutions LLC'))));
      return;
    }

    const iframe = h('iframe.help-player.help-player--full', {
      src: selected.html,
      title: selected.title,
      loading: 'eager',
      allowfullscreen: true,
    });

    mount(host,
      pageHead(selected.title, selected.desc, [
        h('button.btn.sm', { type: 'button', onclick: () => { activeId = null; draw(); } }, '← All Guides'),
        h('a.btn.primary.sm', { href: selected.html, target: '_blank', rel: 'noopener' }, 'Fullscreen ↗'),
        h('a.btn.sm', { href: selected.pdf, download: selected.pdfName }, 'Download PDF'),
      ]),
      iframe);
  };

  draw();
  return host;
}
