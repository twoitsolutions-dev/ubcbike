import { h, mount, clear } from '../ui/dom.js';
import { card, confirmDialog, dataTable, errorBox, loading, pageHead, pager, progressBar, toast, watchJob } from '../ui/components.js';
import { adjustmentLabel, campaignBadge, dateTime, LINE_STATUS, money, pct, REASON_LABELS } from '../ui/format.js';
import { cleanFilter, describeFilter, dollarsToCents, filterBar } from './common.js';
import { sessionStorageSafeGet } from './products.js';

export async function renderPromotions(ctx) {
  const r = await ctx.api.campaigns();
  return h('div.stack',
    pageHead('Promotions', 'Bulk price campaigns with MAP and margin protection, scheduling and safe restore',
      ctx.can('pricing.write') ? [h('a.btn.primary', { href: '#/promotions/new' }, 'New promotion')] : []),
    card(null, dataTable({
      columns: [
        { key: 'name', label: 'Campaign', cls: 'title-cell', render: (c) => h('div', h('a', { href: '#/promotions/' + c.id }, c.name), h('div.sku', describeFilter(c.selection || {}))) },
        { key: 'adj', label: 'Change', render: (c) => adjustmentLabel(c.adjustment) },
        { key: 'channel', label: 'Channel', opt: true, render: (c) => (c.channel === 'online' ? 'Online only' : 'Online + POS') },
        { key: 'items', label: 'Items', num: true, opt: true, render: (c) => (c.summary ? String((c.summary.ok || 0) + (c.summary.warning || 0)) + ' / ' + c.summary.total : '—') },
        { key: 'when', label: 'Schedule', opt: true, render: (c) => (c.starts_at ? dateTime(c.starts_at) : 'On approval') + ' → ' + (c.ends_at ? dateTime(c.ends_at) : 'manual end') },
        { key: 'status', label: 'Status', render: (c) => campaignBadge(c.status) },
      ],
      rows: r.campaigns,
      onRowClick: (c) => ctx.navigate('#/promotions/' + c.id),
      empty: 'No promotions yet. Create one to preview prices, margins and MAP before anything changes.',
    }), { flush: true }));
}

