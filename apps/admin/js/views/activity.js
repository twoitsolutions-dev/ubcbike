import { h, mount } from '../ui/dom.js';
import { card, dataTable, pageHead, toast, errorBox } from '../ui/components.js';
import { dateTime } from '../ui/format.js';
import { settingsWorkspaceTabs } from './settings.js?v=90';
import { JOB_LABELS } from './dashboard.js?v=90';

export async function renderActivity(ctx) {
  const tabHost = h('div');
  const tabs = [['jobs', 'Background jobs'], ['errors', 'Errors'], ['audit', 'Audit trail']];
  let current = ctx.query.tab || 'jobs';
  const bar = h('div.row');
  const drawBar = () => {
    mount(bar, tabs.map(([k, label]) => h('button.btn', { class: current === k ? 'primary' : '', onclick: () => { current = k; drawBar(); draw(); } }, label)));
  };
  const draw = async () => {
    try {
      if (current === 'jobs') {
        const r = await ctx.api.jobs();
        mount(tabHost, card(null, dataTable({
          columns: [
            { key: 'id', label: '#', num: true },
            { key: 'type', label: 'Task', cls: 'title-cell', render: (j) => h('div', h('strong', JOB_LABELS[j.type] || j.type), h('div.sku', j.type)) },
            { key: 'status', label: 'Status', render: (j) => h('span.badge', { class: j.status === 'succeeded' ? 'ok' : j.status === 'dead' ? 'bad' : 'info' }, j.status) },
            { key: 'att', label: 'Attempts', num: true, opt: true, render: (j) => j.attempts + '/' + j.max_attempts },
            { key: 'when', label: 'Created', opt: true, render: (j) => dateTime(j.created_at) },
            { key: 'res', label: 'Result / error', render: (j) => h('code.small', (j.last_error || JSON.stringify(j.result || j.progress || {})).slice(0, 140)) },
            { key: 'act', label: '', render: (j) => (j.status === 'dead' && ctx.can('integrations.manage') && ctx.api.kind === 'http'
              ? h('button.btn.sm', { onclick: async () => { try { await ctx.api.retryJob(j.id); toast('Re-queued'); draw(); } catch (e) { toast(e.message, 'bad'); } } }, 'Retry') : null) },
          ],
          rows: r.jobs, empty: 'No jobs yet.',
        }), { flush: true }));
      } else if (current === 'errors') {
        const r = await ctx.api.errors();
        mount(tabHost, card(null, dataTable({
          columns: [
            { key: 'when', label: 'When', render: (e) => dateTime(e.created_at) },
            { key: 'source', label: 'Source', render: (e) => h('code', e.source) },
            { key: 'msg', label: 'Message', cls: 'title-cell', render: (e) => e.message },
            { key: 'st', label: 'Status', render: (e) => (e.resolved_at ? h('span.badge.ok', 'resolved') : h('span.badge.bad', 'open')) },
            { key: 'act', label: '', render: (e) => (!e.resolved_at ? h('button.btn.sm', { onclick: async () => { await ctx.api.resolveError(e.id); ctx.refreshBadges(); draw(); } }, 'Mark resolved') : null) },
          ],
          rows: r.errors, empty: 'No errors recorded.',
        }), { flush: true }));
      } else {
        const r = await ctx.api.audit();
        mount(tabHost, card(null, dataTable({
          columns: [
            { key: 'when', label: 'When', render: (a) => dateTime(a.created_at) },
            { key: 'actor', label: 'Who', render: (a) => a.actor || 'system' },
            { key: 'action', label: 'Action', render: (a) => h('code', a.action) },
            { key: 'entity', label: 'Entity', opt: true, render: (a) => (a.entity_type ? a.entity_type + ' ' + String(a.entity_id || '').slice(0, 12) : '—') },
            { key: 'detail', label: 'Detail', opt: true, render: (a) => h('code.small', JSON.stringify(a.detail || {}).slice(0, 120)) },
          ],
          rows: r.entries, empty: 'No audit entries.',
        }), { flush: true }));
      }
    } catch (e) { mount(tabHost, errorBox(e)); }
  };
  drawBar();
  draw();
  return h('div.stack',
    pageHead('Settings & Sync · Activity & Logs', 'Background jobs with retries, unresolved sync errors and the full audit trail of who changed what.'),
    settingsWorkspaceTabs('activity'),
    bar,
    tabHost);
}
