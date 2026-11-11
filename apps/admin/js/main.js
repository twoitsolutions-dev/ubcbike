import { CONFIG } from './config.js';
import { createHttpDriver } from './drivers/http.js';
import { h, icon, mount, clear } from './ui/dom.js';
import { toast, errorBox } from './ui/components.js';
import { routes, matchRoute } from './router.js';

const app = document.getElementById('app');
const state = { api: null, me: null, system: null, navOpen: false };

const NAV = [
  { group: 'Overview', items: [['#/dashboard', 'Dashboard', 'dashboard']] },
  { group: 'Catalog', items: [['#/products', 'Products', 'box'], ['#/inventory', 'Inventory', 'layers'], ['#/suppliers', 'Suppliers', 'truck']] },
  { group: 'Pricing', items: [['#/pricing', 'Prices & margins', 'dollar'], ['#/promotions', 'Promotions', 'tag']] },
  { group: 'Operations', items: [['#/orders', 'Orders', 'cart', 'awaitingApproval'], ['#/purchasing', 'Supplier purchasing', 'clipboard'], ['#/store', 'Store (simulated)', 'store']] },
  { group: 'System', items: [['#/integrations', 'Integrations', 'plug'], ['#/activity', 'History & errors', 'history', 'openErrors'], ['#/settings', 'Settings', 'settings']] },
];

async function loadDriver() {
  if (CONFIG.driver === 'demo') {
    const mod = await import('./drivers/demo.js');
    return mod.createDemoDriver();
  }
  return createHttpDriver();
}

function can(p) {
  return !!(state.me && state.me.permissions && state.me.permissions.indexOf(p) >= 0);
}

function closeNav() {
  state.navOpen = false;
  const nav = document.querySelector('.nav');
  const scrim = document.querySelector('.scrim');
  if (nav) nav.classList.remove('open');
  if (scrim) scrim.classList.remove('open');
}

let badgeCounts = {};
async function refreshBadges() {
  try {
    const d = await state.api.dashboard();
    badgeCounts = d.counts;
    document.querySelectorAll('[data-count]').forEach((el) => {
      const n = badgeCounts[el.dataset.count] || 0;
      el.textContent = n ? String(n) : '';
      el.hidden = !n;
    });
  } catch (e) { /* non-critical */ }
}

function renderShell() {
  const isDemo = state.system && state.system.mode === 'demo';
  const nav = h('nav.nav', { 'aria-label': 'Main' },
    h('div.nav-brand', h('div.boot-mark', 'UBC'), h('div', h('strong', 'UBC Commerce Hub'), h('small', 'University Bicycle Center'))),
    NAV.map((g) => h('div.nav-group', h('div.nav-group-label', g.group),
      g.items.map(([href, label, ic, countKey]) => h('a', { href, dataset: { nav: href }, onclick: closeNav }, icon(ic), h('span', label),
        countKey ? h('span.count', { dataset: { count: countKey }, hidden: true }) : null)))),
    h('div.nav-foot',
      h('div.who', state.me.user.name),
      h('div.role', roleLabel(state.me.user.role) + ' · ' + state.me.user.email),
      h('button.btn.sm', { onclick: logout }, 'Sign out')));
  const scrim = h('div.scrim', { onclick: closeNav });
  const crumbs = h('div.crumbs#crumbs');
  const topbar = h('header.topbar',
    h('button.btn.ghost.menu-btn', { 'aria-label': 'Open menu', onclick: () => { state.navOpen = true; nav.classList.add('open'); scrim.classList.add('open'); } }, icon('menu')),
    crumbs, h('div.spacer'),
    h('span.mode-pill', { class: isDemo ? '' : 'live', title: isDemo ? 'Fictitious data; no real system connected' : 'Connected to real systems' }, isDemo ? 'DEMO' : 'LIVE'));
  const banner = isDemo ? h('div.demo-banner', state.system.demoNotice || 'DEMO data') : null;
  const content = h('main.content#view', { tabindex: '-1' });
  mount(app, h('div.shell', nav, scrim, h('div.main', topbar, banner, content)));
  refreshBadges();
}

