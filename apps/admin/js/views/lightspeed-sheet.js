import { h, mount } from '../ui/dom.js';
import { card, confirmDialog, errorBox, loading, pageHead, pager, toast } from '../ui/components.js';
import { itemSearchTabs } from './products.js?v=54';

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

export async function renderLightspeedSheet(ctx) {
  const root = h('div');

  const facets = await ctx.api.facets();
  const st = {
    filter: {
      q: ctx.query.q || '',
      brands: ctx.query.brands || '',
      categories: ctx.query.categories || '',
      stock: ctx.query.stock || 'physical',
      tag: ctx.query.tag || '',
    },
    offset: 0,
    limit: 50,
    data: null,
    dirty: new Map(),
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
    const serverWritesEnabled = !!(data && data.serverWritesEnabled);
    const writePaused = !!(data && data.writePaused);

    const badge = writesEnabled
      ? h('span.badge.ok', 'LIVE WRITES ENABLED')
      : writePaused
        ? h('span.badge.warn', 'PAUSED · READ-ONLY')
        : h('span.badge.warn', 'READ-ONLY (Server Lock)');

    const msg = writesEnabled
      ? 'Live push to Lightspeed is active (Owner/Admin only, with automatic backup in Audit Log).'
      : writePaused
        ? 'Live writes are paused by Owner/Admin. You can still edit cells and Export CSV safely.'
        : 'Server safety lock is active (LIGHTSPEED_WRITES_ENABLED=false). Export CSV works immediately.';

    const canManage = !ctx.can || ctx.can('catalog.write');
    const modeActions = [];
    if (canManage && ctx.api.lightspeedSetMode) {
      if (!writePaused) {
        modeActions.push(h('button.btn.sm.danger', {
          onclick: async () => {
            const ok = await confirmDialog({
              title: 'Pause & Switch to Read-Only?',
              message: 'This immediately blocks all live Lightspeed pushes from the HUB until resumed.',
              confirmLabel: 'Switch to Read-Only',
              danger: true,
            });
            if (!ok) return;
            try {
              await ctx.api.lightspeedSetMode(true);
              toast('Lightspeed Bulk Sheet paused (Read-Only)', 'info');
              load();
            } catch (err) {
              toast(err.message || 'Could not pause', 'err');
            }
          },
        }, 'Stop / Switch to Read-Only'));
      } else {
        modeActions.push(h('button.btn.sm.primary', {
          onclick: async () => {
            if (!serverWritesEnabled) {
              toast('Server lock LIGHTSPEED_WRITES_ENABLED=false is still active on Hostinger.', 'warn');
            }
            try {
              await ctx.api.lightspeedSetMode(false);
              toast(serverWritesEnabled ? 'Live Lightspeed writes resumed' : 'Unpaused (waiting for server LIGHTSPEED_WRITES_ENABLED=true)', 'ok');
              load();
            } catch (err) {
              toast(err.message || 'Could not resume', 'err');
            }
          },
        }, 'Resume Live Writes'));
      }
    }
    if (ctx.api.syncLightspeed) {
      modeActions.push(h('button.btn.sm.outline', {
        onclick: async () => {
          try {
            await ctx.api.syncLightspeed();
            toast('Lightspeed sync started — refresh in a few seconds for new items.', 'ok');
          } catch (err) {
            toast(err.message || 'Could not start sync', 'err');
          }
        },
      }, 'Sync from Lightspeed'));
    }
    modeActions.push(h('a.btn.sm.outline', { href: '#/integrations' }, 'OAuth Connections'));

    mount(statusWrap, card(null, [
      h('div.row', { style: 'gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap' }, [
        h('div.row', { style: 'gap:10px;align-items:center;flex-wrap:wrap' }, [
          badge,
          h('span.muted', { style: 'font-size:13px' }, msg),
        ]),
        h('div.row', { style: 'gap:8px;align-items:center;flex-wrap:wrap' }, modeActions),
      ]),
    ]));
  }

  let discardBtn = null;
  let pushBtn = null;
  let exportBtn = null;

  function updateActionBar() {
    const n = st.dirty.size;
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
  }

  function buildControls() {
    const qInput = h('input.input', { type: 'search', placeholder: 'Search description, System ID, UPC, MPN…', value: st.filter.q, style: 'width:220px;flex:1 1 180px' });
    const stockSel = h('select.input', { style: 'width:auto;max-width:155px' }, [
      h('option', { value: 'physical', selected: st.filter.stock === 'physical' }, 'In Stock Only'),
      h('option', { value: 'any', selected: st.filter.stock === 'any' }, 'All Active Items'),
      h('option', { value: 'unavailable', selected: st.filter.stock === 'unavailable' }, 'Out of Stock'),
    ]);
    const brandSel = h('select.input', { style: 'width:auto;max-width:155px' }, [
      h('option', { value: '' }, 'All brands'),
      ...facets.brands.map((b) => h('option', { value: b.value, selected: st.filter.brands === b.value }, b.value + ' (' + b.n + ')')),
    ]);
    const catSel = h('select.input', { style: 'width:auto;max-width:155px' }, [
      h('option', { value: '' }, 'All categories'),
      ...facets.categories.map((c) => h('option', { value: c.value, selected: st.filter.categories === c.value }, c.value + ' (' + c.n + ')')),
    ]);
    const tagInput = h('input.input', { type: 'search', placeholder: 'Tag…', value: st.filter.tag, style: 'width:110px' });

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

    const searchBtn = h('button.btn.sm', { onClick: applyFilters }, 'Filter');
    const stdBtn = h('button.btn.sm', {
      title: 'Find & replace a tag across all visible rows',
      onClick: () => {
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
        toast(count ? 'Updated tag on ' + count + ' visible row(s)' : 'No visible rows had tag "' + fromTag.trim() + '"', count ? 'ok' : 'info');
      },
    }, 'Replace Tag');

    discardBtn = h('button.btn.sm', {
      disabled: true,
      onClick: () => {
        st.dirty.clear();
        renderTable();
        updateActionBar();
        toast('Discarded staged edits', 'info');
      },
    }, 'Discard (0)');

    exportBtn = h('button.btn.sm', {
      onClick: () => {
        if (!st.data) return;
        const rows = st.dirty.size > 0
          ? st.data.items.filter((r) => st.dirty.has(r.id)).map(getMergedRow)
          : st.data.items.map(getMergedRow);
        if (!rows.length) {
          toast('No rows to export on this page', 'warn');
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
      onClick: async () => {
        const changes = Array.from(st.dirty.entries()).map(([id, patch]) => Object.assign({ id }, patch));
        if (!changes.length) return;
        const ok = await confirmDialog({
          title: 'Push ' + changes.length + ' item updates?',
          message: 'This will submit ' + changes.length + ' modified row(s) to the Lightspeed bulk-update endpoint.',
          confirmLabel: 'Push Changes',
        });
        if (!ok) return;
        try {
          const res = await ctx.api.lightspeedBulkUpdate(changes);
          st.dirty.clear();
          toast('Saved ' + (res.updated || changes.length) + ' item(s)' + (res.demo ? ' (DEMO)' : ''), 'ok');
          load();
        } catch (err) {
          toast(err.message || 'Lightspeed write blocked', 'err');
        }
      },
    }, 'Push to Lightspeed (0)');

    mount(controlsWrap, card(null, [
      h('div.row', { style: 'gap:8px;flex-wrap:wrap;align-items:center;justify-content:space-between' }, [
        h('div.row', { style: 'gap:8px;flex-wrap:wrap;align-items:center' }, [qInput, stockSel, brandSel, catSel, tagInput, searchBtn, stdBtn]),
        h('div.row', { style: 'gap:8px;flex-wrap:wrap;align-items:center' }, [discardBtn, exportBtn, pushBtn]),
      ]),
    ]));
  }

  function makeCellInput(row, colIdx, rowIdx, opts) {
    const cur = getMergedRow(row);
    const patch = st.dirty.get(row.id);
    const isDirty = patch && Object.prototype.hasOwnProperty.call(patch, opts.field);
    const inp = h('input.input', {
      type: opts.type || 'text',
      value: opts.format ? opts.format(cur[opts.field]) : String(cur[opts.field] ?? ''),
      'data-ls-row': String(rowIdx),
      'data-ls-col': String(colIdx),
      style: [
        'padding:4px 6px;font-size:12px;height:28px;border-radius:4px',
        opts.width ? 'width:' + opts.width : 'width:100%',
        opts.numeric ? 'text-align:right;font-variant-numeric:tabular-nums' : '',
        isDirty ? 'border-color:#d97706;background:#fffbeb' : '',
      ].filter(Boolean).join(';'),
    });

    inp.addEventListener('change', () => {
      const parsed = opts.parse(inp.value);
      if (parsed === undefined || Number.isNaN(parsed)) {
        inp.style.borderColor = '#dc2626';
        toast('Invalid value in ' + opts.label, 'err');
        return;
      }
      stageField(row, opts.field, parsed);
      const nowDirty = st.dirty.get(row.id) && Object.prototype.hasOwnProperty.call(st.dirty.get(row.id), opts.field);
      inp.style.borderColor = nowDirty ? '#d97706' : '';
      inp.style.background = nowDirty ? '#fffbeb' : '';
    });

    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const origVal = opts.format ? opts.format(row[opts.field]) : String(row[opts.field] ?? '');
        inp.value = origVal;
        stageField(row, opts.field, row[opts.field]);
        inp.style.borderColor = '';
        inp.style.background = '';
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

    const cols = [
      { label: 'Description', field: 'description', width: '240px', parse: (v) => String(v || '').trim() || undefined },
      { label: 'Custom SKU', field: 'customSku', width: '125px', parse: (v) => String(v || '').trim() },
      { label: 'Tags', field: 'tags', width: '145px', format: (v) => (Array.isArray(v) ? v.join(', ') : ''), parse: parseTags },
      { label: 'Default ($)', field: 'defaultPriceCents', width: '88px', numeric: true, format: centsToInput, parse: (v) => { const c = inputToCents(v); return c === null ? NaN : c; } },
      { label: 'MSRP ($)', field: 'msrpCents', width: '88px', numeric: true, format: centsToInput, parse: inputToCents },
      { label: 'Sale ($)', field: 'salePriceCents', width: '88px', numeric: true, format: centsToInput, parse: inputToCents },
      { label: 'Online ($)', field: 'onlinePriceCents', width: '88px', numeric: true, format: centsToInput, parse: inputToCents },
      { label: 'Cost ($)', field: 'defaultCostCents', width: '88px', numeric: true, format: centsToInput, parse: inputToCents },
      { label: 'Reorder Pt', field: 'reorderPoint', width: '74px', numeric: true, parse: (v) => { const n = Number(String(v || '').trim() || '0'); return Number.isInteger(n) && n >= 0 ? n : NaN; } },
      { label: 'Desired Lvl', field: 'desiredLevel', width: '78px', numeric: true, parse: (v) => { const n = Number(String(v || '').trim() || '0'); return Number.isInteger(n) && n >= 0 ? n : NaN; } },
    ];

    const thead = h('thead', h('tr', [
      h('th', { style: 'position:sticky;top:0;background:var(--bg-card,#fff);z-index:2;font-size:11px;white-space:nowrap' }, '↺'),
      h('th', { style: 'position:sticky;top:0;background:var(--bg-card,#fff);z-index:2;font-size:11px;white-space:nowrap' }, 'System ID'),
      h('th', { style: 'position:sticky;top:0;background:var(--bg-card,#fff);z-index:2;font-size:11px;white-space:nowrap' }, 'UPC'),
      h('th', { style: 'position:sticky;top:0;background:var(--bg-card,#fff);z-index:2;font-size:11px;white-space:nowrap' }, 'Manufact. SKU'),
      ...cols.map((c) => h('th', { style: 'position:sticky;top:0;background:var(--bg-card,#fff);z-index:2;font-size:11px;white-space:nowrap' + (c.numeric ? ';text-align:right' : '') }, c.label)),
    ]));

    const tbody = h('tbody', items.map((row, rowIdx) => {
      const isRowDirty = st.dirty.has(row.id);
      const undoBtn = h('button.btn.sm', {
        disabled: !isRowDirty,
        title: 'Revert row',
        style: 'padding:2px 6px;font-size:11px',
        onClick: () => {
          st.dirty.delete(row.id);
          renderTable();
          updateActionBar();
        },
      }, '↺');

      return h('tr', { style: isRowDirty ? 'background:#fffbeb55' : '' }, [
        h('td', { style: 'padding:4px 6px' }, undoBtn),
        h('td', { style: 'padding:4px 6px;font-family:monospace;font-size:11px;white-space:nowrap' }, row.sku || '—'),
        h('td', { style: 'padding:4px 6px;font-family:monospace;font-size:11px;white-space:nowrap' }, row.upc || '—'),
        h('td', { style: 'padding:4px 6px;font-family:monospace;font-size:11px;white-space:nowrap' }, row.mpn || '—'),
        ...cols.map((c, colIdx) => h('td', { style: 'padding:3px 4px' }, makeCellInput(row, colIdx, rowIdx, c))),
      ]);
    }));

    mount(tableWrap, h('div.card', { style: 'padding:0;overflow:auto;max-height:68vh' }, [
      h('table.table', { style: 'width:max-content;min-width:100%;border-collapse:collapse' }, [thead, tbody]),
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
