import { h, icon, mount, clear } from './dom.js';

export function toast(message, kind) {
  const root = document.getElementById('toasts');
  if (!root) return;
  const el = h('div.toast', { class: kind || '' }, message);
  root.appendChild(el);
  setTimeout(() => el.remove(), kind === 'bad' ? 7000 : 4000);
}

/** Generic modal. Returns { close, body, foot }. */
export function modal({ title, body, actions, wide, onClose }) {
  const root = document.getElementById('modal-root');
  const previous = document.activeElement;
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    if (previous && previous.focus) previous.focus();
    if (onClose) onClose();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const foot = h('div.modal-foot');
  const bodyEl = h('div.modal-body', body);
  const dialog = h('div.modal', { class: wide ? 'wide' : '', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div.modal-head', h('h2', title), h('button.btn.ghost.sm', { 'aria-label': 'Close', onclick: close }, icon('x'))),
    bodyEl, foot);
  const backdrop = h('div.modal-backdrop', { onclick: (e) => { if (e.target === backdrop) close(); } }, dialog);
  (actions || []).forEach((a) => foot.appendChild(a));
  root.appendChild(backdrop);
  document.addEventListener('keydown', onKey);
  const focusable = dialog.querySelector('input, select, textarea, .modal-foot .btn.primary');
  if (focusable) setTimeout(() => focusable.focus(), 30);
  return { close, body: bodyEl, foot };
}

/** Promise-based confirmation for sensitive operations. */
export function confirmDialog({ title, message, confirmLabel, danger, details }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; m.close(); resolve(v); } };
    const m = modal({
      title,
      body: [typeof message === 'string' ? h('p', message) : message, details || null],
      actions: [
        h('button.btn', { onclick: () => finish(false) }, 'Cancel'),
        h('button.btn', { class: danger ? 'danger solid' : 'primary', onclick: () => finish(true) }, confirmLabel || 'Confirm'),
      ],
      onClose: () => { if (!done) { done = true; resolve(false); } },
    });
  });
}

export function loading(text) {
  return h('div.loading-row', h('span.spinner'), ' ', text || 'Loading…');
}

export function errorBox(err) {
  return h('div.notice.bad', err && err.message ? err.message : String(err));
}

export function pageHead(title, sub, actions) {
  return h('div.page-head', h('div.titles', h('h1', title), sub ? h('div.sub', sub) : null), actions && actions.length ? h('div.actions', actions) : null);
}

/** Shared section tab bar for unified Lightspeed-style workspaces. */
export function sectionTabs(items, activeKey) {
  return h('nav.subnav', { 'aria-label': 'Section views' }, items.map(([key, label, href]) => h('a', {
    href,
    class: key === activeKey ? 'on' : '',
  }, label)));
}

export function card(title, body, opts) {
  const o = opts || {};
  return h('section.card', { class: o.class || '' },
    title ? h('div.card-head', h('h2', title), o.actions || null) : null,
    h('div.card-body', { class: o.flush ? 'flush' : '' }, body));
}

/**
 * Data table with sortable headers, optional row selection and pagination.
 * columns: [{ key, label, num, opt (hide on mobile), sortable, render(row) }]
 */
function extractSortVal(col, row) {
  if (typeof col.sortValue === 'function') return col.sortValue(row);
  if (row && row[col.key] !== undefined && row[col.key] !== null && typeof row[col.key] !== 'object') return row[col.key];
  if (col.render) {
    const out = col.render(row);
    if (out === null || out === undefined) return '';
    if (typeof out === 'string' || typeof out === 'number') return out;
    if (out && typeof out.textContent === 'string') return out.textContent.trim();
  }
  return '';
}

export function compareSortVals(aVal, bVal, dir) {
  const mult = dir === 'asc' ? 1 : -1;
  const aNum = typeof aVal === 'number' ? aVal : Number(String(aVal).replace(/[^0-9.-]+/g, ''));
  const bNum = typeof bVal === 'number' ? bVal : Number(String(bVal).replace(/[^0-9.-]+/g, ''));
  const aHasNum = aVal !== '' && aVal !== null && aVal !== undefined && !Number.isNaN(aNum) && /\d/.test(String(aVal));
  const bHasNum = bVal !== '' && bVal !== null && bVal !== undefined && !Number.isNaN(bNum) && /\d/.test(String(bVal));
  if (aHasNum && bHasNum) return (aNum - bNum) * mult;
  return String(aVal ?? '').localeCompare(String(bVal ?? ''), undefined, { numeric: true, sensitivity: 'base' }) * mult;
}

