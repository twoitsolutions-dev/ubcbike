import { h, icon, mount } from '../ui/dom.js';
import { card, chips, confirmDialog, dataTable, errorBox, loading, pageHead, toast, watchJob } from '../ui/components.js';
import { ago, dateTime, money, pct } from '../ui/format.js';
import { vendorCatalogTabs } from './suppliers.js?v=86';

const HOLD_LABELS = {
  map_above_published_price: 'MAP exceeds published Shopify price',
  margin_below_minimum: 'Margin below minimum floor',
  unlicensed_content: 'Content license not authorized',
  unmatched_identity: 'Unmatched product identity',
};

const STREAM_LABELS = {
  availability: 'Availability (15–30m)',
  costs: 'Costs & MAP (6–12h)',
  content: 'Content & Images (24h)',
  full_catalog: 'Full Catalog (event)',
};

const WATCHDOG_BADGE = {
  healthy: ['Healthy', 'ok'],
  stalled: ['Silent / Stalled', 'bad'],
  never_synced: ['Awaiting first feed', 'warn'],
  disabled: ['Disabled', ''],
};

const DECISION_BADGE = {
  ready_for_shopify: ['Ready for Shopify', 'ok'],
  held_for_review: ['Held for review', 'bad'],
};

const STAGE_STATUS_BADGE = {
  pending: ['Queued', 'info'],
  held: ['Quarantined', 'bad'],
  pushed: ['Pushed to Shopify', 'ok'],
  dismissed: ['Dismissed', ''],
};

