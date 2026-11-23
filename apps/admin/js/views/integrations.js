import { h } from '../ui/dom.js';
import { card, confirmDialog, dataTable, pageHead, toast, watchJob } from '../ui/components.js';
import { dateTime } from '../ui/format.js';
import { settingsWorkspaceTabs } from './settings.js?v=87';

const SUPPLIER_META = {
  qbp: {
    code: 'QBP',
    mark: 'QBP',
    markClass: 'qbp',
    title: 'Quality Bicycle Products',
    role: 'Authorized Dealer B2B · Parts, tires, helmets & accessories catalog',
  },
  jbi: {
    code: 'JBI',
    mark: 'JBI',
    markClass: 'jbi',
    title: 'J&B Importers',
    role: 'Authorized Dealer B2B · Workshop consumables, components & SFTP feeds',
  },
  specialized: {
    code: 'SPZ',
    mark: 'SPZ',
    markClass: 'spz',
    title: 'Specialized Bicycle Components',
    role: 'Authorized Dealer B2B · Strict MAP floor & Click & Collect complete bikes',
  },
};

const ACTIVITY_LABELS = {
  'lightspeed.catalog_synced': ['Lightspeed POS', 'POS Catalog & Stock Sync', 'info'],
  'shopify.store_tags_synced': ['Shopify Store', 'Storefront Tags & Channel Visibility', 'ok'],
  'pipeline.shopify_prices_reconciled': ['Shopify Store', 'Price & Compare-At Guardrail Check', 'ok'],
  'pipeline.flushed_to_shopify': ['Shopify Store', 'Staged Inventory & Price Push', 'ok'],
  'shopify.upc_links_proposed': ['Commerce Hub', 'UPC / System ID Catalog Matcher', 'info'],
  'shopify.product_created_from_items': ['Shopify Store', 'Product Published from Hub', 'ok'],
  'lightspeed.bulk_sheet_updated': ['Lightspeed POS', 'Bulk Sheet Live Update', 'warn'],
  'lightspeed.mode_changed': ['Lightspeed POS', 'POS Write Safety Mode Changed', 'warn'],
  'campaign.applied': ['Omnichannel Promo', 'Promotion Published Live', 'ok'],
  'campaign.restored': ['Omnichannel Promo', 'Promotion Prices Restored', 'info'],
};

function fmtNum(n) {
  return Number(n || 0).toLocaleString('en-US');
}

function shortAge(iso) {
  if (!iso) return 'Pending first run';
  const diffSec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (diffSec < 60) return 'Just now';
  if (diffSec < 3600) return Math.round(diffSec / 60) + 'm ago';
  if (diffSec < 86400) return Math.round(diffSec / 3600) + 'h ago';
  return dateTime(iso);
}

function parseShopifyScopes(detail) {
  const txt = String(detail || '');
  const idx = txt.toLowerCase().indexOf('scopes:');
  if (idx === -1) return { cleanSummary: txt, scopes: [] };
  const before = txt.slice(0, idx).replace(/[·,\s]+$/, '').trim();
  const rawScopes = txt.slice(idx + 7).split(',').map((s) => s.trim()).filter(Boolean);
  return { cleanSummary: before, scopes: rawScopes };
}

