import { h } from '../ui/dom.js';
import { card, dataTable, pageHead } from '../ui/components.js';
import { dateTime } from '../ui/format.js';
import { settingsWorkspaceTabs } from './settings.js?v=38';

const META = {
  shopify: [
    'Shopify Plus',
    'Online Storefront · Admin GraphQL API (1,000 pts/s), Bulk Ops, Plus Delivery Customization Functions (Click & Collect), Orders Webhooks',
    '#15803d',
    'SH+',
  ],
  lightspeed_r: [
    'Lightspeed Retail R-Series',
    'Physical Store POS — items, matrices, in-store stock by shop, and opt-in POS price parity for major events (Black Friday, Christmas).',
    '#c2410c',
    'LS',
  ],
  qbp: [
    'QBP',
    'Quality Bicycle Products — UBC dealer access confirmed; ready to connect catalog, availability & POs',
    '#0e7490',
    'QBP',
  ],
  jbi: [
    'JBI',
    'J&B Importers — UBC dealer access confirmed; ready to connect SFTP/catalog feed & dealer portal',
    '#7c2d12',
    'JBI',
  ],
  specialized: [
    'Specialized',
    'Authorized Dealer B2B — UBC access confirmed; strict MAP floor & In-Store Pickup (Click & Collect) for complete bikes',
    '#991b1b',
    'SPZ',
  ],
};
const STATUS = {
  demo_adapter: ['Ready to connect (Demo adapter)', 'violet'],
  not_connected: ['Ready to connect — awaiting credentials', 'warn'],
  configured: ['Credentials present — pending contract check', 'warn'],
  connected: ['Connected (authenticated test passed)', 'ok'],
  error: ['Error', 'bad'],
};

export async function renderIntegrations(ctx) {
  const r = await ctx.api.integrations();
  const justReconnected = String(window.location.hash || '').includes('ls=reconnected');
  return h('div.stack',
    pageHead('Settings & Sync · Connections', r.mode === 'demo'
      ? 'DEMO mode: all connectors run simulated adapters while keeping Shopify Plus, Lightspeed R-Series, QBP, JBI and Specialized wired and ready to connect.'
      : 'LIVE mode: statuses come from authenticated server-side health checks.'),
    settingsWorkspaceTabs('connections'),
    justReconnected ? h('div.notice.ok', 'Lightspeed Retail R-Series reconnected — catalog sync queued automatically.') : null,
    h('div.notice', { class: r.mode === 'demo' ? 'info' : 'warn' }, r.mode === 'demo'
      ? 'Switching to LIVE is controlled strictly on the server (.env: APP_MODE=live + LIVE_MODE_ACK + credentials). Everyday promotions stay online-only; physical store POS price updates run only during authorized omnichannel events.'
      : 'Write operations stay gated per connector until explicitly enabled and authorized.'),
    h('div.grid.grid-3', r.integrations.map((i) => {
      const m = META[i.system] || [i.system, '', '#334155', i.system.slice(0, 3).toUpperCase()];
      const s = STATUS[i.status] || [i.status, ''];
      const lsReconnect = i.system === 'lightspeed_r' && r.mode !== 'demo' && ctx.can('integrations.manage') && ctx.api.lightspeedOAuthUrl
        ? h('div', { style: { marginTop: '8px' } }, h('button', {
          class: (i.status === 'error' || i.status === 'not_connected') ? 'btn primary' : 'btn outline',
          onclick: async () => {
            try {
              const out = await ctx.api.lightspeedOAuthUrl();
              if (out && out.url) window.location.href = out.url;
            } catch (err) {
              ctx.toast(err.message || 'Could not start Lightspeed OAuth', 'err');
            }
          },
        }, i.status === 'error' ? 'Reconnect Lightspeed' : 'Re-authorize Lightspeed'))
        : null;
      return h('section.card', h('div.integration',
        h('div.head', h('div.logo', { style: { background: m[2] } }, m[3]), h('div', h('h3', m[0]), h('span.badge', { class: s[1] }, s[0]))),
        h('p.small.muted', m[1]),
        h('p.small', i.detail),
        i.missing && i.missing.length ? h('div', h('div.small', h('strong', 'Checklist to activate LIVE:')), h('ul', i.missing.map((x) => h('li', x)))) : null,
        h('div.small.muted', 'Writes: ' + (i.writesEnabled ? 'enabled' : 'disabled') + ' · checked ' + dateTime(i.checkedAt)),
        lsReconnect));
    })),
    card('Operations recorded across Online (Shopify Plus) & Physical Store (Lightspeed POS)', r.demoCalls.length ? dataTable({
      columns: [
        { key: 'at', label: 'When', render: (c) => dateTime(c.at) },
        { key: 'system', label: 'System' },
        { key: 'op', label: 'Operation', render: (c) => h('code', c.op) },
        { key: 'detail', label: 'Detail', opt: true, render: (c) => h('code', JSON.stringify(c.detail).slice(0, 120)) },
      ],
      rows: r.demoCalls, rowKey: (c) => c.at + c.op,
    }) : h('p.muted', 'Nothing yet. Apply a promotion (online or Black Friday / Christmas POS event) or submit a purchase order to inspect the outbound API calls.'), { flush: !!r.demoCalls.length }));
}