export async function renderPipeline(ctx) {
  const wrap = h('div.stack', loading('Loading Intermediary Pipeline…'));
  let decisionFilter = '';

  const canWritePricing = ctx.can('pricing.write');
  const canManageIntegrations = ctx.can('integrations.manage');

  async function refresh() {
    try {
      const [status, stagingRes, historyRes] = await Promise.all([
        ctx.api.pipelineStatus(),
        ctx.api.pipelineStaging(decisionFilter ? { decision: decisionFilter, limit: 100 } : { limit: 100 }),
        ctx.api.pipelineHistory({ limit: 50 }),
      ]);

      const actions = [];
      if (canManageIntegrations) {
        actions.push(
          h('button.btn', {
            onclick: async () => {
              try {
                toast('Syncing catalog from Shopify (read-only)…');
                const res = await ctx.api.syncShopify();
                if (res && res.jobId) {
                  await watchJob(ctx.api, res.jobId);
                }
                toast('Shopify catalog synchronized.', 'ok');
                refresh();
              } catch (err) {
                toast(err.message || String(err), 'bad');
              }
            },
          }, icon('refresh'), ' Sync from Shopify'),
          h('button.btn', {
            onclick: async () => {
              try {
                toast('Syncing physical POS items & stock from Lightspeed R-Series…');
                const res = await ctx.api.syncLightspeed({ full: false });
                if (res && res.jobId) {
                  const j = await watchJob(ctx.api, res.jobId);
                  if (j && j.result && j.result.status === 'awaiting_oauth_credentials') {
                    toast('Lightspeed R-Series ready — awaiting UBC OAuth token in Settings & Sync.', 'info');
                  } else {
                    toast('Lightspeed POS stock synchronized.', 'ok');
                  }
                }
                refresh();
              } catch (err) {
                toast(err.message || String(err), 'bad');
              }
            },
          }, icon('refresh'), ' Sync Lightspeed POS'),
          h('button.btn', {
            onclick: async () => {
              try {
                const res = await ctx.api.setupShopifyCollections();
                const total = ((res.created && res.created.length) || 0) + ((res.existing && res.existing.length) || 0);
                toast('Shopify Smart Collections verified (' + total + ' cycling collections active).', 'ok');
              } catch (err) {
                toast(err.message || String(err), 'bad');
              }
            },
          }, 'Smart Collections'),
          h('button.btn', {
            onclick: async () => {
              try {
                const res = await ctx.api.runWatchdog();
                toast('Watchdog checked — alerts raised: ' + (res.alertsRaised || 0), 'ok');
                refresh();
              } catch (err) {
                toast(err.message || String(err), 'bad');
              }
            },
          }, 'Run Watchdog'),
          h('button.btn.primary', {
            onclick: async () => {
              const ok = await confirmDialog({
                title: 'Flush Ready Staging Buffer to Shopify',
                message: 'Push all validated (Ready for Shopify) products, availability & metafield updates now? Quarantined MAP/margin items stay held. Large batches (up to 40,000+ SKUs) self-chain automatically.',
                confirmLabel: 'Flush Buffer',
              });
              if (!ok) return;
              try {
                const res = await ctx.api.flushPipeline();
                if (res && res.jobId) await watchJob(ctx.api, res.jobId);
                toast('Pipeline flush completed.', 'ok');
                refresh();
              } catch (err) {
                toast(err.message || String(err), 'bad');
              }
            },
          }, 'Flush Ready to Shopify'),
        );
      }

      const byStatusCount = {};
      (status.stagingSummary || []).forEach((s) => {
        byStatusCount[s.status] = (byStatusCount[s.status] || 0) + s.n;
      });

      const schedulesBySupplier = {};
      (status.schedules || []).forEach((sc) => {
        if (!schedulesBySupplier[sc.supplier_code]) schedulesBySupplier[sc.supplier_code] = [];
        schedulesBySupplier[sc.supplier_code].push(sc);
      });

      const SUPPLIER_NAMES = {
        JBI: 'J&B Importers',
        QBP: 'Quality Bicycle Products',
        SPECIALIZED: 'Specialized Bicycle Components',
      };
      const watchdogCards = (status.watchdog || []).map((w) => {
        const wb = WATCHDOG_BADGE[w.status] || [w.status, ''];
        const code = w.supplierCode || w.supplier_code || '';
        const name = w.supplierName || w.supplier_name || w.name || SUPPLIER_NAMES[code] || code;
        const scheds = schedulesBySupplier[code] || [];
        return h('section.card', h('div.card-body', h('div.stack',
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' } },
            h('strong', name && name !== code ? name + ' (' + code + ')' : code),
            h('span.badge', { class: wb[1] }, wb[0])),
          h('div.small.muted', w.message),
          h('div.small', scheds.map((sc) => h('div', { style: { display: 'flex', justifyContent: 'space-between', padding: '2px 0' } },
            h('span.muted', STREAM_LABELS[sc.stream] || sc.stream),
            h('span', sc.last_success_at ? ago(sc.last_success_at) : 'never')))))));
      });

      const filterBar = chips(
        [
          { value: 'held_for_review', label: 'Held for review · ' + (byStatusCount.held || 0) },
          { value: 'ready_for_shopify', label: 'Ready for Shopify · ' + ((byStatusCount.pending || 0) + (byStatusCount.pushed || 0)) },
        ],
        decisionFilter ? [decisionFilter] : [],
        (vals) => {
          decisionFilter = vals.length ? vals[vals.length - 1] : '';
          refresh();
        },
      );

      const stagingTable = dataTable({
        empty: 'No items in the outbound staging buffer yet. Import a supplier feed to inspect staged changes.',
        rowKey: (r) => r.id,
        rows: stagingRes.staged || [],
        columns: [
          {
            key: 'title',
            label: 'Product / Variant',
            render: (r) => h('div',
              h('a', { href: '#/products/' + r.variant_id }, h('strong', r.title)),
              h('div.small.muted', 'SKU: ' + r.sku + ' · ' + (STREAM_LABELS[r.stream] || r.stream))),
          },
          {
            key: 'decision',
            label: 'Buffer Decision',
            render: (r) => {
              const db = DECISION_BADGE[r.decision] || [r.decision, ''];
              const sb = STAGE_STATUS_BADGE[r.status] || [r.status, ''];
              const holds = Array.isArray(r.hold_reasons) ? r.hold_reasons : [];
              return h('div',
                h('span.badge', { class: db[1] }, db[0]), ' ',
                h('span.badge', { class: sb[1] }, sb[0]),
                holds.length ? h('div.small.bad', holds.map((hr) => HOLD_LABELS[hr] || hr).join('; ')) : null);
            },
          },
          {
            key: 'payload',
            label: 'Clean Shopify Output',
            opt: true,
            render: (r) => {
              const p = r.shopify_payload || {};
              return h('div.small',
                h('code', (p.availability || 'unavailable') + ' · qty=' + (p.publishedQty || 0) + (p.leadTimeDays ? ' · ' + p.leadTimeDays + 'd' : '')),
                p.clickAndCollectOnly ? h('div', h('span.badge.violet', 'In-Store Pickup Only')) : null);
            },
          },
          {
            key: 'updated_at',
            label: 'Updated',
            opt: true,
            render: (r) => dateTime(r.updated_at),
          },
          {
            key: 'actions',
            label: 'Actions',
            render: (r) => {
              if (!canWritePricing || r.status === 'pushed' || r.status === 'dismissed') return h('span.muted', '—');
              return h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
                r.status === 'held' ? h('button.btn.sm', {
                  onclick: async () => {
                    const ok = await confirmDialog({
                      title: 'Release Held Item to Outbound Queue',
                      message: 'Approve "' + r.title + '" for outbound sync to Shopify? Ensure retail price or MAP exception has been verified first.',
                      confirmLabel: 'Release to Queue',
                    });
                    if (!ok) return;
                    try {
                      await ctx.api.resolveStaging(r.id, 'release', 'Operator approved from Pipeline UI');
                      toast('Item released to Ready queue.', 'ok');
                      refresh();
                    } catch (err) {
                      toast(err.message || String(err), 'bad');
                    }
                  },
                }, 'Release') : null,
                h('button.btn.sm.ghost', {
                  onclick: async () => {
                    try {
                      await ctx.api.resolveStaging(r.id, 'dismiss', 'Dismissed by operator');
                      toast('Staging entry dismissed.');
                      refresh();
                    } catch (err) {
                      toast(err.message || String(err), 'bad');
                    }
                  },
                }, 'Dismiss'));
            },
          },
        ],
      });

      const historyTable = dataTable({
        empty: 'No supplier cost, MAP or availability deltas recorded yet.',
        rowKey: (r) => r.id,
        rows: historyRes.history || [],
        columns: [
          { key: 'recorded_at', label: 'When', render: (r) => dateTime(r.recorded_at) },
          {
            key: 'supplier_code',
            label: 'Supplier / SKU',
            render: (r) => h('div', h('strong', r.supplier_code + ' · ' + r.supplier_sku), r.variant_title ? h('div.small.muted', r.variant_title) : h('div.small.muted', 'Unlinked offer')),
          },
          {
            key: 'change_types',
            label: 'Changes',
            render: (r) => {
              const list = Array.isArray(r.change_types) ? r.change_types : [];
              return h('div', list.map((c) => h('span.badge.info', { style: { marginRight: '4px' } }, c.replace(/_/g, ' '))));
            },
          },
          {
            key: 'cost',
            label: 'Cost Delta',
            num: true,
            render: (r) => (r.old_cost_cents !== null ? money(r.old_cost_cents) : 'initial') + ' → ' + money(r.new_cost_cents),
          },
          {
            key: 'map',
            label: 'MAP Delta',
            num: true,
            opt: true,
            render: (r) => r.new_map_cents ? ((r.old_map_cents ? money(r.old_map_cents) + ' → ' : '') + money(r.new_map_cents)) : '—',
          },
          {
            key: 'shopify_published_price_cents',
            label: 'Shopify Price Snapshot',
            num: true,
            opt: true,
            render: (r) => r.shopify_published_price_cents ? money(r.shopify_published_price_cents) + (r.resulting_margin_bps !== null ? ' (' + pct(r.resulting_margin_bps / 10000, 1) + ')' : '') : '—',
          },
        ],
      });

      const runsTable = dataTable({
        empty: 'No supplier sync runs recorded yet.',
        rowKey: (r) => r.id,
        rows: status.recentRuns || [],
        columns: [
          { key: 'started_at', label: 'Started', render: (r) => dateTime(r.started_at) },
          { key: 'supplier_code', label: 'Supplier', render: (r) => h('strong', r.supplier_code) },
          { key: 'stream', label: 'Stream', render: (r) => STREAM_LABELS[r.stream] || r.stream },
          {
            key: 'status',
            label: 'Status',
            render: (r) => h('span.badge', { class: r.status === 'succeeded' ? 'ok' : r.status === 'failed' ? 'bad' : 'info' }, r.status),
          },
          { key: 'records_seen', label: 'Seen', num: true },
          { key: 'records_changed', label: 'Versioned', num: true },
          { key: 'staged_ready', label: 'Ready', num: true },
          { key: 'staged_held', label: 'Held (MAP/Margin)', num: true },
        ],
      });

      mount(wrap,
        pageHead(
          'Vendor Catalogs · Feed Sync',
          'Reviews incoming distributor feeds (QBP, JBI, Specialized) and quarantines MAP/margin conflicts before updates reach Shopify.',
          actions,
        ),
        vendorCatalogTabs('sync'),
        h('div.flow-steps',
          h('div.flow-step', h('span.step-badge', '1'), h('div', h('strong', 'Vendor Feeds Arrive'), h('span', 'Costs, MAP & availability normalized automatically'))),
          h('div.flow-step', h('span.step-badge', '2'), h('div', h('strong', 'MAP & Margin Quarantine'), h('span', 'Violations pause here instead of breaking live prices'))),
          h('div.flow-step', h('span.step-badge', '3'), h('div', h('strong', 'Clean Sync to Shopify'), h('span', 'Approved items update online stock & lead times')))),
        h('div.grid.grid-3', watchdogCards),
        card('Staging Queue (Pending & Quarantined Items)', h('div.stack', filterBar, stagingTable)),
        card('Recent Vendor Cost & MAP Changes', historyTable, { flush: (historyRes.history || []).length > 0 }),
        card('Recent Feed Sync Runs', runsTable, { flush: (status.recentRuns || []).length > 0 }),
      );
    } catch (err) {
      mount(wrap, pageHead('Vendor Catalogs · Feed Sync'), vendorCatalogTabs('sync'), errorBox(err));
    }
  }

  refresh();
  return wrap;
}
