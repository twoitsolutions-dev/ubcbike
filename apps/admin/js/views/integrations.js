import { h } from '../ui/dom.js';
import { card, dataTable, pageHead } from '../ui/components.js';
import { dateTime } from '../ui/format.js';

const META = {
  shopify: ['Shopify', 'Admin GraphQL API · storefront, products, discounts, orders webhooks', '#15803d', 'SH'],
  lightspeed_r: ['Lightspeed Retail R-Series', 'POS — items, matrices, prices, stock by shop (read-only first). Not X-Series.', '#c2410c', 'LS'],
  qbp: ['QBP', 'Quality Bicycle Products — catalog, availability, purchase orders', '#0e7490', 'QBP'],
  jbi: ['JBI', 'J&B Importers — catalog feed / dealer portal', '#7c2d12', 'JBI'],
  specialized: ['Specialized', 'Authorised-dealer data, bikes and e-bikes', '#991b1b', 'SPZ'],
};
const STATUS = {
  demo_adapter: ['Demo adapter — no real connection', 'violet'],
  not_connected: ['Not connected', 'bad'],
  configured: ['Credentials present — not verified', 'warn'],
  connected: ['Connected (authenticated test passed)', 'ok'],
  error: ['Error', 'bad'],
};

export async function renderIntegrations(ctx) {
  const r = await ctx.api.integrations();
  return h('div.stack',
    pageHead('Integrations', r.mode === 'demo'
      ? 'DEMO mode: every connector is a simulated adapter. No real Shopify, Lightspeed or supplier system is connected.'
      : 'LIVE mode: statuses come from authenticated health checks.'),
    h('div.notice', { class: r.mode === 'demo' ? 'info' : 'warn' }, r.mode === 'demo'
      ? 'Switching to LIVE is a server configuration (APP_MODE=live plus an explicit acknowledgement and credentials stored server-side). It cannot be changed from this screen or from the browser.'
      : 'Write operations stay disabled per connector until tested and authorised.'),
    h('div.grid.grid-3', r.integrations.map((i) => {
      const m = META[i.system] || [i.system, '', '#334155', i.system.slice(0, 3).toUpperCase()];
      const s = STATUS[i.status] || [i.status, ''];
      return h('section.card', h('div.integration',
        h('div.head', h('div.logo', { style: { background: m[2] } }, m[3]), h('div', h('h3', m[0]), h('span.badge', { class: s[1] }, s[0]))),
        h('p.small.muted', m[1]),
        h('p.small', i.detail),
        i.missing && i.missing.length ? h('div', h('div.small', h('strong', 'Needed before going live:')), h('ul', i.missing.map((x) => h('li', x)))) : null,
        h('div.small.muted', 'Writes: ' + (i.writesEnabled ? 'enabled' : 'disabled') + ' · checked ' + dateTime(i.checkedAt))));
    })),
    card('Calls the demo adapters would have made', r.demoCalls.length ? dataTable({
      columns: [
        { key: 'at', label: 'When', render: (c) => dateTime(c.at) },
        { key: 'system', label: 'System' },
        { key: 'op', label: 'Operation', render: (c) => h('code', c.op) },
        { key: 'detail', label: 'Detail', opt: true, render: (c) => h('code', JSON.stringify(c.detail).slice(0, 120)) },
      ],
      rows: r.demoCalls, rowKey: (c) => c.at + c.op,
    }) : h('p.muted', 'Nothing yet. Apply a promotion or send a purchase order to see the simulated calls.'), { flush: !!r.demoCalls.length }));
}