function summarizeAuditDetail(action, detail) {
  const d = detail || {};
  if (action === 'lightspeed.catalog_synced') {
    const mode = d.delta ? 'Delta' : 'Full';
    return mode + ' sync · ' + fmtNum(d.itemsSeen || d.seen || 0) + ' items checked · ' + fmtNum(d.variantsUpserted || d.updated || 0) + ' updated';
  }
  if (action === 'shopify.store_tags_synced') {
    const pub = d.newlyPublishedToWeb ? ' · ' + fmtNum(d.newlyPublishedToWeb) + ' published to web' : '';
    return fmtNum(d.checked || d.linkedProducts || 0) + ' products verified · ' + fmtNum(d.updated || 0) + ' tags updated' + pub;
  }
  if (action === 'pipeline.shopify_prices_reconciled') {
    return fmtNum(d.checked || 0) + ' variants audited · ' + fmtNum(d.updated || d.pushed || 0) + ' synced';
  }
  if (action === 'pipeline.flushed_to_shopify') {
    return fmtNum(d.pushed || 0) + ' staged updates pushed to Shopify';
  }
  if (action === 'shopify.upc_links_proposed') {
    return fmtNum(d.autoLinked || 0) + ' auto-linked · ' + fmtNum(d.queuedForReview || 0) + ' queued for review';
  }
  if (action === 'shopify.product_created_from_items') {
    return (d.title || 'New Shopify product') + (d.handle ? ' (/' + d.handle + ')' : '');
  }
  if (action === 'lightspeed.bulk_sheet_updated') {
    return fmtNum(d.updated || (Array.isArray(d.itemIds) ? d.itemIds.length : 1)) + ' POS item(s) updated with backup';
  }
  if (action === 'lightspeed.mode_changed') {
    return d.lightspeedWritesActive ? 'Live POS writes enabled by admin' : 'Switched to Read-Only safety lock';
  }
  if (action === 'campaign.applied') {
    const ch = d.channel === 'online_and_pos' ? 'Online + Store POS' : 'Shopify Online';
    return ch + ' · ' + fmtNum(d.applied || 0) + ' prices updated';
  }
  if (action === 'campaign.restored') {
    return fmtNum(d.restored || 0) + ' prices restored to regular retail';
  }
  const keys = Object.keys(d);
  if (!keys.length) return 'Completed';
  return keys.slice(0, 4).map((k) => k + ': ' + JSON.stringify(d[k])).join(' · ').slice(0, 120);
}

function statusPill(status, isDemo) {
  if (isDemo || status === 'demo_adapter') return h('span.badge.violet', 'Demo adapter');
  if (status === 'connected') return h('span.badge.ok', 'Connected');
  if (status === 'configured') return h('span.badge.info', 'Configured');
  if (status === 'error') return h('span.badge.bad', 'Connection Error');
  return h('span.badge', 'Standby');
}

