import { h, mount } from '../ui/dom.js';
import { card, confirmDialog, errorBox, loading, pageHead, pager, toast } from '../ui/components.js';
import { itemSearchTabs } from './products.js?v=82';

function centsToInput(c) {
  if (c === null || c === undefined || Number.isNaN(Number(c))) return '';
  return (Number(c) / 100).toFixed(2);
}

function inputToCents(val) {
  const s = String(val || '').trim().replace(/[$,]/g, '');
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return NaN;
  return Math.round(n * 100);
}

function parseTags(str) {
  return String(str || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function downloadCsv(filename, rows) {
  const csv = rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const VIEW_MODES = [
  { id: 'all', label: 'All Columns' },
  { id: 'prices', label: 'Prices & Cost' },
  { id: 'identity', label: 'SKU & Tags' },
  { id: 'restock', label: 'Restock Levels' },
];

const ALL_COLUMNS = [
  { key: 'description', label: 'Description', field: 'description', cls: 'lss-col-desc', groups: ['all', 'prices', 'identity', 'restock'], parse: (v) => String(v || '').trim() || undefined },
  { key: 'customSku', label: 'Custom SKU', field: 'customSku', cls: 'lss-col-csku', groups: ['all', 'identity'], parse: (v) => String(v || '').trim() },
  { key: 'tags', label: 'Tags', field: 'tags', cls: 'lss-col-tags', groups: ['all', 'identity'], format: (v) => (Array.isArray(v) ? v.join(', ') : ''), parse: parseTags },
  { key: 'defaultPrice', label: 'Default ($)', field: 'defaultPriceCents', cls: 'lss-col-money', groups: ['all', 'prices'], numeric: true, format: centsToInput, parse: (v) => { const c = inputToCents(v); return c === null ? NaN : c; } },
  { key: 'msrp', label: 'MSRP ($)', field: 'msrpCents', cls: 'lss-col-money', groups: ['all', 'prices'], numeric: true, format: centsToInput, parse: inputToCents },
  { key: 'salePrice', label: 'Sale ($)', field: 'salePriceCents', cls: 'lss-col-money', groups: ['all', 'prices'], numeric: true, format: centsToInput, parse: inputToCents },
  { key: 'onlinePrice', label: 'Online ($)', field: 'onlinePriceCents', cls: 'lss-col-money', groups: ['all', 'prices'], numeric: true, format: centsToInput, parse: inputToCents },
  { key: 'defaultCost', label: 'Default Cost ($)', field: 'defaultCostCents', cls: 'lss-col-cost', groups: ['all', 'prices'], numeric: true, format: centsToInput, parse: inputToCents },
  { key: 'reorderPoint', label: 'Reorder Pt', field: 'reorderPoint', cls: 'lss-col-qty', groups: ['all', 'restock'], numeric: true, parse: (v) => { const n = Number(String(v || '').trim() || '0'); return Number.isInteger(n) && n >= 0 ? n : NaN; } },
  { key: 'desiredLevel', label: 'Desired Lvl', field: 'desiredLevel', cls: 'lss-col-qty lss-col-last', groups: ['all', 'restock'], numeric: true, parse: (v) => { const n = Number(String(v || '').trim() || '0'); return Number.isInteger(n) && n >= 0 ? n : NaN; } },
];

export async function renderLightspeedSheet(ctx) {
  const root = h('div.stack.lss-root');

  const facets = await ctx.api.facets();
  const st = {
    filter: {
      q: ctx.query.q || '',
      brands: ctx.query.brands || '',
      categories: ctx.query.categories || '',
      stock: ctx.query.stock || 'physical',
      tag: ctx.query.tag || '',
    },
    viewMode: 'all',
    offset: 0,
    limit: 50,
    data: null,
    dirty: new Map(),
    selected: new Set(),
  };

  const head = pageHead(
    'Lightspeed Bulk Sheet',
    'Excel-style editor for descriptions, Custom SKU, tags, all price fields, and restock levels.',
  );
  const tabs = itemSearchTabs('ls-sheet');
  const statusWrap = h('div');
  const controlsWrap = h('div');
  const tableWrap = h('div', loading('Loading Lightspeed sheet…'));
  const pagerWrap = h('div');

  mount(root, [head, tabs, statusWrap, controlsWrap, tableWrap, pagerWrap]);

  function getMergedRow(row) {
    const patch = st.dirty.get(row.id);
    return patch ? Object.assign({}, row, patch) : row;
  }

  function stageField(row, field, value) {
    const existing = Object.assign({}, st.dirty.get(row.id) || {});
    const orig = row[field];
    const same = Array.isArray(orig) && Array.isArray(value)
      ? orig.join(',') === value.join(',')
      : orig === value;
    if (same) {
      delete existing[field];
    } else {
      existing[field] = value;
    }
    if (Object.keys(existing).length === 0) st.dirty.delete(row.id);
    else st.dirty.set(row.id, existing);
    updateActionBar();
  }

  function renderStatusBanner(data) {
    const writesEnabled = !!(data && data.writesEnabled);

    const badge = writesEnabled
      ? h('span.badge.ok', 'LIVE WRITES ENABLED')
      : h('span.badge.warn', 'READ-ONLY MODE');

    const msg = writesEnabled
      ? 'Live push to Lightspeed is active (Owner/Admin only, with automatic backup in Audit Log).'
      : 'Direct push to Lightspeed is locked. Edit cells and Export CSV anytime, or click Enable Live Writes when ready.';

    const canManage = !ctx.can || ctx.can('catalog.write');
    const modeActions = [];
    if (canManage && ctx.api.lightspeedSetMode) {
      if (writesEnabled) {
        modeActions.push(h('button.btn.sm.danger', {
          onclick: async () => {
            const ok = await confirmDialog({
              title: 'Pause & Switch to Read-Only?',
              message: 'This immediately blocks all live Lightspeed pushes from the HUB until re-enabled.',
              confirmLabel: 'Switch to Read-Only',
              danger: true,
            });
            if (!ok) return;
            try {
              await ctx.api.lightspeedSetMode(true);
              toast('Switched to Read-Only mode', 'ok');
              load();
            } catch (err) {
              toast(err.message || 'Could not switch mode', 'bad');
            }
          },
        }, 'Stop / Switch to Read-Only'));
      } else {
        modeActions.push(h('button.btn.sm.primary', {
          onclick: async () => {
            const ok = await confirmDialog({
              title: 'Enable Live Lightspeed Writes?',
              message: 'Owner/Admin pushes from this sheet will update Lightspeed R-Series directly (with automatic before-snapshot in Audit Log).',
              confirmLabel: 'Enable Live Writes',
            });
            if (!ok) return;
            try {
              await ctx.api.lightspeedSetMode(false);
              toast('Live Lightspeed writes enabled', 'ok');
              load();
            } catch (err) {
              toast(err.message || 'Could not enable writes', 'bad');
            }
          },
        }, 'Enable Live Writes'));
      }
    }
    if (ctx.api.syncLightspeed) {
      modeActions.push(h('button.btn.sm', {
        onclick: async () => {
          try {
            await ctx.api.syncLightspeed();
            toast('Lightspeed sync started — refresh in a few seconds for new items.', 'ok');
          } catch (err) {
            toast(err.message || 'Could not start sync', 'bad');
          }
        },
      }, 'Sync from Lightspeed'));
    }
    modeActions.push(h('a.btn.sm', { href: '#/integrations' }, 'OAuth Connections'));

    mount(statusWrap, card(null, [
      h('div.lss-status-bar', [
        h('div.lss-status-copy', [
          badge,
          h('span.muted.small', msg),
        ]),
        h('div.lss-status-actions', modeActions),
      ]),
    ]));
  }

  let discardBtn = null;
  let pushBtn = null;
  let exportBtn = null;
  let applyBulkBtn = null;
  let viewModeBar = null;

  function updateActionBar() {
    const n = st.dirty.size;
    const selCount = st.selected.size;
    if (discardBtn) {
      discardBtn.textContent = 'Discard (' + n + ')';
      discardBtn.disabled = n === 0;
    }
    if (pushBtn) {
      pushBtn.textContent = 'Push to Lightspeed (' + n + ')';
      pushBtn.disabled = n === 0;
    }
    if (exportBtn) {
      exportBtn.textContent = n > 0 ? 'Export CSV (' + n + ' changed)' : 'Export Visible CSV';
    }
    if (applyBulkBtn) {
      applyBulkBtn.textContent = selCount > 0 ? 'Apply to ' + selCount + ' Selected' : 'Apply to Visible Page';
    }
    if (viewModeBar) {
      Array.from(viewModeBar.querySelectorAll('button')).forEach((b) => {
        b.classList.toggle('on', b.dataset.mode === st.viewMode);
      });
    }
  }

  function buildControls() {
    const qInput = h('input', { type: 'search', class: 'lss-q', placeholder: 'Search description, System ID, UPC, MPN…', value: st.filter.q });
    const stockSel = h('select', { class: 'lss-sel' }, [
      h('option', { value: 'physical', selected: st.filter.stock === 'physical' }, 'In Stock Only'),
      h('option', { value: 'any', selected: st.filter.stock === 'any' }, 'All Active Items'),
      h('option', { value: 'unavailable', selected: st.filter.stock === 'unavailable' }, 'Out of Stock'),
    ]);
    const brandSel = h('select', { class: 'lss-sel' }, [
      h('option', { value: '' }, 'All brands'),
      ...facets.brands.map((b) => h('option', { value: b.value, selected: st.filter.brands === b.value }, b.value + ' (' + b.n + ')')),
    ]);
    const catSel = h('select', { class: 'lss-sel' }, [
      h('option', { value: '' }, 'All categories'),
      ...facets.categories.map((c) => h('option', { value: c.value, selected: st.filter.categories === c.value }, c.value + ' (' + c.n + ')')),
    ]);
    const tagInput = h('input', { type: 'search', class: 'lss-tag', placeholder: 'Tag…', value: st.filter.tag });

    const limitSel = h('select', { class: 'lss-limit' }, [
      h('option', { value: '50', selected: st.limit === 50 }, '50 / page'),
      h('option', { value: '100', selected: st.limit === 100 }, '100 / page'),
      h('option', { value: '200', selected: st.limit === 200 }, '200 / page'),
    ]);

    const applyFilters = () => {
      st.filter.q = qInput.value.trim();
      st.filter.stock = stockSel.value;
      st.filter.brands = brandSel.value;
      st.filter.categories = catSel.value;
      st.filter.tag = tagInput.value.trim();
      st.offset = 0;
      load();
    };
    qInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyFilters(); });
    tagInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyFilters(); });
    stockSel.addEventListener('change', applyFilters);
    brandSel.addEventListener('change', applyFilters);
    catSel.addEventListener('change', applyFilters);
    limitSel.addEventListener('change', () => {
      st.limit = Number(limitSel.value) || 50;
      st.offset = 0;
      load();
    });

    const searchBtn = h('button.btn.sm', { onclick: applyFilters }, 'Filter');
    const stdBtn = h('button.btn.sm', {
      title: 'Find & replace a tag across all visible rows',
      onclick: () => {
        if (!st.data || !st.data.items.length) return;
        const fromTag = window.prompt('Find tag to replace (exact match):', '');
        if (!fromTag || !fromTag.trim()) return;
        const toTag = window.prompt('Replace "' + fromTag.trim() + '" with (leave blank to remove):', '');
        if (toTag === null) return;
        const fromLow = fromTag.trim().toLowerCase();
        const toClean = toTag.trim();
        let count = 0;
        st.data.items.forEach((row) => {
          const cur = getMergedRow(row);
          const tags = Array.isArray(cur.tags) ? cur.tags : [];
          if (tags.some((t) => String(t).toLowerCase() === fromLow)) {
            const mapped = tags
              .map((t) => (String(t).toLowerCase() === fromLow ? toClean : t))
              .filter(Boolean);
            const next = Array.from(new Set(mapped));
            stageField(row, 'tags', next);
            count++;
          }
        });
        renderTable();
        toast(count ? 'Updated tag on ' + count + ' visible row(s)' : 'No visible rows had tag "' + fromTag.trim() + '"', 'ok');
      },
    }, 'Replace Tag');

    discardBtn = h('button.btn.sm', {
      disabled: true,
      onclick: () => {
        st.dirty.clear();
        renderTable();
        updateActionBar();
        toast('Discarded staged edits', 'ok');
      },
    }, 'Discard (0)');

    exportBtn = h('button.btn.sm', {
      onclick: () => {
        if (!st.data) return;
        const rows = st.dirty.size > 0
          ? st.data.items.filter((r) => st.dirty.has(r.id)).map(getMergedRow)
          : st.data.items.map(getMergedRow);
        if (!rows.length) {
          toast('No rows to export on this page', 'bad');
          return;
        }
        const header = [
          'System ID', 'UPC', 'Manufact. SKU', 'Description', 'Custom SKU', 'Tags',
          'Default Price', 'MSRP', 'Sale Price', 'Online Price', 'Default Cost',
          'Reorder Point', 'Desired Inventory Level',
        ];
        const body = rows.map((r) => [
          r.sku,
          r.upc,
          r.mpn,
          r.description,
          r.customSku,
          (r.tags || []).join(', '),
          centsToInput(r.defaultPriceCents),
          centsToInput(r.msrpCents),
          centsToInput(r.salePriceCents),
          centsToInput(r.onlinePriceCents),
          centsToInput(r.defaultCostCents),
          r.reorderPoint,
          r.desiredLevel,
        ]);
        downloadCsv('lightspeed-bulk-sheet.csv', [header, ...body]);
        toast('Exported ' + rows.length + ' rows to CSV', 'ok');
      },
    }, 'Export Visible CSV');

    pushBtn = h('button.btn.primary.sm', {
      disabled: true,
      onclick: async () => {
        const changes = Array.from(st.dirty.entries()).map(([id, patch]) => Object.assign({ id }, patch));
        if (!changes.length) return;
        const ok = await confirmDialog({
          title: 'Push ' + changes.length + ' item updates?',
          message: 'This will submit ' + changes.length + ' modified row(s) to Lightspeed POS with an automatic before-snapshot in Audit Log.',
          confirmLabel: 'Push Changes',
        });
        if (!ok) return;
        try {
          const res = await ctx.api.lightspeedBulkUpdate(changes);
          st.dirty.clear();
          toast('Saved ' + (res.updated || changes.length) + ' item(s)' + (res.demo ? ' (DEMO)' : ''), 'ok');
          load();
        } catch (err) {
          toast(err.message || 'Lightspeed write blocked', 'bad');
        }
      },
    }, 'Push to Lightspeed (0)');

    viewModeBar = h('div.seg-group.lss-view-modes', VIEW_MODES.map((m) => h('button.seg-btn', {
      type: 'button',
      class: st.viewMode === m.id ? 'seg-btn on' : 'seg-btn',
      dataset: { mode: m.id },
      onclick: () => {
        st.viewMode = m.id;
        updateActionBar();
        renderTable();
      },
    }, m.label)));

    const bulkOpSel = h('select', { class: 'lss-bulk-op' }, [
      h('option', { value: 'sale_pct_off' }, 'Bulk: Sale ($) = Default − %'),
      h('option', { value: 'sale_usd_off' }, 'Bulk: Sale ($) = Default − $'),
      h('option', { value: 'set_sale' }, 'Bulk: Set Sale ($)'),
      h('option', { value: 'clear_sale' }, 'Bulk: Clear Sale ($)'),
      h('option', { value: 'set_default' }, 'Bulk: Set Default ($)'),
      h('option', { value: 'set_online' }, 'Bulk: Set Online ($)'),
      h('option', { value: 'add_tag' }, 'Bulk: Add Tag'),
      h('option', { value: 'remove_tag' }, 'Bulk: Remove Tag'),
      h('option', { value: 'set_reorder' }, 'Bulk: Set Reorder Pt'),
      h('option', { value: 'set_desired' }, 'Bulk: Set Desired Lvl'),
    ]);
    const bulkValInp = h('input', { type: 'text', class: 'lss-bulk-val', placeholder: 'e.g. 15 or tag…' });
    bulkOpSel.addEventListener('change', () => {
      bulkValInp.disabled = bulkOpSel.value === 'clear_sale';
      if (bulkOpSel.value === 'clear_sale') bulkValInp.value = '';
    });

    applyBulkBtn = h('button.btn.sm', {
      onclick: () => {
        if (!st.data || !st.data.items.length) return;
        const op = bulkOpSel.value;
        const rawVal = bulkValInp.value.trim();
        if (op !== 'clear_sale' && !rawVal) {
          toast('Enter a value or tag for Bulk Apply first', 'bad');
          return;
        }
        const targets = st.selected.size > 0
          ? st.data.items.filter((r) => st.selected.has(r.id))
          : st.data.items;
        let count = 0;
        targets.forEach((row) => {
          const cur = getMergedRow(row);
          if (op === 'clear_sale') {
            stageField(row, 'salePriceCents', null);
            count++;
          } else if (op === 'add_tag') {
            const tags = Array.isArray(cur.tags) ? cur.tags.slice() : [];
            if (!tags.some((t) => String(t).toLowerCase() === rawVal.toLowerCase())) tags.push(rawVal);
            stageField(row, 'tags', tags);
            count++;
          } else if (op === 'remove_tag') {
            const tags = (Array.isArray(cur.tags) ? cur.tags : []).filter((t) => String(t).toLowerCase() !== rawVal.toLowerCase());
            stageField(row, 'tags', tags);
            count++;
          } else if (op === 'sale_pct_off') {
            const pct = Number(rawVal);
            if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) return;
            const base = cur.defaultPriceCents || 0;
            if (base > 0) {
              stageField(row, 'salePriceCents', Math.max(1, Math.round(base * (1 - pct / 100))));
              count++;
            }
          } else if (op === 'sale_usd_off') {
            const offCents = inputToCents(rawVal);
            const base = cur.defaultPriceCents || 0;
            if (offCents && base > offCents) {
              stageField(row, 'salePriceCents', base - offCents);
              count++;
            }
          } else if (op === 'set_sale' || op === 'set_default' || op === 'set_online') {
            const cents = inputToCents(rawVal);
            if (cents !== null && !Number.isNaN(cents)) {
              const f = op === 'set_sale' ? 'salePriceCents' : op === 'set_default' ? 'defaultPriceCents' : 'onlinePriceCents';
              stageField(row, f, cents);
              count++;
            }
          } else if (op === 'set_reorder' || op === 'set_desired') {
            const n = Number(rawVal);
            if (Number.isInteger(n) && n >= 0) {
              stageField(row, op === 'set_reorder' ? 'reorderPoint' : 'desiredLevel', n);
              count++;
            }
          }
        });
        if (!count) {
          toast('Invalid value or no applicable rows', 'bad');
          return;
        }
        renderTable();
        updateActionBar();
        toast('Applied bulk edit to ' + count + ' row(s) — review and click Push to Lightspeed', 'ok');
      },
    }, 'Apply to Visible Page');

    mount(controlsWrap, card(null, [
      h('div.lss-controls', [
        h('div.lss-filter-row', [
          qInput,
          stockSel,
          brandSel,
          catSel,
          tagInput,
          limitSel,
          searchBtn,
          stdBtn,
        ]),
        h('div.lss-mode-row', [
          h('div.lss-mode-left', [
            h('span.lss-label', 'Columns:'),
            viewModeBar,
          ]),
          h('div.lss-actions', [discardBtn, exportBtn, pushBtn]),
        ]),
        h('div.lss-bulk-row', [
          h('span.lss-label', 'Bulk Fill:'),
          bulkOpSel,
          bulkValInp,
          applyBulkBtn,
          h('span.muted.small.lss-bulk-hint', 'Check rows below to target specific items, or leave unchecked to fill the visible page.'),
        ]),
      ]),
    ]));
  }

  function makeCellInput(row, colIdx, rowIdx, opts) {
    const cur = getMergedRow(row);
    const patch = st.dirty.get(row.id);
    const isDirty = patch && Object.prototype.hasOwnProperty.call(patch, opts.field);
    const cls = ['lss-inp'];
    if (opts.numeric) cls.push('lss-inp-num');
    if (isDirty) cls.push('is-dirty');

    const inp = h('input', {
      type: 'text',
      inputmode: opts.numeric ? 'decimal' : undefined,
      class: cls.join(' '),
      value: opts.format ? opts.format(cur[opts.field]) : String(cur[opts.field] ?? ''),
      'aria-label': opts.label + ' for ' + (row.sku || row.description || 'item'),
      'data-ls-row': String(rowIdx),
      'data-ls-col': String(colIdx),
    });

    inp.addEventListener('change', () => {
      const parsed = opts.parse(inp.value);
      if (parsed === undefined || Number.isNaN(parsed)) {
        inp.classList.add('is-invalid');
        toast('Invalid value in ' + opts.label, 'bad');
        return;
      }
      inp.classList.remove('is-invalid');
      stageField(row, opts.field, parsed);
      const nowDirty = st.dirty.get(row.id) && Object.prototype.hasOwnProperty.call(st.dirty.get(row.id), opts.field);
      inp.classList.toggle('is-dirty', !!nowDirty);
    });

    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const origVal = opts.format ? opts.format(row[opts.field]) : String(row[opts.field] ?? '');
        inp.value = origVal;
        stageField(row, opts.field, row[opts.field]);
        inp.classList.remove('is-dirty', 'is-invalid');
        return;
      }
      if (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const delta = e.key === 'ArrowUp' ? -1 : 1;
        const next = tableWrap.querySelector('input[data-ls-row="' + (rowIdx + delta) + '"][data-ls-col="' + colIdx + '"]');
        if (next) {
          e.preventDefault();
          next.focus();
          next.select();
        }
      }
    });

    return inp;
  }

  function renderTable() {
    if (!st.data) return;
    const items = st.data.items || [];
    if (!items.length) {
      mount(tableWrap, card(null, h('p.muted', 'No items match the current filters.')));
      return;
    }

    const activeCols = ALL_COLUMNS.filter((c) => c.groups.includes(st.viewMode));
    const showExtraIds = st.viewMode === 'identity';

    const allChecked = items.length > 0 && items.every((r) => st.selected.has(r.id));
    const headChk = h('input', {
      type: 'checkbox',
      checked: allChecked,
      'aria-label': 'Select all visible rows',
      onchange: (e) => {
        items.forEach((r) => {
          if (e.target.checked) st.selected.add(r.id);
          else st.selected.delete(r.id);
        });
        renderTable();
        updateActionBar();
      },
    });

    const thead = h('thead', h('tr', [
      h('th.lss-th.lss-sticky-col', [
        h('div.lss-id-head', [
          headChk,
          h('span', 'Item ID'),
        ]),
      ]),
      showExtraIds ? h('th.lss-th', 'UPC / EAN') : null,
      showExtraIds ? h('th.lss-th', 'Manufact. SKU') : null,
      ...activeCols.map((c) => h('th', {
        class: 'lss-th ' + c.cls + (c.numeric ? ' num' : ''),
      }, c.label)),
    ]));

    const tbody = h('tbody', items.map((row, rowIdx) => {
      const isRowDirty = st.dirty.has(row.id);
      const rowChk = h('input', {
        type: 'checkbox',
        checked: st.selected.has(row.id),
        'aria-label': 'Select ' + (row.sku || row.description || 'row'),
        onchange: (e) => {
          if (e.target.checked) st.selected.add(row.id);
          else st.selected.delete(rId(row));
          updateActionBar();
        },
      });
      function rId(r) { return r.id; }

      const undoBtn = h('button.btn.sm.lss-undo', {
        type: 'button',
        disabled: !isRowDirty,
        title: 'Revert row changes',
        onclick: () => {
          st.dirty.delete(row.id);
          renderTable();
          updateActionBar();
        },
      }, '↺');

      const subIds = [row.upc ? 'UPC ' + row.upc : null, row.mpn ? 'MPN ' + row.mpn : null].filter(Boolean).join(' · ');

      return h('tr', { class: isRowDirty ? 'lss-row is-dirty-row' : 'lss-row' }, [
        h('td.lss-td.lss-sticky-col', [
          h('div.lss-id-cell', [
            rowChk,
            undoBtn,
            h('div.lss-id-meta', [
              h('a.lss-sku-link', { href: '#/products/' + row.id, title: 'Open Item Details' }, row.sku || '—'),
              !showExtraIds && subIds ? h('span.lss-sub-ids', subIds) : null,
            ]),
          ]),
        ]),
        showExtraIds ? h('td.lss-td.lss-mono', { 'data-label': 'UPC / EAN' }, row.upc || '—') : null,
        showExtraIds ? h('td.lss-td.lss-mono', { 'data-label': 'Manufact. SKU' }, row.mpn || '—') : null,
        ...activeCols.map((c, colIdx) => h('td', {
          class: 'lss-td ' + c.cls,
          'data-label': c.label,
        }, makeCellInput(row, colIdx, rowIdx, c))),
      ]);
    }));

    const scrollBox = h('div.lss-scroll', [
      h('table', { class: 'lss-table mode-' + st.viewMode }, [thead, tbody]),
    ]);

    const scrollLeftBtn = h('button.btn.sm.ghost', {
      type: 'button',
      onclick: () => scrollBox.scrollBy({ left: -320, behavior: 'smooth' }),
    }, '◀ Left');
    const scrollRightBtn = h('button.btn.sm.ghost', {
      type: 'button',
      onclick: () => scrollBox.scrollBy({ left: 320, behavior: 'smooth' }),
    }, 'Right ▶');

    const sheetFootHint = st.viewMode === 'all'
      ? h('div.lss-scroll-bar', [
        h('span.muted.small', 'Tip: Switch Columns above to "Prices & Cost" to fit narrow laptop screens without horizontal scrolling, or scroll sideways here.'),
        h('div.lss-scroll-btns', [scrollLeftBtn, scrollRightBtn]),
      ])
      : null;

    mount(tableWrap, h('div.card.lss-sheet-card', [
      sheetFootHint,
      scrollBox,
    ]));
    updateActionBar();
  }

  async function load() {
    mount(tableWrap, loading('Loading Lightspeed sheet…'));
    try {
      const q = Object.assign({}, st.filter, { offset: st.offset, limit: st.limit });
      st.data = await ctx.api.lightspeedSheet(q);
      renderStatusBanner(st.data);
      renderTable();
      mount(pagerWrap, pager({
        total: st.data.total,
        offset: st.offset,
        limit: st.limit,
        onPage: (nextOffset) => {
          st.offset = nextOffset;
          load();
        },
      }));
    } catch (err) {
      mount(tableWrap, errorBox(err));
    }
  }

  buildControls();
  await load();
  return root;
}