export function dataTable(opts) {
  const { columns, rows, sort, onSort, selectable, selected, onToggle, onToggleAll, onRowClick, empty, rowKey } = opts;
  const key = rowKey || ((r) => r.id);
  let localSort = sort || null;

  let primaryIdx = -1;
  for (let i = 0; i < columns.length; i++) {
    if (!columns[i].opt && columns[i].cls && columns[i].cls.indexOf('title-cell') >= 0) { primaryIdx = i; break; }
  }
  if (primaryIdx < 0) {
    for (let i = 0; i < columns.length; i++) {
      if (!columns[i].opt) { primaryIdx = i; break; }
    }
  }

  const wrap = h('div.table-wrap');

  function renderTableBody(currentRows) {
    const allOn = selectable && currentRows.length > 0 && currentRows.every((r) => selected.has(key(r)));
    const someOn = selectable && currentRows.some((r) => selected.has(key(r)));
    const activeSort = onSort ? sort : localSort;

    const head = h('tr',
      selectable ? h('th.check', h('input', { type: 'checkbox', 'aria-label': 'Select page', checked: allOn, indeterminate: !allOn && someOn, onchange: (e) => onToggleAll(currentRows.map(key), e.target.checked) })) : null,
      columns.map((c) => {
        const canSort = Boolean(c.label) && c.sortable !== false;
        const active = activeSort && activeSort.key === c.key;
        return h('th', {
          class: [c.num ? 'num' : '', c.opt ? 'col-opt' : '', canSort ? 'sortable' : ''].filter(Boolean).join(' '),
          onclick: canSort ? () => {
            if (onSort) {
              onSort(c.key);
              return;
            }
            const nextDir = active && activeSort.dir === 'desc' ? 'asc' : (active && activeSort.dir === 'asc' ? 'desc' : (c.num ? 'desc' : 'asc'));
            localSort = { key: c.key, dir: nextDir };
            const sorted = rows.slice().sort((a, b) => compareSortVals(extractSortVal(c, a), extractSortVal(c, b), nextDir));
            renderTableBody(sorted);
          } : null,
          'aria-sort': active ? (activeSort.dir === 'asc' ? 'ascending' : 'descending') : null,
          title: canSort ? 'Click to sort ascending / descending' : undefined,
        }, c.label, active ? h('span.arrow', activeSort.dir === 'asc' ? ' ▲' : ' ▼') : null);
      }));

    const body = currentRows.length
      ? currentRows.map((r) => h('tr', {
        class: [selectable && selected.has(key(r)) ? 'selected' : '', onRowClick ? 'clickable' : ''].filter(Boolean).join(' '),
        onclick: onRowClick ? (e) => { if (!e.target.closest('input,button,a,select')) onRowClick(r); } : null,
      },
      selectable ? h('td.check', h('input', { type: 'checkbox', 'aria-label': 'Select row', checked: selected.has(key(r)), onchange: (e) => onToggle(key(r), e.target.checked) })) : null,
      columns.map((c, idx) => h('td', {
        dataset: c.label ? { label: c.label } : undefined,
        class: [
          c.num ? 'num' : '',
          c.opt ? 'col-opt' : '',
          idx === primaryIdx ? 'td-primary' : '',
          !c.label ? 'td-empty-label' : '',
          c.cls || '',
        ].filter(Boolean).join(' '),
      }, c.render ? c.render(r) : r[c.key]))))
      : [h('tr.tr-empty', h('td.td-colspan', { colspan: String(columns.length + (selectable ? 1 : 0)) }, h('div.empty', empty || 'Nothing here yet.')))];

    wrap.replaceChildren(h('table.t', h('thead', head), h('tbody', body)));
  }

  renderTableBody(rows);
  return wrap;
}

export function pager({ total, limit, offset, onPage }) {
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);
  return h('div.pager',
    h('span', from + '–' + to + ' of ' + total.toLocaleString('en-US')),
    h('span.spacer'),
    h('button.btn.sm', { disabled: offset === 0, onclick: () => onPage(Math.max(0, offset - limit)) }, '‹ Prev'),
    h('button.btn.sm', { disabled: to >= total, onclick: () => onPage(offset + limit) }, 'Next ›'));
}

export function chips(options, selectedValues, onChange) {
  const set = new Set(selectedValues || []);
  const wrap = h('div.chips');
  const render = () => {
    clear(wrap);
    options.forEach((o) => {
      const v = typeof o === 'string' ? o : o.value;
      const label = typeof o === 'string' ? o : (o.label || o.value) + (o.n !== undefined ? ' · ' + o.n : '');
      wrap.appendChild(h('button.chip', {
        type: 'button', class: set.has(v) ? 'on' : '', 'aria-pressed': set.has(v) ? 'true' : 'false',
        onclick: () => { if (set.has(v)) set.delete(v); else set.add(v); render(); onChange(Array.from(set)); },
      }, label));
    });
  };
  render();
  return wrap;
}