function roleLabel(r) {
  return { owner: 'Owner', admin: 'Administrator', purchasing: 'Purchasing & pricing', staff: 'Store staff', viewer: 'Viewer' }[r] || r;
}

let renderSeq = 0;
async function route() {
  if (!state.me) return;
  const hash = location.hash || '#/dashboard';
  const m = matchRoute(hash);
  if (!m) { location.hash = '#/dashboard'; return; }
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', hash.indexOf(a.dataset.nav) === 0));
  const crumbs = document.getElementById('crumbs');
  if (crumbs) crumbs.textContent = m.route.title;
  document.title = m.route.title + ' · UBC Commerce Hub';
  const view = document.getElementById('view');
  const seq = ++renderSeq;
  clear(view);
  view.removeAttribute('data-route');
  try {
    const ctx = { api: state.api, me: state.me, can, params: m.params, query: m.query, isCurrent: () => seq === renderSeq, refreshBadges, navigate: (to) => { location.hash = to; } };
    const node = await m.route.render(ctx);
    if (seq !== renderSeq) return;
    mount(view, node);
    view.setAttribute('data-route', hash.split('?')[0]);
    view.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  } catch (e) {
    if (seq !== renderSeq) return;
    if (e && e.status === 401) { state.me = null; renderLogin(); return; }
    mount(view, errorBox(e));
  }
}

async function logout() {
  try { await state.api.logout(); } catch (e) { /* ignore */ }
  state.me = null;
  location.hash = '';
  renderLogin();
}

function renderLogin(message) {
  const isDemo = state.api.kind === 'demo';
  const err = h('div');
  if (message) err.appendChild(h('div.notice.bad', message));
  let body;
  if (isDemo) {
    body = h('div.stack',
      h('div.notice.info', 'Demonstration build. Access to this site is protected by the server password; inside the demo, choose a role to explore what each person can do.'),
      h('div.demo-users', state.api.users.map((u) => h('button.btn', {
        onclick: async () => { await state.api.login(u.email); await afterLogin(); },
      }, h('span', h('strong', u.name), h('br'), h('span.muted.small', roleLabel(u.role)))))),
      err);
  } else {
    const email = h('input', { type: 'email', autocomplete: 'username', required: true, id: 'login-email' });
    const pw = h('input', { type: 'password', autocomplete: 'current-password', required: true, id: 'login-pw' });
    const btn = h('button.btn.primary', { type: 'submit' }, 'Sign in');
    body = h('form.stack', {
      onsubmit: async (e) => {
        e.preventDefault();
        btn.disabled = true;
        clear(err);
        try { await state.api.login(email.value.trim(), pw.value); await afterLogin(); } catch (ex) { err.appendChild(h('div.notice.bad', ex.message)); btn.disabled = false; }
      },
    }, h('label.field', 'Email', email), h('label.field', 'Password', pw), err, btn);
  }
  mount(app, h('div.login', h('div.card', h('div.card-body',
    h('div.brand', h('div.boot-mark', 'UBC'), h('div', h('h1', 'UBC Commerce Hub'), h('div.muted.small', 'Private admin · TwoIT Solutions LLC'))),
    body))));
}

async function afterLogin() {
  state.me = await state.api.me();
  renderShell();
  if (!location.hash || location.hash === '#/') location.hash = '#/dashboard';
  await route();
}

async function boot() {
  state.api = await loadDriver();
  state.system = await state.api.system();
  window.__ubcReady = true;
  window.addEventListener('hashchange', route);
  window.addEventListener('ubc:refresh-badges', refreshBadges);
  try {
    state.me = await state.api.me();
    renderShell();
    await route();
  } catch (e) {
    if (e && e.status === 401) renderLogin();
    else throw e;
  }
  if (state.api.kind === 'demo' && state.api.storageOk && !state.api.storageOk()) {
    toast('Browser storage is unavailable (private mode?). The demo works, but changes reset on reload.', '');
  }
}

boot().catch((e) => {
  if (window.__ubcBootFail) window.__ubcBootFail('The app could not start', e && e.message ? e.message : String(e));
  else mount(app, errorBox(e));
});

export { routes };