export async function renderIntegrations(ctx) {
  const r = await ctx.api.integrations();
  const isDemo = r.mode === 'demo';
  const justReconnected = String(window.location.hash || '').includes('ls=reconnected');
  const bySystem = {};
  (r.integrations || []).forEach((it) => { bySystem[it.system] = it; });

  const ls = bySystem.lightspeed_r || { system: 'lightspeed_r', status: 'not_connected', detail: '', writesEnabled: false };
  const sh = bySystem.shopify || { system: 'shopify', status: 'not_connected', detail: '', writesEnabled: false };
  const tele = r.liveTelemetry || {};
  const lsTele = tele.lightspeed || { accountId: '114391', posItems: 0, inStockSkus: 0, totalUnits: 0, lastSyncAt: null, writesActive: !!ls.writesEnabled };
  const shTele = tele.shopify || { shopDomain: 'ubcbike.myshopify.com', storeUrl: 'https://ubcbike.myshopify.com', linkedVariants: 0, lastReconcileAt: null, lastTagSyncAt: null };
  const supRows = tele.suppliers || [];
  const supByCode = {};
  supRows.forEach((s) => { supByCode[String(s.code || '').toLowerCase()] = s; });

  const refreshView = () => ctx.navigate('#/integrations?r=' + Date.now());
  const parsedSh = parseShopifyScopes(sh.detail);

  // ---------- Lightspeed Hero Card ----------
  const lsWritesOn = !!ls.writesEnabled;
  const canManage = ctx.can('integrations.manage');
  const canCatalogWrite = ctx.can('catalog.write');

  const lsCard = h('section.conn-card',
    h('div.conn-card-top',
      h('div.conn-brand',
        h('div.conn-mark.ls', 'LS'),
        h('div',
          h('div.conn-title', 'Lightspeed Retail R-Series'),
          h('div.conn-role', 'Physical Store POS · Tampa Showroom & Alafia River Park'))),
      h('div.conn-pills',
        statusPill(ls.status, isDemo),
        h('span.badge', { class: lsWritesOn ? 'ok' : 'violet' }, lsWritesOn ? 'Live Writes Active' : 'Read-Only Safe Lock'))),
    h('div.conn-metrics',
      h('div.conn-metric',
        h('div.conn-metric-k', 'POS Catalog'),
        h('div.conn-metric-v', isDemo ? 'Demo Seed' : fmtNum(lsTele.posItems)),
        h('div.conn-metric-sub', 'Account #' + (lsTele.accountId || '114391'))),
      h('div.conn-metric',
        h('div.conn-metric-k', 'In-Stock SKUs'),
        h('div.conn-metric-v', isDemo ? 'Simulated' : fmtNum(lsTele.inStockSkus)),
        h('div.conn-metric-sub', isDemo ? '2 store locations' : fmtNum(lsTele.totalUnits) + ' physical units')),
      h('div.conn-metric',
        h('div.conn-metric-k', 'Last POS Sync'),
        h('div.conn-metric-v', isDemo ? 'Simulated' : shortAge(lsTele.lastSyncAt)),
        h('div.conn-metric-sub', 'Auto delta every 5m'))),
    h('div.conn-body',
      h('p.conn-summary', ls.detail || 'Syncs physical inventory by shop location, System IDs, UPCs, costs, and opt-in SALE PRICE updates during Online + Store POS promotions.'),
      h('div.conn-kv-list',
        h('span', h('strong', 'Locations: '), 'Tampa Showroom (#1) · Alafia River Park (#2)'),
        h('span', h('strong', 'Health Check: '), dateTime(ls.checkedAt))),
      !isDemo && canManage && ctx.api.lightspeedOAuthUrl ? h('details.conn-drawer',
        h('summary', 'OAuth Credentials & Token Authorization'),
        h('div.conn-drawer-body',
          h('button.btn.sm', {
            onclick: async () => {
              try {
                const out = await ctx.api.lightspeedOAuthUrl(false);
                if (out && out.url) window.location.href = out.url;
              } catch (err) {
                toast(err.message || 'Could not start Lightspeed OAuth', 'bad');
              }
            },
          }, ls.status === 'error' ? 'Reconnect Lightspeed OAuth' : 'Re-authorize Read-Only OAuth'),
          h('button.btn.sm', {
            onclick: async () => {
              const ok = await confirmDialog({
                title: 'Authorize Lightspeed Write Scopes?',
                message: 'Opens Lightspeed OAuth requesting employee:inventory and employee:customers so Bulk Sheet edits and Online + Store POS promotions can push directly to Lightspeed.',
                confirmLabel: 'Continue to Lightspeed',
              });
              if (!ok) return;
              try {
                const out = await ctx.api.lightspeedOAuthUrl(true);
                if (out && out.url) window.location.href = out.url;
              } catch (err) {
                toast(err.message || 'Could not start Lightspeed OAuth', 'bad');
              }
            },
          }, 'Authorize Write Scopes (Inventory + POS)'))) : null,
      ls.missing && ls.missing.length ? h('details.conn-drawer',
        h('summary', 'Server Environment Checklist (' + ls.missing.length + ')'),
        h('div.conn-drawer-body', ls.missing.map((m) => h('span.conn-scope-pill', m)))) : null),
    h('div.conn-foot',
      h('div.conn-actions',
        canCatalogWrite && ctx.api.syncLightspeed ? h('button.btn.sm.primary', {
          onclick: async (ev) => {
            const btn = ev.currentTarget;
            btn.disabled = true;
            try {
              const res = await ctx.api.syncLightspeed({});
              toast('Lightspeed POS delta sync started…', 'ok');
              if (res && res.jobId) await watchJob(ctx.api, res.jobId, { label: 'Lightspeed POS Sync' });
              refreshView();
            } catch (err) {
              toast(err.message || 'Could not start Lightspeed sync', 'bad');
              btn.disabled = false;
            }
          },
        }, 'Sync POS Now') : null,
        !isDemo && canManage && ctx.api.lightspeedSetMode ? h('button.btn.sm', {
          class: lsWritesOn ? 'btn sm danger' : 'btn sm',
          onclick: async () => {
            const nextPaused = lsWritesOn;
            const ok = await confirmDialog({
              title: nextPaused ? 'Switch Lightspeed to Read-Only?' : 'Enable Live Writes to Lightspeed POS?',
              message: nextPaused
                ? 'Pauses outbound edits from the Lightspeed Bulk Sheet and Online + Store POS promotions while keeping 5-minute inventory sync active.'
                : 'Allows authorized admins to push Bulk Sheet changes and Online + Store POS SALE PRICE updates to Lightspeed (with automatic Audit Log backup).',
              confirmLabel: nextPaused ? 'Switch to Read-Only' : 'Enable Live Writes',
            });
            if (!ok) return;
            try {
              await ctx.api.lightspeedSetMode(nextPaused);
              toast(nextPaused ? 'Lightspeed switched to Read-Only safety lock.' : 'Lightspeed Live Writes enabled.', 'ok');
              refreshView();
            } catch (err) {
              toast(err.message || 'Could not update Lightspeed write mode', 'bad');
            }
          },
        }, lsWritesOn ? 'Pause Writes' : 'Enable Live Writes') : null),
      h('a.btn.sm.ghost', { href: '#/lightspeed-sheet' }, 'Bulk Sheet →')));

  // ---------- Shopify Hero Card ----------
  const shWritesOn = !!sh.writesEnabled;
  const shCard = h('section.conn-card',
    h('div.conn-card-top',
      h('div.conn-brand',
        h('div.conn-mark.sh', 'SH'),
        h('div',
          h('div.conn-title', 'Shopify Online Store'),
          h('div.conn-role', 'Web Storefront · Products, Multi-Location Stock, Promos & Orders'))),
      h('div.conn-pills',
        statusPill(sh.status, isDemo),
        h('span.badge', { class: shWritesOn ? 'ok' : 'violet' }, shWritesOn ? 'Live Sync Active' : 'Read-Only'))),
    h('div.conn-metrics',
      h('div.conn-metric',
        h('div.conn-metric-k', 'Linked Variants'),
        h('div.conn-metric-v', isDemo ? 'Demo Seed' : fmtNum(shTele.linkedVariants)),
        h('div.conn-metric-sub', shTele.shopDomain || 'z5wxyn-uc.myshopify.com')),
      h('div.conn-metric',
        h('div.conn-metric-k', 'Price Guardrail'),
        h('div.conn-metric-v', isDemo ? 'Simulated' : shortAge(shTele.lastReconcileAt)),
        h('div.conn-metric-sub', 'MAP & Promo protection')),
      h('div.conn-metric',
        h('div.conn-metric-k', 'Store & Web Sync'),
        h('div.conn-metric-v', isDemo ? 'Simulated' : shortAge(shTele.lastTagSyncAt)),
        h('div.conn-metric-sub', 'Tags & Online Store publish'))),
    h('div.conn-body',
      h('p.conn-summary', parsedSh.cleanSummary || 'Publishes catalog items directly to Online Store, maintains 1-to-1 Tampa & Alafia inventory, enforces MAP/margin floors, and ingests order webhooks.'),
      h('div.conn-kv-list',
        h('span', h('strong', 'Webhooks: '), 'orders/create · orders/updated · orders/cancelled · products/create'),
        h('span', h('strong', 'Health Check: '), dateTime(sh.checkedAt))),
      parsedSh.scopes.length ? h('details.conn-drawer',
        h('summary', 'Authorized Admin API Scopes (' + parsedSh.scopes.length + ')'),
        h('div.conn-drawer-body', parsedSh.scopes.map((sc) => h('span.conn-scope-pill', sc)))) : null,
      sh.missing && sh.missing.length ? h('details.conn-drawer',
        h('summary', 'Server Environment Checklist (' + sh.missing.length + ')'),
        h('div.conn-drawer-body', sh.missing.map((m) => h('span.conn-scope-pill', m)))) : null),
    h('div.conn-foot',
      h('div.conn-actions',
        canCatalogWrite && ctx.api.flushPipeline ? h('button.btn.sm.primary', {
          onclick: async (ev) => {
            const btn = ev.currentTarget;
            btn.disabled = true;
            try {
              const res = await ctx.api.flushPipeline();
              toast('Flushing staged updates to Shopify…', 'ok');
              if (res && res.jobId) await watchJob(ctx.api, res.jobId, { label: 'Shopify Push' });
              refreshView();
            } catch (err) {
              toast(err.message || 'Could not flush pipeline', 'bad');
              btn.disabled = false;
            }
          },
        }, 'Push Ready Updates') : null,
        canCatalogWrite && ctx.api.runUpcMatch ? h('button.btn.sm', {
          onclick: async (ev) => {
            const btn = ev.currentTarget;
            btn.disabled = true;
            try {
              const res = await ctx.api.runUpcMatch();
              toast('Scanning UPC & SKU matches against Shopify…', 'ok');
              if (res && res.jobId) await watchJob(ctx.api, res.jobId, { label: 'UPC Match Scan' });
              refreshView();
            } catch (err) {
              toast(err.message || 'Could not start UPC match scan', 'bad');
              btn.disabled = false;
            }
          },
        }, 'Scan UPC Matches') : null),
      shTele.storeUrl
        ? h('a.btn.sm.ghost', { href: shTele.storeUrl, target: '_blank', rel: 'noopener' }, 'Open Storefront ↗')
        : h('a.btn.sm.ghost', { href: '#/upc-review' }, 'UPC Matches →')));

  // ---------- Distributor Cards (QBP, JBI, Specialized) ----------
  const supplierKeys = ['qbp', 'jbi', 'specialized'];
  const supplierCards = supplierKeys.map((sysKey) => {
    const raw = bySystem[sysKey] || { system: sysKey, status: 'not_connected', detail: '', missing: [] };
    const meta = SUPPLIER_META[sysKey];
    const stats = supByCode[sysKey] || { offers: 0, unmatched: 0, last_sync: null };
    const apiLive = raw.status === 'connected';
    return h('section.conn-card',
      h('div.conn-card-top',
        h('div.conn-brand',
          h('div.conn-mark', { class: 'conn-mark ' + meta.markClass }, meta.mark),
          h('div',
            h('div.conn-title', meta.title),
            h('div.conn-role', meta.role))),
        h('div.conn-pills',
          apiLive ? h('span.badge.ok', 'B2B API Live') : h('span.badge.ok', 'CSV / TSV Ready'),
          !apiLive ? h('span.badge', isDemo ? 'Demo Feed' : 'API Optional') : null)),
      h('div.conn-metrics.two',
        h('div.conn-metric',
          h('div.conn-metric-k', 'Catalog Offers'),
          h('div.conn-metric-v', fmtNum(stats.offers)),
          h('div.conn-metric-sub', stats.offers > 0 ? fmtNum(stats.offers - stats.unmatched) + ' matched to UBC' : 'Never summed with store')),
        h('div.conn-metric',
          h('div.conn-metric-k', 'Last Feed Sync'),
          h('div.conn-metric-v', stats.last_sync ? shortAge(stats.last_sync) : 'Ready'),
          h('div.conn-metric-sub', stats.last_sync ? dateTime(stats.last_sync) : 'Upload CSV/TSV anytime'))),
      h('div.conn-body',
        h('p.conn-summary', apiLive
          ? raw.detail
          : 'Dealer CSV/TSV price & availability sheets can be uploaded immediately in Vendor Catalogs. Direct B2B API polling activates automatically once credentials are added.'),
        raw.missing && raw.missing.length ? h('details.conn-drawer',
          h('summary', 'Optional Direct B2B API Keys (' + raw.missing.length + ')'),
          h('div.conn-drawer-body', raw.missing.map((m) => h('span.conn-scope-pill', m)))) : null),
      h('div.conn-foot',
        h('a.btn.sm', { href: '#/suppliers' }, 'Import CSV / TSV →'),
        h('a.btn.sm.ghost', { href: '#/purchasing' }, 'PO Drafts →')));
  });

  // ---------- Recent Sync & Omnichannel Operations Table ----------
  const liveRows = r.recentActivity || [];
  const demoRows = r.demoCalls || [];
  let activityBody;
  if (!isDemo && liveRows.length) {
    activityBody = dataTable({
      columns: [
        { key: 'when', label: 'When', render: (row) => h('span.nowrap', dateTime(row.created_at)) },
        {
          key: 'channel', label: 'System', render: (row) => {
            const info = ACTIVITY_LABELS[row.action] || ['System', row.action, ''];
            return h('span.badge', { class: info[2] }, info[0]);
          },
        },
        {
          key: 'event', label: 'Operation', render: (row) => {
            const info = ACTIVITY_LABELS[row.action] || ['System', row.action, ''];
            return h('strong', info[1]);
          },
        },
        { key: 'summary', label: 'Result Summary', render: (row) => h('span.small', summarizeAuditDetail(row.action, row.detail)) },
        { key: 'actor', label: 'Triggered By', opt: true, render: (row) => h('span.muted.small', row.actor || 'Auto Sync Worker') },
      ],
      rows: liveRows,
      rowKey: (row) => String(row.created_at) + row.action,
    });
  } else if (demoRows.length) {
    activityBody = dataTable({
      columns: [
        { key: 'at', label: 'When', render: (c) => dateTime(c.at) },
        { key: 'system', label: 'System', render: (c) => h('span.badge.info', c.system) },
        { key: 'op', label: 'Operation', render: (c) => h('code', c.op) },
        { key: 'detail', label: 'Detail', opt: true, render: (c) => h('code', JSON.stringify(c.detail).slice(0, 120)) },
      ],
      rows: demoRows,
      rowKey: (c) => c.at + c.op,
    });
  } else {
    activityBody = h('p.muted', 'No recent sync operations recorded yet. Trigger a POS sync, UPC scan, or promotion above to inspect live activity.');
  }

  const lsConnected = ls.status === 'connected';
  const shConnected = sh.status === 'connected';

  return h('div.stack',
    pageHead(
      'Settings & Sync · Connections',
      isDemo
        ? 'DEMO sandbox: connectors run safe local simulations while preserving full Shopify, Lightspeed R-Series, QBP, JBI & Specialized architecture.'
        : 'Live authenticated health, sync telemetry, write-safety controls, and distributor feeds across UBC physical stores and Shopify.',
      [
        h('button.btn', { onclick: refreshView }, 'Refresh Status'),
        h('a.btn.ghost', { href: '#/activity' }, 'Jobs & Error Log →'),
      ]
    ),
    settingsWorkspaceTabs('connections'),
    justReconnected ? h('div.notice.ok', 'Lightspeed Retail R-Series OAuth reconnected — background catalog delta sync has been queued.') : null,

    // Live Omnichannel Topology Ribbon
    h('section.conn-topo',
      h('div.conn-topo-head',
        h('span.conn-topo-kicker', 'Live Omnichannel Data Architecture'),
        h('div.row', { style: { gap: '10px' } }, [
          h('span.conn-topo-pill', { class: isDemo ? 'conn-topo-pill demo' : 'conn-topo-pill' },
            isDemo ? 'DEMO Sandbox Mode' : (lsConnected && shConnected ? 'All Retail Core Systems Online' : 'Check Connector Health')),
          h('span.conn-node-sub', 'Checked ' + dateTime(sh.checkedAt || ls.checkedAt)),
        ])),
      h('div.conn-topo-flow',
        h('div.conn-node',
          h('span.conn-pulse', { class: lsConnected ? 'conn-pulse' : 'conn-pulse warn' }),
          h('div',
            h('div.conn-node-title', 'Lightspeed Retail POS'),
            h('div.conn-node-sub', isDemo ? 'Demo Store Adapter' : 'Acct #' + (lsTele.accountId || '114391') + ' · ' + fmtNum(lsTele.inStockSkus) + ' in-stock SKUs'))),
        h('div.conn-bridge',
          h('span.conn-bridge-arrow', '⇄'),
          h('span', '5m Sync')),
        h('div.conn-node.hub',
          h('span.conn-pulse.gold'),
          h('div',
            h('div.conn-node-title', 'UBC Commerce Hub'),
            h('div.conn-node-sub', 'MAP Floor · Min Margin · Never-Sum Stock'))),
        h('div.conn-bridge',
          h('span.conn-bridge-arrow', '⇄'),
          h('span', '10m Sync')),
        h('div.conn-node',
          h('span.conn-pulse', { class: shConnected ? 'conn-pulse' : 'conn-pulse warn' }),
          h('div',
            h('div.conn-node-title', 'Shopify Online Store'),
            h('div.conn-node-sub', isDemo ? 'Demo Storefront' : fmtNum(shTele.linkedVariants) + ' linked variants · Online Store'))))),

    // Section 1: Core Retail Platforms
    h('div.conn-section-head',
      h('span.conn-kicker', 'Core Retail & Storefront Platforms'),
      h('span.conn-section-sub', 'Real-time physical store inventory, pricing guardrails & online storefront publishing')),
    h('div.conn-hero-grid', [lsCard, shCard]),

    // Section 2: Authorized B2B Distributors
    h('div.conn-section-head',
      h('span.conn-kicker', 'Authorized B2B Distributor Feeds'),
      h('span.conn-section-sub', 'Vendor availability is displayed separately as Special Order and never summed with physical UBC stock')),
    h('div.conn-sup-grid', supplierCards),

    // Section 3: Recent Operations
    card(
      'Recent Sync & Omnichannel Operations',
      activityBody,
      {
        flush: (!isDemo && !!liveRows.length) || !!demoRows.length,
        actions: h('a.btn.sm.ghost', { href: '#/activity' }, 'View All Jobs & Audit Log →'),
      }
    )
  );
}