/** Searchable multi-select chips: pins selected items on top, hides long tails behind "Show all". */
export function searchableChips(options, selectedValues, onChange, opts) {
  const o = opts || {};
  const set = new Set(selectedValues || []);
  let query = '';
  let showAll = false;
  const limit = o.limit || 20;
  const wrap = h('div.stack-sm');
  const chipsHost = h('div.chips');
  const footerHost = h('div.row');
  const searchInput = h('input', {
    type: 'search',
    placeholder: o.placeholder || 'Filter…',
    oninput: (e) => { query = (e.target.value || '').trim().toLowerCase(); render(); },
  });

  const render = () => {
    clear(chipsHost);
    clear(footerHost);
    const matches = options.filter((it) => {
      const v = String(typeof it === 'string' ? it : it.value);
      const lbl = String(typeof it === 'string' ? it : (it.label || it.value));
      return set.has(v) || !query || v.toLowerCase().includes(query) || lbl.toLowerCase().includes(query);
    });
    // Selected items always stay visible on top
    matches.sort((a, b) => {
      const va = typeof a === 'string' ? a : a.value;
      const vb = typeof b === 'string' ? b : b.value;
      const sa = set.has(va) ? 0 : 1;
      const sb = set.has(vb) ? 0 : 1;
      return sa - sb;
    });
    const visible = showAll || query ? matches : matches.slice(0, limit);
    visible.forEach((it) => {
      const v = typeof it === 'string' ? it : it.value;
      const label = typeof it === 'string' ? it : (it.label || it.value) + (it.n !== undefined ? ' · ' + it.n : '');
      chipsHost.appendChild(h('button.chip', {
        type: 'button', class: set.has(v) ? 'on' : '', 'aria-pressed': set.has(v) ? 'true' : 'false',
        onclick: () => { if (set.has(v)) set.delete(v); else set.add(v); render(); onChange(Array.from(set)); },
      }, label));
    });
    if (!visible.length) {
      chipsHost.appendChild(h('span.small.muted', 'No matches for “' + query + '”.'));
    }
    if (!query && matches.length > limit) {
      footerHost.appendChild(h('button.btn.sm.ghost', {
        type: 'button',
        onclick: () => { showAll = !showAll; render(); },
      }, showAll ? 'Show fewer' : 'Show all ' + matches.length));
    }
    if (set.size > 0) {
      footerHost.appendChild(h('button.btn.sm.ghost', {
        type: 'button',
        onclick: () => { set.clear(); render(); onChange([]); },
      }, 'Clear (' + set.size + ')'));
    }
  };

  render();
  wrap.appendChild(searchInput);
  wrap.appendChild(chipsHost);
  wrap.appendChild(footerHost);
  return wrap;
}

