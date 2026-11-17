import { h, mount, clear, debounce } from '../ui/dom.js';
import { card, chips, confirmDialog, dataTable, errorBox, loading, pageHead, pager, progressBar, toast, watchJob } from '../ui/components.js';
import { adjustmentLabel, campaignBadge, channelBadge, dateTime, LINE_STATUS, money, pct, POS_EVENT_LABELS, REASON_LABELS } from '../ui/format.js';
import { cleanFilter, describeFilter, dollarsToCents } from './common.js?v=40';
import { sessionStorageSafeGet } from './products.js?v=40';

const PRESETS = {
  online: { key: 'online', kicker: 'Everyday Web Promo', title: 'Online Promo', sub: '15% off · Online Store Only', name: 'Online Sale', channel: 'online', event: null, pct: 15, rounding: 'none', featured: true },
  black_friday: { key: 'black_friday', kicker: 'Omnichannel Event', title: 'Black Friday', sub: '20% off (.99) · Online + Store POS', name: 'Black Friday', channel: 'online_and_pos', event: 'black_friday', pct: 20, rounding: 'charm_99' },
  christmas: { key: 'christmas', kicker: 'Omnichannel Event', title: 'Holiday / Christmas', sub: '15% off (.99) · Online + Store POS', name: 'Holiday Sale', channel: 'online_and_pos', event: 'christmas', pct: 15, rounding: 'charm_99' },
  clearance: { key: 'clearance', kicker: 'Omnichannel Event', title: 'Clearance Event', sub: '25% off (Whole $) · Online + Store POS', name: 'Annual Clearance', channel: 'online_and_pos', event: 'annual_clearance', pct: 25, rounding: 'whole_dollar' },
};

export async function renderPromotions(ctx) {
  const r = await ctx.api.campaigns();
  const all = r.campaigns || [];
  let tab = 'all';
  const tableHost = h('div');
  const tabsHost = h('div.seg-group');

  const counts = {
    all: all.length,
    live: all.filter((c) => ['active', 'scheduled', 'applying', 'restoring'].indexOf(c.status) >= 0).length,
    draft: all.filter((c) => c.status === 'draft').length,
    past: all.filter((c) => ['restored', 'cancelled', 'failed'].indexOf(c.status) >= 0).length,
  };

  const filterRows = () => {
    if (tab === 'live') return all.filter((c) => ['active', 'scheduled', 'applying', 'restoring'].indexOf(c.status) >= 0);
    if (tab === 'draft') return all.filter((c) => c.status === 'draft');
    if (tab === 'past') return all.filter((c) => ['restored', 'cancelled', 'failed'].indexOf(c.status) >= 0);
    return all;
  };

  const drawTabs = () => {
    clear(tabsHost);
    [
      ['all', 'All (' + counts.all + ')'],
      ['live', 'Active & Scheduled (' + counts.live + ')'],
      ['draft', 'Drafts (' + counts.draft + ')'],
      ['past', 'Past (' + counts.past + ')'],
    ].forEach(([k, label]) => {
      tabsHost.appendChild(h('button.seg-btn', {
        type: 'button', class: tab === k ? 'on' : '',
        onclick: () => { tab = k; drawTabs(); drawTable(); },
      }, label));
    });
  };

  const drawTable = () => {
    mount(tableHost, dataTable({
      columns: [
        { key: 'name', label: 'Promotion', cls: 'title-cell', render: (c) => h('div', h('a', { href: '#/promotions/' + c.id }, h('strong', c.name)), h('div.sku', describeFilter(c.selection || {}))) },
        { key: 'adj', label: 'Price change', render: (c) => h('span.badge.info', adjustmentLabel(c.adjustment)) },
        { key: 'channel', label: 'Where it applies', opt: true, render: (c) => channelBadge(c.channel, c.summary) },
        { key: 'items', label: 'Products', num: true, opt: true, render: (c) => (c.summary ? String((c.summary.ok || 0) + (c.summary.warning || 0)) + ' of ' + c.summary.total : '—') },
        { key: 'when', label: 'Timing', opt: true, render: (c) => (c.starts_at ? dateTime(c.starts_at) : 'Immediate') + ' → ' + (c.ends_at ? dateTime(c.ends_at) : 'Until restored') },
        { key: 'status', label: 'Status', render: (c) => campaignBadge(c.status) },
      ],
      rows: filterRows(),
      onRowClick: (c) => ctx.navigate('#/promotions/' + c.id),
      empty: tab === 'all'
        ? 'No promotions yet. Pick a template above or click "New promotion" to preview discounted prices safely before anything changes.'
        : 'No promotions in this view.',
    }));
  };

  drawTabs();
  drawTable();

  const quickTemplates = ctx.can('pricing.write')
    ? h('div.stack-sm',
      h('div.row-between', h('h2', 'Quick-start templates'), h('span.small.muted', '1 click to pre-fill — you always preview every price before publishing')),
      h('div.quick-grid', Object.keys(PRESETS).map((k) => {
        const p = PRESETS[k];
        return h('a.quick-card', { href: '#/promotions/new?preset=' + p.key, class: p.featured ? 'featured' : '' },
          h('span.quick-kicker', p.kicker),
          h('span.quick-title', p.title),
          h('span.quick-sub', p.sub));
      })))
    : null;

  return h('div.stack',
    pageHead('Promotions / Price Rules', 'Create online sales or storewide events in 3 simple steps — MAP & minimum margin are protected automatically, and original prices can be restored in one click.',
      ctx.can('pricing.write') ? [h('a.btn.primary', { href: '#/promotions/new' }, 'New promotion')] : []),
    quickTemplates,
    card('Price Rules & Campaigns', tableHost, { flush: true, actions: tabsHost }));
}

