import { h, mount, clear, debounce } from '../ui/dom.js';
import { card, confirmDialog, dataTable, errorBox, loading, pageHead, pager, progressBar, searchableDropdown, toast, watchJob } from '../ui/components.js?v=42';
import { adjustmentLabel, campaignBadge, channelBadge, dateTime, LINE_STATUS, money, pct, POS_EVENT_LABELS, REASON_LABELS } from '../ui/format.js';
import { cleanFilter, describeFilter, dollarsToCents } from './common.js?v=40';
import { sessionStorageSafeGet } from './products.js?v=40';

const PRESETS = {
  online: { key: 'online', kicker: 'Web Promo', title: 'Online Promo', sub: '15% off · Exact price · Online Store', name: 'Online Sale', channel: 'online', event: null, pct: 15, rounding: 'none', featured: true },
  black_friday: { key: 'black_friday', kicker: 'Seasonal Sale', title: 'Black Friday', sub: '20% off (.99) · Online Store', name: 'Black Friday', channel: 'online', event: 'black_friday', pct: 20, rounding: 'charm_99' },
  christmas: { key: 'christmas', kicker: 'Seasonal Sale', title: 'Holiday / Christmas', sub: '15% off (.99) · Online Store', name: 'Holiday Sale', channel: 'online', event: 'christmas', pct: 15, rounding: 'charm_99' },
  clearance: { key: 'clearance', kicker: 'Clearance', title: 'Clearance Event', sub: '25% off (Whole $) · Online Store', name: 'Annual Clearance', channel: 'online', event: 'annual_clearance', pct: 25, rounding: 'whole_dollar' },
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

  const kpiStrip = h('div.kpis',
    h('div.kpi', h('div.label', 'Active & Scheduled'), h('div.value', String(counts.live)), h('div.sub', 'Live or queued promos')),
    h('div.kpi', h('div.label', 'Draft Previews'), h('div.value', String(counts.draft)), h('div.sub', 'Waiting for review')),
    h('div.kpi', h('div.label', 'Past / Restored'), h('div.value', String(counts.past)), h('div.sub', 'Safely reverted')),
    h('div.kpi', h('div.label', 'Total Price Rules'), h('div.value', String(counts.all)), h('div.sub', 'History & templates')));

  const quickTemplates = ctx.can('pricing.write')
    ? h('div.stack-sm',
      h('div.row-between', h('h2', 'Quick-start templates'), h('span.small.muted', 'Pre-filled defaults — you can pick brands, categories, or specific SKUs/UPCs before previewing')),
      h('div.promo-preset-row', Object.keys(PRESETS).map((k) => {
        const p = PRESETS[k];
        return h('a.quick-card', { href: '#/promotions/new?preset=' + p.key, class: p.featured ? 'featured' : '' },
          h('span.quick-kicker', p.kicker),
          h('span.quick-title', p.title),
          h('span.quick-sub', p.sub));
      })))
    : null;

  return h('div.stack',
    pageHead('Promotions & Price Rules', 'Run targeted discounts by brand, category, or specific products (Name / UPC / SKU). MAP and margin floors are checked before anything goes live.',
      ctx.can('pricing.write') ? [h('a.btn.primary', { href: '#/promotions/new' }, '+ New promotion')] : []),
    kpiStrip,
    quickTemplates,
    card('All Promotions', tableHost, { flush: true, actions: tabsHost }));
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
  const editId = ctx.query.edit || null;
  const [facets, settings, editCamp] = await Promise.all([
    ctx.api.facets(),
    ctx.api.settings(),
    editId ? ctx.api.campaign(editId) : Promise.resolve(null),
  ]);
  const posEnabled = !!(ctx.system && ctx.system.posEventWritesEnabled);

  let selection = { stock: 'physical' };
  let scopeMode = 'filter';
  if (editCamp) {
    selection = Object.assign({}, editCamp.selection || {});
    if (selection.ids && selection.ids.length) scopeMode = 'selected';
  } else if (ctx.query.from === 'selection') {
    try { selection = JSON.parse(sessionStorageSafeGet('ubc-promo-selection') || '{}'); } catch (e) { selection = {}; }
    if (selection.ids && selection.ids.length) scopeMode = 'selected';
  }

  const editAdj = editCamp && editCamp.adjustment ? editCamp.adjustment : null;
  const editIsPct = editAdj && editAdj.type.indexOf('percent') === 0;
  const st = {
    channel: editCamp ? (editCamp.channel === 'online_and_pos' && posEnabled ? 'online_and_pos' : 'online') : 'online',
    posEventType: (editCamp && editCamp.summary && editCamp.summary.posEventType) || 'black_friday',
    adjType: editAdj ? editAdj.type : 'percent_off',
    value: editAdj ? String(editIsPct ? Math.round(editAdj.value * 10000) / 100 : editAdj.value / 100) : '20',
    rounding: (editAdj && editAdj.rounding) || 'charm_99',
    scheduleMode: editCamp && (editCamp.starts_at || editCamp.ends_at) ? 'scheduled' : 'immediate',
    presetKey: !editCamp && ctx.query.preset && PRESETS[ctx.query.preset] ? ctx.query.preset : null,
    customName: !!editCamp,
  };

  if (st.presetKey) {
    const pr = PRESETS[st.presetKey];
    st.channel = pr.channel === 'online_and_pos' && posEnabled ? 'online_and_pos' : 'online';
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
    type: 'text', value: editCamp ? editCamp.name : defaultNameForState(), maxlength: '120', required: true, id: 'promo-name',
    oninput: () => { st.customName = true; renderSummary(); },
  });
  const syncAutoName = () => {
    if (!st.customName) nameInput.value = defaultNameForState();
  };

  const countBadge = h('span.badge.info', 'Counting…');
  let matchedCount = null;
  const updateCount = async () => {
    try {
      if (scopeMode === 'selected') {
        const cnt = (selection.ids && selection.ids.length) ? selection.ids.length : 0;
        matchedCount = cnt;
        countBadge.textContent = cnt.toLocaleString('en-US') + ' selected';
        renderSummary();
        return;
      }
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
  const presetHost = h('div.promo-preset-row');
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
      h('div.choice-title', h('span', 'Online Store Only (Shopify)'), h('span.choice-dot')),
      h('div.choice-desc', 'Applies to your Shopify store. In-store Lightspeed register prices stay untouched.')),
      h('button.choice-card', {
        type: 'button',
        class: st.channel === 'online_and_pos' ? 'on' : '',
        disabled: !posEnabled,
        style: posEnabled ? null : { opacity: '0.55', cursor: 'not-allowed' },
        onclick: () => { if (!posEnabled) return; st.channel = 'online_and_pos'; syncAutoName(); drawChannel(); renderSummary(); },
      },
      h('div.choice-title', h('span', 'Online + Store POS (Lightspeed)'), h('span.choice-dot')),
      h('div.choice-desc', posEnabled
        ? 'Updates both Shopify and Lightspeed POS registers, then restores both.'
        : 'Disabled right now: Lightspeed connection is read-only (inventory & prices read only).')));

    channelHost.appendChild(cards);
    if (st.channel === 'online_and_pos' && posEnabled) {
      const evChips = h('div.chips', Object.keys(POS_EVENT_LABELS).map((k) => h('button.chip', {
        type: 'button', class: st.posEventType === k ? 'on' : '',
        onclick: () => { st.posEventType = k; syncAutoName(); drawChannel(); renderSummary(); },
      }, POS_EVENT_LABELS[k])));
      channelHost.appendChild(h('div.stack-sm',
        h('label.field', 'Select Special Event', evChips)));
    }
  };

  const scopeTabsHost = h('div.seg-group');
  const scopeBodyHost = h('div.promo-scope-box');
  const advWrap = h('div.stack-sm', { hidden: true });
  let advOpen = false;
  const advBtn = h('button.btn.sm.ghost', {
    type: 'button',
    onclick: () => {
      advOpen = !advOpen;
      advWrap.hidden = !advOpen;
      advBtn.textContent = advOpen ? 'Hide extra filters ▴' : '+ Extra filters (keyword/UPC/SKU, stock, supplier, price range)';
    },
  }, '+ Extra filters (keyword/UPC/SKU, stock, supplier, price range)');

  const selectedItemsMap = new Map();
  let pickerState = { q: '', brands: [], inStock: true, results: [], loading: false };

  const loadInitialSelected = async () => {
    if (selection.ids && selection.ids.length && selectedItemsMap.size === 0) {
      try {
        const res = await ctx.api.items({ ids: selection.ids.slice(0, 200), limit: 200 });
        (res.items || []).forEach((it) => selectedItemsMap.set(it.id, it));
        if (scopeMode === 'selected') drawScope();
      } catch (e) { /* ignore */ }
    }
  };

  const syncSelectedIds = () => {
    selection.ids = Array.from(selectedItemsMap.keys());
    if (!selection.ids.length) delete selection.ids;
    syncAutoName();
    updateCount();
  };

  const rebuildAdvFilters = () => {
    clear(advWrap);
    const qInput = h('input', {
      type: 'search', placeholder: 'Keyword, SKU, UPC or MPN…', value: selection.q || '',
      oninput: (e) => { selection.q = e.target.value || undefined; syncAutoName(); updateCountDebounced(); },
    });
    const stockSel = h('select', {
      onchange: (e) => { selection.stock = e.target.value || undefined; syncAutoName(); updateCount(); },
    }, [['', 'Any availability'], ['physical', 'In stock at UBC store'], ['virtual_only', 'Supplier special-order only'], ['unavailable', 'Unavailable']].map(([v, t]) => h('option', { value: v, selected: (selection.stock || '') === v }, t)));
    const supDropdown = (facets.suppliers && facets.suppliers.length)
      ? searchableDropdown(facets.suppliers.map((s) => ({ value: s.value, label: s.value, n: s.n })), selection.suppliers, (v) => {
        selection.suppliers = v.length ? v : undefined;
        syncAutoName();
        updateCount();
      }, { allLabel: 'All suppliers', noun: 'suppliers', placeholder: 'Search suppliers…' })
      : null;
    const minPrice = h('input', {
      type: 'number', inputmode: 'decimal', min: '0', step: 'any', placeholder: '0', value: selection.priceMinCents === undefined ? '' : String(selection.priceMinCents / 100),
      oninput: (e) => { selection.priceMinCents = dollarsToCents(e.target.value); updateCountDebounced(); },
    });
    const maxPrice = h('input', {
      type: 'number', inputmode: 'decimal', min: '0', step: 'any', placeholder: 'Any', value: selection.priceMaxCents === undefined ? '' : String(selection.priceMaxCents / 100),
      oninput: (e) => { selection.priceMaxCents = dollarsToCents(e.target.value); updateCountDebounced(); },
    });
    advWrap.appendChild(h('div.form-grid',
      h('label.field', 'Search keyword / UPC / SKU', qInput),
      h('label.field', 'Availability', stockSel),
      h('label.field', 'Min current price ($)', minPrice),
      h('label.field', 'Max current price ($)', maxPrice)));
    if (supDropdown) {
      advWrap.appendChild(h('label.field', 'Filter by supplier', supDropdown));
    }
  };

  const drawScope = () => {
    clear(scopeTabsHost);
    clear(scopeBodyHost);

    [
      ['filter', 'Filter by Brand & Category'],
      ['selected', 'Pick Specific Products (Name, UPC, SKU)' + (selectedItemsMap.size ? ' · ' + selectedItemsMap.size : '')],
    ].forEach(([mode, label]) => {
      scopeTabsHost.appendChild(h('button.seg-btn', {
        type: 'button',
        class: scopeMode === mode ? 'on' : '',
        onclick: () => {
          if (scopeMode === mode) return;
          scopeMode = mode;
          if (mode === 'filter') {
            delete selection.ids;
          } else {
            syncSelectedIds();
          }
          drawScope();
          updateCount();
        },
      }, label));
    });

    if (scopeMode === 'selected') {
      advBtn.hidden = true;
      advWrap.hidden = true;

      const resultsHost = h('div.picker-results');
      const selectedHost = h('div.picker-selected');

      const renderSelectedTray = () => {
        clear(selectedHost);
        const items = Array.from(selectedItemsMap.values());
        selectedHost.appendChild(h('div.row-between',
          h('strong.small', 'Selected products for this promotion (' + items.length + ')'),
          items.length ? h('button.btn.sm.ghost', {
            type: 'button',
            onclick: () => {
              selectedItemsMap.clear();
              syncSelectedIds();
              drawScope();
            },
          }, 'Clear all') : null));

        if (!items.length) {
          selectedHost.appendChild(h('div.small.muted', 'No products selected yet. Search by product name, UPC, or SKU above and click "+ Add".'));
          return;
        }
        const list = h('div.picker-selected-list');
        items.forEach((it) => {
          list.appendChild(h('div.picker-selected-item',
            h('div',
              h('strong', it.title),
              h('div.small.muted', [it.brand, it.sku ? 'SKU: ' + it.sku : null, it.upc ? 'UPC: ' + it.upc : null, money(it.priceCents)].filter(Boolean).join(' · '))),
            h('button.btn.sm.ghost', {
              type: 'button',
              onclick: () => {
                selectedItemsMap.delete(it.id);
                syncSelectedIds();
                renderSelectedTray();
                renderResults();
                const tabBtn = scopeTabsHost.children[1];
                if (tabBtn) tabBtn.textContent = 'Pick Specific Products (Name, UPC, SKU)' + (selectedItemsMap.size ? ' · ' + selectedItemsMap.size : '');
              },
            }, '× Remove')));
        });
        selectedHost.appendChild(list);
      };

      const renderResults = () => {
        clear(resultsHost);
        if (pickerState.loading) {
          resultsHost.appendChild(h('div.msd-empty', 'Searching catalog…'));
          return;
        }
        if (!pickerState.results.length) {
          resultsHost.appendChild(h('div.msd-empty', 'No products match that search. Try a product name, UPC, SKU, or brand.'));
          return;
        }
        pickerState.results.forEach((it) => {
          const isPicked = selectedItemsMap.has(it.id);
          resultsHost.appendChild(h('div.picker-row',
            h('div',
              h('div.picker-row-title', it.title),
              h('div.picker-row-meta', [
                it.brand || null,
                it.sku ? 'SKU: ' + it.sku : null,
                it.upc ? 'UPC: ' + it.upc : null,
                'Qty: ' + (it.physicalQty || 0),
              ].filter(Boolean).map((txt) => h('span', txt)))),
            h('div.picker-row-price',
              h('div', h('strong', money(it.priceCents))),
              it.mapCents ? h('div.small.muted', 'MAP ' + money(it.mapCents)) : null),
            h('button.btn.sm', {
              type: 'button',
              class: isPicked ? 'ghost' : 'primary',
              onclick: () => {
                if (isPicked) selectedItemsMap.delete(it.id);
                else selectedItemsMap.set(it.id, it);
                syncSelectedIds();
                renderResults();
                renderSelectedTray();
                const tabBtn = scopeTabsHost.children[1];
                if (tabBtn) tabBtn.textContent = 'Pick Specific Products (Name, UPC, SKU)' + (selectedItemsMap.size ? ' · ' + selectedItemsMap.size : '');
              },
            }, isPicked ? '✓ Added' : '+ Add')));
        });
      };

      const runPickerSearch = async () => {
        pickerState.loading = true;
        renderResults();
        try {
          const r = await ctx.api.items(cleanFilter({
            q: pickerState.q || undefined,
            brands: pickerState.brands.length ? pickerState.brands : undefined,
            stock: pickerState.inStock ? 'physical' : undefined,
            limit: 25,
          }));
          pickerState.results = r.items || [];
        } catch (e) {
          pickerState.results = [];
        } finally {
          pickerState.loading = false;
          renderResults();
        }
      };
      const runPickerSearchDebounced = debounce(runPickerSearch, 240);

      const searchBox = h('input', {
        type: 'search',
        placeholder: 'Search by Name, UPC, SKU, or MPN…',
        value: pickerState.q,
        oninput: (e) => {
          pickerState.q = e.target.value || '';
          runPickerSearchDebounced();
        },
      });
      const brandDrop = searchableDropdown(
        facets.brands.map((b) => ({ value: b.value, label: b.value, n: b.n })),
        pickerState.brands,
        (v) => { pickerState.brands = v; runPickerSearch(); },
        { allLabel: 'All brands', noun: 'brands', placeholder: 'Filter by brand…' },
      );
      const stockOnlyCb = h('input', {
        type: 'checkbox',
        checked: pickerState.inStock,
        onchange: (e) => { pickerState.inStock = e.target.checked; runPickerSearch(); },
      });
      const addAllBtn = h('button.btn.sm', {
        type: 'button',
        onclick: () => {
          pickerState.results.forEach((it) => selectedItemsMap.set(it.id, it));
          syncSelectedIds();
          renderResults();
          renderSelectedTray();
          const tabBtn = scopeTabsHost.children[1];
          if (tabBtn) tabBtn.textContent = 'Pick Specific Products (Name, UPC, SKU)' + (selectedItemsMap.size ? ' · ' + selectedItemsMap.size : '');
        },
      }, '+ Add all shown');

      scopeBodyHost.appendChild(h('div.picker-box',
        h('div.picker-toolbar', searchBox, brandDrop, addAllBtn),
        h('div.row-between',
          h('label.check', stockOnlyCb, h('span.small', 'In stock at UBC stores only')),
          h('span.small.muted', 'Showing up to 25 matching products')),
        resultsHost,
        selectedHost));

      renderSelectedTray();
      runPickerSearch();
      return;
    }

    advBtn.hidden = false;
    advWrap.hidden = !advOpen;

    const inStockCheck = h('input', {
      type: 'checkbox',
      checked: selection.stock === 'physical',
      onchange: (e) => {
        selection.stock = e.target.checked ? 'physical' : undefined;
        syncAutoName();
        updateCount();
      },
    });
    const clearAllBtn = h('button.btn.sm.ghost', {
      type: 'button',
      onclick: () => {
        delete selection.categories;
        delete selection.brands;
        delete selection.q;
        delete selection.suppliers;
        delete selection.priceMinCents;
        delete selection.priceMaxCents;
        delete selection.stock;
        drawScope();
        rebuildAdvFilters();
        syncAutoName();
        updateCount();
      },
    }, 'Reset filters');

    const catDropdown = searchableDropdown(
      facets.categories.map((c) => ({ value: c.value, label: c.value, n: c.n })),
      selection.categories,
      (v) => {
        selection.categories = v.length ? v : undefined;
        syncAutoName();
        updateCount();
      },
      { allLabel: 'All categories', noun: 'categories', placeholder: 'Search categories…' },
    );
    const brandDropdown = searchableDropdown(
      facets.brands.map((b) => ({ value: b.value, label: b.value, n: b.n })),
      selection.brands,
      (v) => {
        selection.brands = v.length ? v : undefined;
        syncAutoName();
        updateCount();
      },
      { allLabel: 'All brands', noun: 'brands', placeholder: 'Search brands (e.g. Specialized, Fox, Giant)…' },
    );

    scopeBodyHost.appendChild(h('div.stack',
      h('div.row-between',
        h('label.check', inStockCheck, h('strong', 'In stock at UBC stores only (Tampa / Alafia)')),
        clearAllBtn),
      h('div.form-grid',
        h('label.field', 'Brands (dropdown filter)', brandDropdown),
        h('label.field', 'Categories (dropdown filter)', catDropdown))));
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
    [10, 15, 20, 25, 30, 50].forEach((p) => {
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

  const editRules = editCamp && editCamp.rules ? editCamp.rules : null;
  const minMargin = h('input', {
    type: 'number', min: '0', max: '95', step: '0.5',
    value: String((editRules ? editRules.minMarginPct : settings.campaignRules.minMarginPct) * 100),
    oninput: () => renderGuardrailSummary(),
  });
  const warnMargin = h('input', {
    type: 'number', min: '0', max: '95', step: '0.5',
    value: String((editRules ? editRules.warnMarginPct : settings.campaignRules.warnMarginPct) * 100),
  });
  const clamp = h('input', {
    type: 'checkbox',
    checked: editRules ? !!editRules.clampToMinMargin : true,
    onchange: () => renderGuardrailSummary(),
  });
  const includeNoCost = h('input', {
    type: 'checkbox',
    checked: editRules ? !editRules.excludeWithoutCost : true,
    onchange: () => renderGuardrailSummary(),
  });
  const rulesFields = h('div.stack-sm', { hidden: true },
    h('div.form-grid',
      h('label.field', 'Minimum profit margin (%) — set 0 for no margin block', minMargin, h('span.help', 'MAP floor still applies automatically')),
      h('label.field', 'Low-margin warning (%)', warnMargin, h('span.help', 'Flagged for your review'))),
    h('label.check', clamp, 'Auto-adjust price to minimum margin instead of blocking the product'),
    h('label.check', includeNoCost, 'Include items that have $0 / no cost on file in Lightspeed'));

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
  loadInitialSelected();

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
      if (scopeMode === 'selected' && !(selection.ids && selection.ids.length)) {
        err.appendChild(h('div.notice.bad', 'Pick at least one specific product (or switch to "Filter by Brand & Category").'));
        return;
      }
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
          rules: {
            minMarginPct: (Number(minMargin.value) || 0) / 100,
            warnMarginPct: (Number(warnMargin.value) || 0) / 100,
            clampToMinMargin: clamp.checked,
            excludeWithoutCost: !includeNoCost.checked,
          },
          startsAt,
          endsAt,
        };
        const res = editCamp
          ? await ctx.api.updateCampaign(editCamp.id, payload)
          : await ctx.api.createCampaign(payload);
        ctx.navigate('#/promotions/' + res.id);
      } catch (ex) {
        submit.disabled = false;
        submit.textContent = editCamp ? 'Save & re-preview' : 'Preview impact';
        err.appendChild(h('div.notice.bad', ex.message + (ex.details && Array.isArray(ex.details) ? ': ' + ex.details.map((d) => d.path + ' ' + d.message).join('; ') : '')));
      }
    },
  }, leftCol, rightCol);

  if (editCamp) submit.textContent = 'Save & re-preview';
  return h('div.stack',
    pageHead(editCamp ? 'Edit promotion' : 'New promotion', 'Pick categories/brands, set your % or $ discount and price ending (.99 / .00 / exact), then preview before publishing.',
      [h('a.btn', { href: editCamp ? '#/promotions/' + editCamp.id : '#/promotions' }, editCamp ? '← Back to Preview' : '← Back to Promotions')]),
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
  if ((c.status === 'draft' || c.status === 'failed') && ctx.can('pricing.write')) {
    actions.push(h('a.btn', { href: '#/promotions/new?edit=' + c.id }, 'Edit % / .99 / brands'));
  }
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