function toLocalInput(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

export async function renderPromotionNew(ctx) {
  if (!ctx.can('pricing.write')) return errorBox({ message: 'Your role cannot create promotions.' });
  const facets = await ctx.api.facets();
  const settings = await ctx.api.settings();
  let selection = { categories: ['Accessories'] };
  if (ctx.query.from === 'selection') {
    try { selection = JSON.parse(sessionStorageSafeGet('ubc-promo-selection') || '{}'); } catch (e) { selection = {}; }
  }
  const countHost = h('span.badge.info', '…');
  const updateCount = async () => {
    try {
      const r = await ctx.api.items(Object.assign({}, selection, { limit: 1 }));
      countHost.textContent = r.total.toLocaleString('en-US') + ' products match';
    } catch (e) { countHost.textContent = '—'; }
  };
  updateCount();

  const name = h('input', { type: 'text', value: 'Black Friday — ' + (selection.categories && selection.categories[0] ? selection.categories[0] : 'Selection'), maxlength: '120', required: true });
  const type = h('select', [['percent_off', 'Percentage off'], ['amount_off', 'Fixed amount off ($)'], ['percent_increase', 'Increase by %'], ['amount_increase', 'Increase by amount ($)'], ['set_price', 'Set a fixed price ($)']].map(([v, t]) => h('option', { value: v }, t)));
  const value = h('input', { type: 'number', inputmode: 'decimal', min: '0', step: 'any', value: '20' });
  const valueLabel = h('span', 'Discount (%)');
  type.addEventListener('change', () => { valueLabel.textContent = type.value.indexOf('percent') === 0 ? 'Percentage (%)' : 'Amount ($)'; });
  const rounding = h('select', [['none', 'No rounding'], ['charm_99', 'End in .99 (never rounds up)'], ['whole_dollar', 'Whole dollars']].map(([v, t]) => h('option', { value: v }, t)));
  const channel = h('select', [['online', 'Online store only (Shopify)'], ['online_and_pos', 'Online + in-store POS (Lightspeed)']].map(([v, t]) => h('option', { value: v }, t)));
  const minMargin = h('input', { type: 'number', min: '0', max: '95', step: '0.5', value: String(settings.campaignRules.minMarginPct * 100) });
  const warnMargin = h('input', { type: 'number', min: '0', max: '95', step: '0.5', value: String(settings.campaignRules.warnMarginPct * 100) });
  const clamp = h('input', { type: 'checkbox', checked: !!settings.campaignRules.clampToMinMargin });
  const start = h('input', { type: 'datetime-local' });
  const end = h('input', { type: 'datetime-local' });
  const posNote = h('div.notice.warn', { hidden: true }, 'Online + POS changes the in-store price in Lightspeed. In this phase POS writes are disabled for real systems; in DEMO they are simulated. Native Shopify discounts cannot be used for POS campaigns.');
  channel.addEventListener('change', () => { posNote.hidden = channel.value !== 'online_and_pos'; });
  const err = h('div');
  const submit = h('button.btn.primary', { type: 'submit' }, 'Preview impact');

  const form = h('form.stack', {
    onsubmit: async (e) => {
      e.preventDefault();
      clear(err);
      const isPct = type.value.indexOf('percent') === 0;
      const raw = Number(value.value);
      if (!(raw >= 0)) { err.appendChild(h('div.notice.bad', 'Enter a valid value.')); return; }
      if (type.value === 'percent_off' && raw >= 100) { err.appendChild(h('div.notice.bad', 'A discount must be below 100 %.')); return; }
      const adjustment = { type: type.value, value: isPct ? raw / 100 : dollarsToCents(value.value), rounding: rounding.value };
      const startsAt = start.value ? new Date(start.value).toISOString() : null;
      const endsAt = end.value ? new Date(end.value).toISOString() : null;
      if (startsAt && endsAt && endsAt <= startsAt) { err.appendChild(h('div.notice.bad', 'The end must be after the start.')); return; }
      submit.disabled = true;
      submit.textContent = 'Evaluating every product…';
      try {
        const r = await ctx.api.createCampaign({
          name: name.value.trim(), channel: channel.value, selection: cleanFilter(selection), adjustment,
          rules: { minMarginPct: Number(minMargin.value) / 100, warnMarginPct: Number(warnMargin.value) / 100, clampToMinMargin: clamp.checked },
          startsAt, endsAt,
        });
        ctx.navigate('#/promotions/' + r.id);
      } catch (ex) {
        submit.disabled = false;
        submit.textContent = 'Preview impact';
        err.appendChild(h('div.notice.bad', ex.message + (ex.details && Array.isArray(ex.details) ? ': ' + ex.details.map((d) => d.path + ' ' + d.message).join('; ') : '')));
      }
    },
  },
  card('1 · Which products', h('div.stack',
    h('div.row', h('span.small.muted', 'Combine categories, brands, suppliers, price, margin and stock. '), countHost),
    filterBar(facets, selection, (f) => { selection = f; updateCount(); }, { expanded: true })), { flush: true }),
  card('2 · Price change', h('div.form-grid',
    h('label.field', 'Campaign name', name),
    h('label.field', 'Type', type),
    h('label.field', valueLabel, value),
    h('label.field', 'Rounding', rounding),
    h('label.field', 'Where it applies', channel))),
  posNote,
  card('3 · Commercial rules', h('div.stack',
    h('div.form-grid',
      h('label.field', 'Minimum margin (%)', minMargin, h('span.help', 'Lines below this are blocked')),
      h('label.field', 'Warn below margin (%)', warnMargin)),
    h('label.check', clamp, 'Instead of blocking, raise prices to the minimum-margin price'),
    h('div.notice.info', 'MAP is a contractual floor: lines below MAP are always blocked. Only an authorised MAP exception recorded by an owner/admin (with vendor approval reference) can allow it — a confirmation click cannot.'))),
  card('4 · Schedule (optional)', h('div.form-grid',
    h('label.field', 'Start', start, h('span.help', 'Empty = start as soon as it is approved')),
    h('label.field', 'End', end, h('span.help', 'Empty = until restored manually')))),
  err,
  h('div.row', submit, h('a.btn', { href: '#/promotions' }, 'Cancel'), h('span.small.muted', 'Nothing changes until the preview is approved.')));

  const now = new Date();
  start.min = toLocalInput(now);
  return h('div.stack', pageHead('New promotion', 'Preview first: every affected product, old/new price, cost, margin, MAP, exclusions and warnings'), form);
}

export async function renderPromotionDetail(ctx) {
  const c = await ctx.api.campaign(ctx.params.id);
  const s = c.summary || { total: 0, ok: 0, warning: 0, blocked: 0, excluded: 0, revenueDeltaCents: 0 };
  const st = { status: s.blocked ? 'blocked' : null, offset: 0, limit: 50 };
  const linesHost = h('div', loading());
  const strip = h('div.summary-strip');
  const drawStrip = () => {
    clear(strip);
    [[null, 'All lines', s.total], ['ok', 'Will apply', s.ok], ['warning', 'With warnings', s.warning], ['blocked', 'Blocked (MAP / margin)', s.blocked], ['excluded', 'Excluded', s.excluded]].forEach(([k, label, n]) => {
      strip.appendChild(h('button', { type: 'button', class: st.status === k ? 'on' : '', onclick: () => { st.status = k; st.offset = 0; drawStrip(); loadLines(); } },
        h('div.label', label), h('div.value', { style: { color: k === 'blocked' && n ? 'var(--bad)' : k === 'warning' && n ? 'var(--warn)' : '' } }, String(n || 0))));
    });
  };
  const loadLines = async () => {
    mount(linesHost, loading());
    try {
      const r = await ctx.api.campaignLines(c.id, st.status || undefined, st.offset, st.limit);
      if (!ctx.isCurrent()) return;
      mount(linesHost, dataTable({
        columns: [
          { key: 'title', label: 'Product', cls: 'title-cell', render: (l) => h('div', h('a', { href: '#/products/' + l.variant_id }, l.title), h('div.sku', l.sku + ' · ' + l.brand)) },
          { key: 'old', label: 'Price before', num: true, render: (l) => money(l.old_price_cents) },
          { key: 'new', label: 'Price after', num: true, render: (l) => (l.status === 'excluded' ? h('span.muted', '—') : h('strong', money(l.new_price_cents))) },
          { key: 'cost', label: 'Cost', num: true, opt: true, render: (l) => money(l.cost_cents) },
          { key: 'om', label: 'Margin before', num: true, opt: true, render: (l) => pct(l.cost_cents === null ? null : (l.old_price_cents - l.cost_cents) / l.old_price_cents) },
          { key: 'nm', label: 'Margin after', num: true, render: (l) => (l.status === 'excluded' || l.cost_cents === null ? '—' : pct((l.new_price_cents - l.cost_cents) / l.new_price_cents)) },
          { key: 'map', label: 'MAP', num: true, opt: true, render: (l) => (l.map_cents ? money(l.map_cents) : '—') },
          { key: 'status', label: 'Result', render: (l) => {
            const v = LINE_STATUS[l.status];
            return h('div', h('span.badge', { class: v[1] }, v[0]), (l.reasons || []).length ? h('div.small.muted', l.reasons.map((x) => REASON_LABELS[x] || x).join(', ')) : null,
              l.restore_result ? h('div.small', { class: l.restore_result === 'restored' ? '' : 'muted' }, l.restore_result.replace(/_/g, ' ')) : null);
          } },
        ],
        rows: r.lines, rowKey: (l) => l.variant_id, empty: 'No lines in this group.',
      }), pager({ total: r.total, limit: st.limit, offset: st.offset, onPage: (o) => { st.offset = o; loadLines(); } }));
    } catch (e) { mount(linesHost, errorBox(e)); }
  };

  const jobHost = h('div');
  const runJob = async (jobId, label) => {
    const pb = progressBar();
    const lbl = h('span.small.muted', 'queued');
    mount(jobHost, h('div.notice.info', h('div', label + ' — ', lbl), pb.el));
    const job = await watchJob(ctx.api, jobId, pb.bar, lbl);
    if (job.status === 'succeeded') toast(label + ' finished', 'ok');
    else toast(label + ' failed: ' + job.last_error, 'bad');
    ctx.refreshBadges();
    ctx.navigate('#/promotions/' + c.id + '?r=' + Date.now());
  };

  const actions = [];
  if (c.status === 'draft') {
    if (ctx.can('pricing.write')) actions.push(h('button.btn', { onclick: async () => { await ctx.api.previewCampaign(c.id); toast('Preview refreshed with current data'); ctx.navigate('#/promotions/' + c.id + '?r=' + Date.now()); } }, 'Refresh preview'));
    if (ctx.can('campaign.approve')) {
      actions.push(h('button.btn.primary', {
        onclick: async () => {
          const ok = await confirmDialog({
            title: 'Approve “' + c.name + '”?',
            message: h('div.stack',
              h('p', (s.ok + s.warning).toLocaleString('en-US') + ' prices will change' + (c.starts_at && new Date(c.starts_at) > new Date() ? ' on ' + dateTime(c.starts_at) : ' now') + '. ' + s.blocked + ' blocked and ' + s.excluded + ' excluded lines will NOT be changed.'),
              h('p.small.muted', 'Method: ' + (c.strategy === 'shopify_automatic_discount' ? 'native Shopify automatic discount (product prices are not rewritten)' : 'variant price update (previous prices are kept for restore)') + '. Channel: ' + (c.channel === 'online' ? 'online only' : 'online + POS') + '.'),
              s.warning ? h('div.notice.warn', s.warning + ' lines have warnings (low margin, clamped price or MAP exception). Review them first if unsure.') : null),
            confirmLabel: 'Approve & schedule',
          });
          if (!ok) return;
          try {
            const r = await ctx.api.approveCampaign(c.id, s.previewToken);
            if (r.jobId) await runJob(r.jobId, 'Applying prices');
            else { toast('Scheduled', 'ok'); ctx.navigate('#/promotions/' + c.id + '?r=' + Date.now()); }
          } catch (e) {
            if (e.code === 'PREVIEW_STALE') { toast('Prices changed since this preview — showing the refreshed preview.', 'bad'); await ctx.api.previewCampaign(c.id); ctx.navigate('#/promotions/' + c.id + '?r=' + Date.now()); }
            else toast(e.message, 'bad');
          }
        },
      }, 'Approve & schedule'));
    }
  }
  if ((c.status === 'draft' || c.status === 'scheduled') && ctx.can('pricing.write')) {
    actions.push(h('button.btn.danger', { onclick: async () => { if (await confirmDialog({ title: 'Cancel campaign?', message: 'No prices will be changed.', confirmLabel: 'Cancel campaign', danger: true })) { await ctx.api.cancelCampaign(c.id); ctx.navigate('#/promotions'); } } }, 'Cancel'));
  }
  if (c.status === 'active' && ctx.can('pricing.write')) {
    actions.push(h('button.btn.danger', {
      onclick: async () => {
        const ok = await confirmDialog({ title: 'Restore original prices?', message: 'Each product returns to its pre-campaign price — except products whose price was changed by someone after the campaign started; those keep the newer price and are reported as “skipped changed”.', confirmLabel: 'Restore prices', danger: true });
        if (!ok) return;
        try { const r = await ctx.api.restoreCampaign(c.id); await runJob(r.jobId, 'Restoring prices'); } catch (e) { toast(e.message, 'bad'); }
      },
    }, 'Restore original prices'));
  }
  actions.push(h('button.btn', {
    onclick: async () => {
      const csv = await ctx.api.exportCampaign(c.id);
      const blob = new Blob([csv], { type: 'text/csv' });
      const a = h('a', { href: URL.createObjectURL(blob), download: 'campaign-' + c.name.replace(/\W+/g, '_') + '.csv' });
      document.body.appendChild(a); a.click(); a.remove();
    },
  }, 'Export CSV'));

  drawStrip();
  loadLines();
  return h('div.stack',
    pageHead(c.name, null, [h('a.btn', { href: '#/promotions' }, '← Promotions')].concat(actions)),
    h('div.row', campaignBadge(c.status), h('span.badge', adjustmentLabel(c.adjustment)), h('span.badge', c.channel === 'online' ? 'Online only' : 'Online + POS'),
      h('span.badge.info', c.strategy === 'shopify_automatic_discount' ? 'Native Shopify discount' : 'Variant price update'),
      h('span.small.muted', 'Selection: ' + describeFilter(c.selection || {}) + ' · Min. margin ' + pct(c.rules && c.rules.minMarginPct, 0) + ' · ' + (c.starts_at ? dateTime(c.starts_at) : 'starts on approval') + ' → ' + (c.ends_at ? dateTime(c.ends_at) : 'manual end'))),
    s.applied !== undefined ? h('div.notice.ok', 'Applied to ' + s.applied + ' products' + (s.skippedChanged ? '; ' + s.skippedChanged + ' skipped because their price changed after the preview' : '') + '.') : null,
    jobHost,
    strip,
    h('div.small.muted', 'Revenue impact at current prices (applicable lines, one unit each): ' + money(s.revenueDeltaCents)),
    h('section.card', linesHost));
}
