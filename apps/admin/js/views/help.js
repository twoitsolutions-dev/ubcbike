import { h, mount } from '../ui/dom.js';
import { card, pageHead } from '../ui/components.js';

const GUIDES = [
  {
    id: 'hub',
    tab: '1. UBC Hub Guide',
    title: 'UBC Commerce Hub — Interactive Walkthrough',
    desc: 'Dashboard, Create in Shopify (Single / Matrix / Separate), Promotions, Reports, UPC Matches & Lightspeed Reconnect.',
    html: 'docs/UBC_Commerce_Hub_Interactive_Walkthrough.html',
    pdf: 'docs/UBC_Commerce_Hub_Manual_Carlos.pdf',
    pdfName: 'UBC_Commerce_Hub_Manual_Carlos.pdf',
  },
  {
    id: 'store',
    tab: '2. UBC Store Guide',
    title: 'Shopify Storefront & Products — Interactive Walkthrough',
    desc: 'How Lightspeed ↔ Shopify sync works, product pages, stock badges, SKUs, and fixing photos/collections.',
    html: 'docs/UBC_Shopify_Store_Interactive_Walkthrough.html',
    pdf: 'docs/UBC_Shopify_Manual_Carlos.pdf',
    pdfName: 'UBC_Shopify_Manual_Carlos.pdf',
  },
  {
    id: 'metaobjects',
    tab: '3. Pages & Metaobjects',
    title: 'Shopify Pages, Metaobjects & Design — Interactive Walkthrough',
    desc: 'Where to edit tune-up prices, store hours, financing, Low Price Guarantee, Florida Law, and colors without code.',
    html: 'docs/UBC_Shopify_Interactive_Walkthrough.html',
    pdf: 'docs/UBC_Shopify_Content_and_Metaobjects_Manual_Carlos.pdf',
    pdfName: 'UBC_Shopify_Content_and_Metaobjects_Manual_Carlos.pdf',
  },
];

export async function renderHelp(ctx) {
  let activeId = (ctx.query && ctx.query.guide) || 'hub';
  const tabsHost = h('div.rep-tabs');
  const stageHost = h('div');

  const draw = () => {
    const g = GUIDES.find((x) => x.id === activeId) || GUIDES[0];
    mount(tabsHost, GUIDES.map((item) =>
      h('button.rep-tab', {
        type: 'button',
        class: item.id === g.id ? 'on' : '',
        onclick: () => { activeId = item.id; draw(); },
      }, item.tab)));

    const iframe = h('iframe.help-player', {
      src: g.html,
      title: g.title,
      loading: 'eager',
      allowfullscreen: true,
    });

    mount(stageHost,
      card(g.title, h('div.stack-sm',
        h('p.small.muted', { style: { margin: '0' } }, g.desc),
        iframe), {
        actions: h('div.row',
          h('a.btn.primary.sm', { href: g.html, target: '_blank', rel: 'noopener' }, 'Fullscreen ↗'),
          h('a.btn.sm', { href: g.pdf, target: '_blank', rel: 'noopener' }, 'PDF ↗'),
          h('a.btn.sm', { href: g.pdf, download: g.pdfName }, 'Download PDF')),
      }));
  };

  draw();

  return h('div.stack.rep-root',
    pageHead('Help & Guides', 'Interactive walkthroughs + printable PDF manuals for Carlos'),
    tabsHost,
    stageHost);
}