/** Searchable multi-select dropdown: keeps long lists (brands, categories, suppliers) compact. */
export function searchableDropdown(options, selectedValues, onChange, opts) {
  const o = opts || {};
  const set = new Set(selectedValues || []);
  let open = false;
  let query = '';
  const allLabel = o.allLabel || 'All';
  const noun = o.noun || 'items';

  const wrap = h('div.msd');
  const triggerText = h('span.msd-trigger-text');
  const trigger = h('button.msd-trigger', {
    type: 'button',
    'aria-expanded': 'false',
    onclick: (e) => {
      e.stopPropagation();
      open = !open;
      panel.hidden = !open;
      trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) {
        renderList();
        searchInput.focus();
      }
    },
  }, triggerText, h('span.msd-caret', '▾'));

  const searchInput = h('input.msd-search', {
    type: 'search',
    placeholder: o.placeholder || 'Search ' + noun + '…',
    onclick: (e) => e.stopPropagation(),
    oninput: (e) => {
      query = (e.target.value || '').trim().toLowerCase();
      renderList();
    },
  });

  const listHost = h('div.msd-list');
  const actionsHost = h('div.msd-actions');
  const panel = h('div.msd-panel', { hidden: true, onclick: (e) => e.stopPropagation() },
    h('div.msd-panel-top', searchInput, actionsHost),
    listHost);
  const tagsHost = h('div.msd-tags');

  const getMatches = () => options.filter((it) => {
    const v = String(typeof it === 'string' ? it : it.value);
    const lbl = String(typeof it === 'string' ? it : (it.label || it.value));
    return !query || v.toLowerCase().includes(query) || lbl.toLowerCase().includes(query);
  });

  const updateTriggerAndTags = () => {
    clear(tagsHost);
    if (set.size === 0) {
      triggerText.textContent = allLabel;
      trigger.classList.remove('has-val');
    } else if (set.size <= 2) {
      triggerText.textContent = Array.from(set).join(', ');
      trigger.classList.add('has-val');
    } else {
      triggerText.textContent = set.size + ' ' + noun + ' selected';
      trigger.classList.add('has-val');
    }
    if (set.size > 0) {
      Array.from(set).forEach((v) => {
        tagsHost.appendChild(h('button.msd-tag', {
          type: 'button',
          title: 'Remove ' + v,
          onclick: () => {
            set.delete(v);
            updateTriggerAndTags();
            if (open) renderList();
            onChange(Array.from(set));
          },
        }, v + ' ×'));
      });
      if (set.size > 1) {
        tagsHost.appendChild(h('button.msd-tag.clear', {
          type: 'button',
          onclick: () => {
            set.clear();
            updateTriggerAndTags();
            if (open) renderList();
            onChange([]);
          },
        }, 'Clear all'));
      }
    }
  };

  const renderList = () => {
    clear(listHost);
    clear(actionsHost);
    const matches = getMatches().slice();
    matches.sort((a, b) => {
      const va = typeof a === 'string' ? a : a.value;
      const vb = typeof b === 'string' ? b : b.value;
      return (set.has(va) ? 0 : 1) - (set.has(vb) ? 0 : 1);
    });

    if (query && matches.length > 0 && matches.length <= 25) {
      actionsHost.appendChild(h('button.btn.sm.ghost', {
        type: 'button',
        onclick: () => {
          matches.forEach((it) => set.add(typeof it === 'string' ? it : it.value));
          updateTriggerAndTags();
          renderList();
          onChange(Array.from(set));
        },
      }, 'Select ' + matches.length + ' matching'));
    }
    if (set.size > 0) {
      actionsHost.appendChild(h('button.btn.sm.ghost', {
        type: 'button',
        onclick: () => {
          set.clear();
          updateTriggerAndTags();
          renderList();
          onChange([]);
        },
      }, 'Clear (' + set.size + ')'));
    }

    if (!matches.length) {
      listHost.appendChild(h('div.msd-empty', 'No matches for “' + query + '”.'));
      return;
    }

    matches.slice(0, 120).forEach((it) => {
      const v = typeof it === 'string' ? it : it.value;
      const lbl = typeof it === 'string' ? it : (it.label || it.value);
      const checked = set.has(v);
      const cb = h('input', {
        type: 'checkbox',
        checked,
        onchange: () => {
          if (cb.checked) set.add(v); else set.delete(v);
          updateTriggerAndTags();
          onChange(Array.from(set));
        },
      });
      listHost.appendChild(h('label.msd-item', { class: checked ? 'on' : '' },
        cb,
        h('span.msd-item-lbl', lbl),
        it && it.n !== undefined ? h('span.msd-item-n', String(it.n)) : null));
    });
    if (matches.length > 120) {
      listHost.appendChild(h('div.msd-empty', 'Type to narrow down (' + (matches.length - 120) + ' more)…'));
    }
  };

  const onDocClick = (e) => {
    if (!document.body.contains(wrap)) {
      document.removeEventListener('click', onDocClick);
      return;
    }
    if (open && !wrap.contains(e.target)) {
      open = false;
      panel.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
    }
  };
  document.addEventListener('click', onDocClick);

  updateTriggerAndTags();
  wrap.appendChild(trigger);
  wrap.appendChild(panel);
  wrap.appendChild(tagsHost);
  return wrap;
}

/** Poll a job until it finishes, updating a progress element. */
export async function watchJob(api, jobId, progressEl, statusEl) {
  for (let i = 0; i < 600; i++) {
    const j = await api.job(jobId);
    const p = j.progress || {};
    if (progressEl && p.total) progressEl.style.width = Math.round((p.done / p.total) * 100) + '%';
    if (statusEl) statusEl.textContent = j.status + (p.total ? ' · ' + p.done + '/' + p.total : '');
    if (j.status === 'succeeded' || j.status === 'dead' || j.status === 'failed') return j;
    await new Promise((r) => setTimeout(r, i < 10 ? 300 : 1000));
  }
  throw new Error('Job is taking too long — check Activity');
}

export function progressBar() {
  const bar = h('div');
  return { el: h('div.progress', bar), bar };
}

export { mount };