function toLocalInput(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function computeSamplePriceCents(sampleCents, adjType, rawVal, rounding) {
  const v = Number(rawVal);
  if (!(v >= 0) || isNaN(v)) return null;
  let next = sampleCents;
  if (adjType === 'percent_off') {
    if (v >= 100) return null;
    next = Math.round(sampleCents * (1 - v / 100));
  } else if (adjType === 'amount_off') {
    next = sampleCents - Math.round(v * 100);
  } else if (adjType === 'set_price') {
    next = Math.round(v * 100);
  } else if (adjType === 'percent_increase') {
    next = Math.round(sampleCents * (1 + v / 100));
  } else if (adjType === 'amount_increase') {
    next = sampleCents + Math.round(v * 100);
  }
  if (next <= 0) return null;
  if (rounding === 'charm_99') {
    const whole = Math.floor(next / 100) * 100 + 99;
    next = whole > next ? Math.max(99, whole - 100) : whole;
  } else if (rounding === 'whole_dollar') {
    next = Math.floor(next / 100) * 100;
  }
  return next > 0 ? next : null;
}

export async function renderPromotionNew(ctx) {
  if (!ctx.can('pricing.write')) return errorBox({ message: 'Your role cannot create promotions.' });
  const [facets, settings] = await Promise.all([ctx.api.facets(), ctx.api.settings()]);

  let selection = { categories: ['Accessories & Gear'] };
  let scopeMode = 'category';
  if (ctx.query.from === 'selection') {
    try { selection = JSON.parse(sessionStorageSafeGet('ubc-promo-selection') || '{}'); } catch (e) { selection = {}; }
    if (selection.ids && selection.ids.length) scopeMode = 'selected';
    else if (selection.brands && selection.brands.length && (!selection.categories || !selection.categories.length)) scopeMode = 'brand';
    else if (!selection.categories || !selection.categories.length) scopeMode = 'all';
  }

  const st = {
    channel: 'online',
    posEventType: 'black_friday',
    adjType: 'percent_off',
    value: '20',
    rounding: 'none',
    scheduleMode: 'immediate',
    presetKey: ctx.query.preset && PRESETS[ctx.query.preset] ? ctx.query.preset : null,
    customName: false,
  };

  if (st.presetKey) {
    const pr = PRESETS[st.presetKey];
    st.channel = pr.channel;
    if (pr.event) st.posEventType = pr.event;
    st.value = String(pr.pct);
    st.rounding = pr.rounding;
  }

  const defaultNameForState = () => {
    const base = st.presetKey && PRESETS[st.presetKey] ? PRESETS[st.presetKey].name : (st.channel === 'online_and_pos' ? (POS_EVENT_LABELS[st.posEventType] || 'Store Event').split('/')[0].trim() : 'Online Promo');
    const suffix = describeFilter(selection);
    return base + ' — ' + suffix;
  };

  const nameInput = h('input', {
    type: 'text', value: defaultNameForState(), maxlength: '120', required: true, id: 'promo-name',
    oninput: () => { st.customName = true; renderSummary(); },
  });
  const syncAutoName = () => {
    if (!st.customName) nameInput.value = defaultNameForState();
  };

  const countBadge = h('span.badge.info', 'Counting…');
  let matchedCount = null;
  const updateCount = async () => {
    try {
      const r = await ctx.api.items(Object.assign({}, cleanFilter(selection), { limit: 1 }));
      matchedCount = r.total;
      countBadge.textContent = r.total.toLocaleString('en-US') + ' products match';
      renderSummary();
    } catch (e) {
      countBadge.textContent = '—';
    }
  };
  const updateCountDebounced = debounce(updateCount, 220);

  // --- Preset Strip ---
  const presetHost = h('div.quick-grid');
  const drawPresets = () => {
    clear(presetHost);
    Object.keys(PRESETS).forEach((k) => {
      const p = PRESETS[k];
      presetHost.appendChild(h('button.quick-card', {
        type: 'button',
        class: st.presetKey === k ? 'active' : '',
        onclick: () => {
          st.presetKey = k;
          st.channel = p.channel;
          if (p.event) st.posEventType = p.event;
          st.adjType = 'percent_off';
          st.value = String(p.pct);
          valueInput.value = st.value;
          st.rounding = p.rounding;
          st.customName = false;
          syncAutoName();
          drawPresets();
          drawChannel();
          drawAdj();
          drawRounding();
          renderExample();
          renderSummary();
        },
      }, h('span.quick-kicker', p.kicker), h('span.quick-title', p.title), h('span.quick-sub', p.sub)));
    });
  };

  // --- Step 1: Channel & Product Scope ---
  const channelHost = h('div.stack-sm');
  const drawChannel = () => {
    clear(channelHost);
    const cards = h('div.choice-grid',
      h('button.choice-card', {
        type: 'button', class: st.channel === 'online' ? 'on' : '',
        onclick: () => { st.channel = 'online'; syncAutoName(); drawChannel(); renderSummary(); },
      },
      h('div.choice-title', h('span', 'Online Store Only'), h('span.choice-dot')),
      h('div.choice-desc', 'Applies to Shopify online store. In-store Lightspeed POS register prices stay untouched.')),
      h('button.choice-card', {
        type: 'button', class: st.channel === 'online_and_pos' ? 'on' : '',
        onclick: () => { st.channel = 'online_and_pos'; syncAutoName(); drawChannel(); renderSummary(); },
      },
      h('div.choice-title', h('span', 'Online + Physical Store POS'), h('span.choice-dot')),
      h('div.choice-desc', 'Matches event prices on both Shopify and in-store Lightspeed registers, then restores both.')));

    channelHost.appendChild(cards);
    if (st.channel === 'online_and_pos') {
      const evChips = h('div.chips', Object.keys(POS_EVENT_LABELS).map((k) => h('button.chip', {
        type: 'button', class: st.posEventType === k ? 'on' : '',
        onclick: () => { st.posEventType = k; syncAutoName(); drawChannel(); renderSummary(); },
      }, POS_EVENT_LABELS[k])));
      channelHost.appendChild(h('div.stack-sm',
        h('label.field', 'Select Special Event', evChips),
        h('div.notice.warn', 'Omnichannel Event Mode: synchronizes prices across Shopify and Lightspeed R-Series POS for the event duration.')));
    }
  };

  const scopeTabsHost = h('div.seg-group');
  const scopeBodyHost = h('div');
  const advWrap = h('div.stack-sm', { hidden: true });
  let advOpen = false;
  const advBtn = h('button.btn.sm.ghost', {
    type: 'button',
    onclick: () => {
      advOpen = !advOpen;
      advWrap.hidden = !advOpen;
      advBtn.textContent = advOpen ? 'Hide extra filters ▴' : '+ Extra filters (keyword, stock, supplier, price range)';
    },
  }, '+ Extra filters (keyword, stock, supplier, price range)');

  const rebuildAdvFilters = () => {
    clear(advWrap);
    const qInput = h('input', {
      type: 'search', placeholder: 'Keyword, SKU, UPC or MPN…', value: selection.q || '',
      oninput: (e) => { selection.q = e.target.value || undefined; syncAutoName(); updateCountDebounced(); },
    });
    const stockSel = h('select', {
      onchange: (e) => { selection.stock = e.target.value || undefined; syncAutoName(); updateCount(); },
    }, [['', 'Any availability'], ['physical', 'In stock at UBC store'], ['virtual_only', 'Supplier special-order only'], ['unavailable', 'Unavailable']].map(([v, t]) => h('option', { value: v, selected: (selection.stock || '') === v }, t)));
    const supChips = chips(facets.suppliers.map((s) => ({ value: s.value, label: s.value })), selection.suppliers, (v) => { selection.suppliers = v; syncAutoName(); updateCount(); });
    const minPrice = h('input', {
      type: 'number', inputmode: 'decimal', min: '0', step: 'any', placeholder: '0', value: selection.priceMinCents === undefined ? '' : String(selection.priceMinCents / 100),
      oninput: (e) => { selection.priceMinCents = dollarsToCents(e.target.value); updateCountDebounced(); },
    });
    const maxPrice = h('input', {
      type: 'number', inputmode: 'decimal', min: '0', step: 'any', placeholder: 'Any', value: selection.priceMaxCents === undefined ? '' : String(selection.priceMaxCents / 100),
      oninput: (e) => { selection.priceMaxCents = dollarsToCents(e.target.value); updateCountDebounced(); },
    });
    advWrap.appendChild(h('div.form-grid',
      h('label.field', 'Search keyword / SKU', qInput),
      h('label.field', 'Availability', stockSel),
      h('label.field', 'Min current price ($)', minPrice),
      h('label.field', 'Max current price ($)', maxPrice)));
    if (facets.suppliers && facets.suppliers.length) {
      advWrap.appendChild(h('label.field', 'Filter by supplier', supChips));
    }
  };

  const drawScope = () => {
    clear(scopeTabsHost);
    const modes = [
      ['category', 'By Category'],
      ['all', 'All Products'],
      ['brand', 'By Brand'],
    ];
    if (selection.ids && selection.ids.length) modes.unshift(['selected', 'Selected Products (' + selection.ids.length + ')']);
    modes.forEach(([m, label]) => {
      scopeTabsHost.appendChild(h('button.seg-btn', {
        type: 'button', class: scopeMode === m ? 'on' : '',
        onclick: () => {
          scopeMode = m;
          if (m === 'all') { delete selection.categories; delete selection.brands; delete selection.ids; }
          if (m === 'category') { delete selection.ids; if (!selection.categories || !selection.categories.length) selection.categories = facets.categories[0] ? [facets.categories[0].value] : []; }
          if (m === 'brand') { delete selection.ids; delete selection.categories; }
          syncAutoName();
          drawScope();
          updateCount();
        },
      }, label));
    });

    clear(scopeBodyHost);
    if (scopeMode === 'selected') {
      scopeBodyHost.appendChild(h('div.notice.info', selection.ids.length + ' specific products carried over from your catalog selection.'));
    } else if (scopeMode === 'all') {
      scopeBodyHost.appendChild(h('div.notice.info', 'Entire catalog selected — every active product will be evaluated against MAP and minimum margin rules.'));
    } else if (scopeMode === 'category') {
      scopeBodyHost.appendChild(h('div.stack-sm',
        h('span.small.muted', 'Tap one or more categories:'),
        chips(facets.categories.map((c) => ({ value: c.value, n: c.n })), selection.categories, (v) => {
          selection.categories = v;
          syncAutoName();
          updateCount();
        })));
    } else if (scopeMode === 'brand') {
      scopeBodyHost.appendChild(h('div.stack-sm',
        h('span.small.muted', 'Tap one or more brands:'),
        chips(facets.brands.map((b) => ({ value: b.value, n: b.n })), selection.brands, (v) => {
          selection.brands = v;
          syncAutoName();
          updateCount();
        })));
    }
  };

  // --- Step 2: Discount & Price Ending ---
  const adjTabsHost = h('div.seg-group');
  const valueInput = h('input.promo-big-input', {
    type: 'number', id: 'promo-value', inputmode: 'decimal', min: '0', step: 'any', value: st.value,
    'aria-label': 'Promotion value',
    oninput: () => { st.value = valueInput.value; drawQuickPcts(); renderExample(); renderSummary(); },
  });
  const unitTag = h('span.badge', '% OFF');
  const quickPctHost = h('div.chips');
  const increaseSubHost = h('div');
  const roundingHost = h('div.seg-group');
  const exampleHost = h('div.promo-example');

  const drawQuickPcts = () => {
    clear(quickPctHost);
    if (st.adjType !== 'percent_off') return;
    [10, 15, 20, 25, 30].forEach((p) => {
      quickPctHost.appendChild(h('button.chip', {
        type: 'button', class: Number(valueInput.value) === p ? 'on' : '',
        onclick: () => { valueInput.value = String(p); st.value = String(p); drawQuickPcts(); renderExample(); renderSummary(); },
      }, p + '%'));
    });
  };

  const drawAdj = () => {
    clear(adjTabsHost);
    const isInc = st.adjType === 'percent_increase' || st.adjType === 'amount_increase';
    [
      ['percent_off', '% Discount'],
      ['amount_off', '$ Amount Off'],
      ['set_price', 'Fixed Price ($)'],
      ['increase', '+ Price Increase'],
    ].forEach(([k, label]) => {
      const active = k === 'increase' ? isInc : st.adjType === k;
      adjTabsHost.appendChild(h('button.seg-btn', {
        type: 'button', class: active ? 'on' : '',
        onclick: () => {
          st.adjType = k === 'increase' ? 'percent_increase' : k;
          drawAdj();
          drawQuickPcts();
          renderExample();
          renderSummary();
        },
      }, label));
    });

    clear(increaseSubHost);
    if (isInc) {
      increaseSubHost.appendChild(h('div.chips',
        h('button.chip', { type: 'button', class: st.adjType === 'percent_increase' ? 'on' : '', onclick: () => { st.adjType = 'percent_increase'; drawAdj(); renderExample(); renderSummary(); } }, 'Increase by %'),
        h('button.chip', { type: 'button', class: st.adjType === 'amount_increase' ? 'on' : '', onclick: () => { st.adjType = 'amount_increase'; drawAdj(); renderExample(); renderSummary(); } }, 'Increase by $')));
    }

    const labels = { percent_off: '% OFF', amount_off: '$ OFF', set_price: 'FIXED $', percent_increase: '+ %', amount_increase: '+ $' };
    unitTag.textContent = labels[st.adjType] || '';
  };

  const drawRounding = () => {
    clear(roundingHost);
    [
      ['none', 'Exact price'],
      ['charm_99', 'End in .99'],
      ['whole_dollar', 'Whole $'],
    ].forEach(([k, label]) => {
      roundingHost.appendChild(h('button.seg-btn', {
        type: 'button', class: st.rounding === k ? 'on' : '',
        onclick: () => { st.rounding = k; drawRounding(); renderExample(); renderSummary(); },
      }, label));
    });
  };

  const renderExample = () => {
    clear(exampleHost);
    const sampleAfter = computeSamplePriceCents(10000, st.adjType, valueInput.value, st.rounding);
    if (!sampleAfter) {
      exampleHost.appendChild(h('span.muted', 'Enter a valid amount above to see a live price example.'));
      return;
    }
    const diff = 10000 - sampleAfter;
    exampleHost.appendChild(h('span', 'Live example on a ', h('code', '$100.00'), ' product:'));
    exampleHost.appendChild(h('span',
      h('strong', money(sampleAfter)),
      diff > 0 ? h('span.small.muted', '  (saves ' + money(diff) + ')') : diff < 0 ? h('span.small.muted', '  (+' + money(-diff) + ')') : null));
  };

  // --- Step 3: Timing & Automatic Safety Guardrails ---
  const schedTabsHost = h('div.seg-group');
  const startInput = h('input', { type: 'datetime-local', oninput: () => renderSummary() });
  const endInput = h('input', { type: 'datetime-local', oninput: () => renderSummary() });
  startInput.min = toLocalInput(new Date());
  const schedFields = h('div.form-grid', { hidden: true },
    h('label.field', 'Start date & time', startInput, h('span.help', 'Leave empty to start on approval')),
    h('label.field', 'End date & time', endInput, h('span.help', 'Leave empty to end manually')));

  const drawSchedule = () => {
    clear(schedTabsHost);
    [
      ['immediate', 'Start right after approval'],
      ['scheduled', 'Schedule start / end dates'],
    ].forEach(([k, label]) => {
      schedTabsHost.appendChild(h('button.seg-btn', {
        type: 'button', class: st.scheduleMode === k ? 'on' : '',
        onclick: () => {
          st.scheduleMode = k;
          if (k === 'immediate') { startInput.value = ''; endInput.value = ''; }
          schedFields.hidden = k !== 'scheduled';
          drawSchedule();
          renderSummary();
        },
      }, label));
    });
  };

  const minMargin = h('input', { type: 'number', min: '0', max: '95', step: '0.5', value: String(settings.campaignRules.minMarginPct * 100), oninput: () => renderGuardrailSummary() });
  const warnMargin = h('input', { type: 'number', min: '0', max: '95', step: '0.5', value: String(settings.campaignRules.warnMarginPct * 100) });
  const clamp = h('input', { type: 'checkbox', checked: !!settings.campaignRules.clampToMinMargin, onchange: () => renderGuardrailSummary() });
  const rulesFields = h('div.stack-sm', { hidden: true },
    h('div.form-grid',
      h('label.field', 'Minimum profit margin (%)', minMargin, h('span.help', 'Products below this margin are protected')),
      h('label.field', 'Low-margin warning (%)', warnMargin, h('span.help', 'Flagged for your review'))),
    h('label.check', clamp, 'Automatically stop discount at minimum margin instead of blocking the product'));

  let rulesOpen = false;
  const rulesBtn = h('button.btn.sm', {
    type: 'button',
    onclick: () => {
      rulesOpen = !rulesOpen;
      rulesFields.hidden = !rulesOpen;
      rulesBtn.textContent = rulesOpen ? 'Done customizing rules' : 'Customize margin rules';
    },
  }, 'Customize margin rules');

  const guardrailText = h('div.small');
  const renderGuardrailSummary = () => {
    const mm = Number(minMargin.value) || 0;
    guardrailText.textContent = 'MAP contractual floor is strictly enforced. Minimum profit margin is set to ' + mm + '% (' + (clamp.checked ? 'prices auto-cap at min. margin' : 'items below min. margin are blocked') + ').';
    renderSummary();
  };

  // --- Right Sticky Summary Card ---
  const summaryList = h('ul.summary-list');
  function renderSummary() {
    clear(summaryList);
    const isPct = st.adjType.indexOf('percent') === 0;
    const raw = Number(valueInput.value || st.value);
    const adjPreview = isFinite(raw) && raw >= 0
      ? adjustmentLabel({ type: st.adjType, value: isPct ? raw / 100 : Math.round(raw * 100) }) + (st.rounding === 'charm_99' ? ' (.99)' : st.rounding === 'whole_dollar' ? ' (Whole $)' : '')
      : '—';
    const rows = [
      ['Where', st.channel === 'online_and_pos' ? 'Online + Store POS (' + (POS_EVENT_LABELS[st.posEventType] || 'Event') + ')' : 'Online Store Only'],
      ['Products', describeFilter(selection)],
      ['Matching SKUs', matchedCount === null ? '…' : matchedCount.toLocaleString('en-US')],
      ['Price change', adjPreview],
      ['Timing', st.scheduleMode === 'scheduled' && (startInput.value || endInput.value) ? (startInput.value ? 'Scheduled' : 'Immediate') + (endInput.value ? ' · auto-end' : '') : 'Starts on approval'],
      ['Protection', 'MAP + ' + (Number(minMargin.value) || 0) + '% min. margin'],
    ];
    rows.forEach(([k, v]) => summaryList.appendChild(h('li', h('span.k', k), h('span.v', v))));
  }

  const err = h('div');
  const submit = h('button.btn.primary.lg.full', { type: 'submit' }, 'Preview impact');

  drawPresets();
  drawChannel();
  rebuildAdvFilters();
  drawScope();
  drawAdj();
  drawQuickPcts();
  drawRounding();
  renderExample();
  drawSchedule();
  renderGuardrailSummary();
  updateCount();

  const leftCol = h('div.stack',
    card(null, h('div.stack-sm',
      h('div.row-between', h('strong', 'Quick event templates (optional)'), h('span.small.muted', 'Or configure manually below')),
      presetHost)),
    card(h('span.row', h('span.step-badge', '1'), 'Where & Which Products'), h('div.stack',
      h('label.field', 'Promotion name', nameInput),
      h('div.stack-sm', h('span.small.muted', 'Where should this promotion apply?'), channelHost),
      h('div.sep'),
      h('div.row-between', h('span.small.muted', 'Which products should be included?'), countBadge),
      scopeTabsHost,
      scopeBodyHost,
      h('div', advBtn),
      advWrap)),
    card(h('span.row', h('span.step-badge', '2'), 'Discount & Price Ending'), h('div.stack',
      adjTabsHost,
      increaseSubHost,
      h('div.promo-value-row', valueInput, unitTag, quickPctHost),
      h('div.stack-sm', h('span.small.muted', 'Price ending (psychological rounding):'), roundingHost),
      exampleHost)),
    card(h('span.row', h('span.step-badge', '3'), 'Timing & Safety Guardrails'), h('div.stack',
      h('div.stack-sm', h('span.small.muted', 'When should prices change?'), schedTabsHost, schedFields),
      h('div.guardrail-box',
        h('div.row-between', h('strong', '✓ Automatic MAP & Margin Protection Active'), rulesBtn),
        guardrailText,
        rulesFields))));

  const rightCol = h('div.promo-sticky',
    card('Promotion Summary', h('div.stack',
      summaryList,
      err,
      submit,
      h('a.btn.full', { href: '#/promotions' }, 'Cancel'),
      h('div.small.muted', 'Safe 2-step flow: clicking "Preview impact" never changes live prices. You will inspect every product first.'))));

  const form = h('form.promo-layout', {
    onsubmit: async (e) => {
      e.preventDefault();
      clear(err);
      const isPct = st.adjType.indexOf('percent') === 0;
      const raw = Number(valueInput.value);
      if (!(raw >= 0) || isNaN(raw)) { err.appendChild(h('div.notice.bad', 'Enter a valid discount value.')); return; }
      if (st.adjType === 'percent_off' && raw >= 100) { err.appendChild(h('div.notice.bad', 'A percentage discount must be below 100%.')); return; }
      const adjustment = { type: st.adjType, value: isPct ? raw / 100 : dollarsToCents(valueInput.value), rounding: st.rounding };
      const startsAt = startInput.value ? new Date(startInput.value).toISOString() : null;
      const endsAt = endInput.value ? new Date(endInput.value).toISOString() : null;
      if (startsAt && endsAt && endsAt <= startsAt) { err.appendChild(h('div.notice.bad', 'End date must be after start date.')); return; }
      submit.disabled = true;
      submit.textContent = 'Calculating preview…';
      try {
        const payload = {
          name: nameInput.value.trim(),
          channel: st.channel,
          posEventType: st.channel === 'online_and_pos' ? st.posEventType : undefined,
          selection: cleanFilter(selection),
          adjustment,
          rules: { minMarginPct: Number(minMargin.value) / 100, warnMarginPct: Number(warnMargin.value) / 100, clampToMinMargin: clamp.checked },
          startsAt,
          endsAt,
        };
        const res = await ctx.api.createCampaign(payload);
        ctx.navigate('#/promotions/' + res.id);
      } catch (ex) {
        submit.disabled = false;
        submit.textContent = 'Preview impact';
        err.appendChild(h('div.notice.bad', ex.message + (ex.details && Array.isArray(ex.details) ? ': ' + ex.details.map((d) => d.path + ' ' + d.message).join('; ') : '')));
      }
    },
  }, leftCol, rightCol);

  return h('div.stack',
    pageHead('New promotion', 'Choose your products and discount below, then preview every calculated price, margin and MAP check before approving.',
      [h('a.btn', { href: '#/promotions' }, '← Back to Promotions')]),
    form);
}

export async function renderPromotionDetail(ctx) {
  const c = await ctx.api.campaign(ctx.params.id);
  const s = c.summary || { total: 0, ok: 0, warning: 0, blocked: 0, excluded: 0, revenueDeltaCents: 0 };
  const st = { status: s.blocked ? 'blocked' : null, offset: 0, limit: 50 };
  const linesHost = h('div', loading());
  const strip = h('div.summary-strip');

  const drawStrip = () => {
    clear(strip);
    [
      [null, 'All lines', s.total, ''],
      ['ok', 'Will apply', s.ok, s.ok ? 'ok-val' : ''],
      ['warning', 'With warnings', s.warning, s.warning ? 'warn-val' : ''],
      ['blocked', 'Blocked (MAP / margin)', s.blocked, s.blocked ? 'bad-val' : ''],
      ['excluded', 'Excluded', s.excluded, ''],
    ].forEach(([k, label, n, valCls]) => {
      strip.appendChild(h('button', {
        type: 'button', class: st.status === k ? 'on' : '',
        onclick: () => { st.status = k; st.offset = 0; drawStrip(); loadLines(); },
      }, h('div.label', label), h('div.value', { class: valCls }, String(n || 0))));
    });
  };

  const loadLines = async () => {
    mount(linesHost, loading());
    try {
      const r = await ctx.api.campaignLines(c.id, st.status || undefined, st.offset, st.limit);
      if (!ctx.isCurrent()) return;
      mount(linesHost, dataTable({
        columns: [
          { key: 'title', label: 'Product', cls: 'title-cell', render: (l) => h('div', h('a', { href: '#/products/' + l.variant_id }, h('strong', l.title)), h('div.sku', l.sku + ' · ' + l.brand)) },
          { key: 'old', label: 'Before', num: true, render: (l) => money(l.old_price_cents) },
          { key: 'new', label: 'After', num: true, render: (l) => (l.status === 'excluded' ? h('span.muted', '—') : h('strong', money(l.new_price_cents))) },
          { key: 'cost', label: 'Cost', num: true, opt: true, render: (l) => money(l.cost_cents) },
          { key: 'om', label: 'Margin before', num: true, opt: true, render: (l) => pct(l.cost_cents === null ? null : (l.old_price_cents - l.cost_cents) / l.old_price_cents) },
          { key: 'nm', label: 'Margin after', num: true, render: (l) => (l.status === 'excluded' || l.cost_cents === null ? '—' : pct((l.new_price_cents - l.cost_cents) / l.new_price_cents)) },
          { key: 'map', label: 'MAP floor', num: true, opt: true, render: (l) => (l.map_cents ? money(l.map_cents) : '—') },
          { key: 'status', label: 'Decision', render: (l) => {
            const v = LINE_STATUS[l.status];
            return h('div', h('span.badge', { class: v[1] }, v[0]), (l.reasons || []).length ? h('div.small.muted', l.reasons.map((x) => REASON_LABELS[x] || x).join(', ')) : null,
              l.restore_result ? h('div.small', { class: l.restore_result === 'restored' ? '' : 'muted' }, l.restore_result.replace(/_/g, ' ')) : null);
          } },
        ],
        rows: r.lines, rowKey: (l) => l.variant_id, empty: 'No products in this filter tab.',
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

  const evLabel = s.posEventType ? POS_EVENT_LABELS[s.posEventType] || s.posEventType : null;
  const channelDesc = c.channel === 'online'
    ? 'Online store only (Shopify)'
    : 'Online (Shopify) + Physical Store POS (Lightspeed)' + (evLabel ? ' — ' + evLabel : '');

  const actions = [];
  if (c.status === 'draft') {
    if (ctx.can('pricing.write')) actions.push(h('button.btn', { onclick: async () => { await ctx.api.previewCampaign(c.id); toast('Preview refreshed with current data'); ctx.navigate('#/promotions/' + c.id + '?r=' + Date.now()); } }, 'Refresh preview'));
    if (ctx.can('campaign.approve')) {
      actions.push(h('button.btn.primary', {
        onclick: async () => {
          const ok = await confirmDialog({
            title: 'Approve “' + c.name + '”?',
            message: h('div.stack',
              h('p', (s.ok + s.warning).toLocaleString('en-US') + ' prices will change' + (c.starts_at && new Date(c.starts_at) > new Date() ? ' on ' + dateTime(c.starts_at) : ' now') + '. ' + s.blocked + ' blocked and ' + s.excluded + ' excluded products will remain untouched.'),
              h('p.small.muted', 'Scope: ' + channelDesc + '. Original prices are stored automatically so you can restore them in one click.'),
              s.warning ? h('div.notice.warn', s.warning + ' products have low-margin or MAP-exception warnings. Review them first if unsure.') : null),
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
        const ok = await confirmDialog({
          title: 'Restore original prices?',
          message: 'Each product returns to its pre-campaign price across ' + (c.channel === 'online_and_pos' ? 'both Shopify and Lightspeed Store POS' : 'Shopify') + ' — except products whose price was manually edited after the campaign started; those keep the newer price.',
          confirmLabel: 'Restore prices',
          danger: true,
        });
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

  let guideBanner = null;
  if (c.status === 'draft') {
    guideBanner = h('div.notice.info',
      h('strong', 'Preview Ready (Nothing published yet): '),
      String((s.ok || 0) + (s.warning || 0)) + ' products will be updated, and ' + String(s.blocked || 0) + ' products are automatically protected (MAP / minimum margin) and will not change. Click "Approve & schedule" above to publish.');
  } else if (c.status === 'active') {
    guideBanner = h('div.notice.ok',
      h('strong', 'Live Promotion: '),
      'Applied to ' + (s.applied !== undefined ? s.applied : (s.ok || 0) + (s.warning || 0)) + ' products (' + channelDesc + ')' + (s.skippedChanged ? '; ' + s.skippedChanged + ' skipped because their price changed after the preview' : '') + '. Click "Restore original prices" anytime to revert.');
  } else if (c.status === 'restored') {
    guideBanner = h('div.notice',
      h('strong', 'Prices Restored: '),
      'This promotion has ended and original prices were safely restored.');
  }

  drawStrip();
  loadLines();
  return h('div.stack',
    pageHead(c.name, 'Scope: ' + describeFilter(c.selection || {}) + ' · Min. margin ' + pct(c.rules && c.rules.minMarginPct, 0) + ' · ' + (c.starts_at ? dateTime(c.starts_at) : 'Starts on approval') + ' → ' + (c.ends_at ? dateTime(c.ends_at) : 'Until restored'),
      [h('a.btn', { href: '#/promotions' }, '← Promotions')].concat(actions)),
    h('div.row',
      campaignBadge(c.status),
      h('span.badge.info', adjustmentLabel(c.adjustment)),
      channelBadge(c.channel, s),
      h('span.small.muted', 'Net single-unit price delta across applicable items: ' + money(s.revenueDeltaCents))),
    guideBanner,
    jobHost,
    strip,
    h('section.card', linesHost));
}
