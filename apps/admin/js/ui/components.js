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
export function dataTable(opts) {
  const { columns, rows, sort, onSort, selectable, selected, onToggle, onToggleAll, onRowClick, empty, rowKey } = opts;
  const key = rowKey || ((r) => r.id);
  const allOn = selectable && rows.length > 0 && rows.every((r) => selected.has(key(r)));
  const someOn = selectable && rows.some((r) => selected.has(key(r)));
  let primaryIdx = -1;
  for (let i = 0; i < columns.length; i++) {
    if (!columns[i].opt && columns[i].cls && columns[i].cls.indexOf('title-cell') >= 0) { primaryIdx = i; break; }
  }
  if (primaryIdx < 0) {
    for (let i = 0; i < columns.length; i++) {
      if (!columns[i].opt) { primaryIdx = i; break; }
    }
  }
  const head = h('tr',
    selectable ? h('th.check', h('input', { type: 'checkbox', 'aria-label': 'Select page', checked: allOn, indeterminate: !allOn && someOn, onchange: (e) => onToggleAll(rows.map(key), e.target.checked) })) : null,
    columns.map((c) => {
      const active = sort && sort.key === c.key;
      return h('th', {
        class: [c.num ? 'num' : '', c.opt ? 'col-opt' : '', c.sortable ? 'sortable' : ''].filter(Boolean).join(' '),
        onclick: c.sortable && onSort ? () => onSort(c.key) : null,
        'aria-sort': active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : null,
      }, c.label, active ? h('span.arrow', sort.dir === 'asc' ? '▲' : '▼') : null);
    }));
  const body = rows.length
    ? rows.map((r) => h('tr', {
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
  return h('div.table-wrap', h('table.t', h('thead', head), h('tbody', body)));
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
