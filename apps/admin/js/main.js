import { CONFIG } from './config.js';
import { createHttpDriver } from './drivers/http.js?v=77';
import { h, icon, mount, clear } from './ui/dom.js';
import { errorBox } from './ui/components.js';
import { matchRoute } from './router.js?v=77';

const app = document.getElementById('app');
const state = { api: null, me: null, system: null, navOpen: false };

const NAV = [
  {
    group: 'Overview',
    items: [
      ['#/dashboard', 'Dashboard', 'dashboard'],
      ['#/reports', 'Reports', 'clipboard'],
    ],
  },
  {
    group: 'Inventory',
    items: [
      ['#/products', 'Item Search', 'box'],
      ['#/orders', 'Special Orders', 'cart', 'awaitingApproval'],
      ['#/purchasing', 'Purchase Orders', 'clipboard'],
      ['#/suppliers', 'Vendor Catalogs', 'truck'],
      ['#/upc-matches', 'UPC Matches', 'box', 'upcReview'],
    ],
  },
  {
    group: 'Pricing & System',
    items: [
      ['#/promotions', 'Promotions / Price Rules', 'tag'],
      ['#/settings', 'Settings & Sync', 'settings', 'openErrors'],
      ['#/help', 'Help & Guides', 'clipboard'],
    ],
  },
];

function navParentFor(hash) {
  const path = (hash || '#/dashboard').split('?')[0];
  if (path.indexOf('#/inventory') === 0 || path.indexOf('#/pricing') === 0 || path.indexOf('#/lightspeed-sheet') === 0 || path.indexOf('#/products') === 0) return '#/products';
  if (path.indexOf('#/pipeline') === 0 || path.indexOf('#/suppliers') === 0) return '#/suppliers';
  if (path.indexOf('#/integrations') === 0 || path.indexOf('#/activity') === 0 || path.indexOf('#/settings') === 0) return '#/settings';
  if (path.indexOf('#/promotions') === 0) return '#/promotions';
  if (path.indexOf('#/orders') === 0) return '#/orders';
  if (path.indexOf('#/purchasing') === 0) return '#/purchasing';
  if (path.indexOf('#/upc-matches') === 0) return '#/upc-matches';
  if (path.indexOf('#/help') === 0) return '#/help';
  if (path.indexOf('#/reports') === 0) return '#/reports';
  return '#/dashboard';
}

async function loadDriver() {
  if (CONFIG.driver === 'demo') {
    const mod = await import('./drivers/demo.js?v=77');
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
async function refreshNavVisibility() {
  try {
    const s = await state.api.settings();
    state.settings = s;
    const showUpc = !s || !s.availability || s.availability.showUpcMatches !== false;
    const upcNav = document.querySelector('[data-nav="#/upc-matches"]');
    if (upcNav) upcNav.hidden = !showUpc;
  } catch (e) { /* ignore */ }
}

async function refreshBadges() {
  try {
    await refreshNavVisibility();
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
    h('div.nav-brand',
      h('img.nav-logo', { src: 'assets/ubc-logo-white.png', alt: 'University Bicycle Center' }),
      h('div.nav-brand-meta', 'Commerce Hub · Since 1972')),
    NAV.map((g) => h('div.nav-group', h('div.nav-group-label', g.group),
      g.items.map(([href, label, ic, countKey]) => h('a', { href, dataset: { nav: href }, onclick: closeNav }, icon(ic), h('span', label),
        countKey ? h('span.count', { dataset: { count: countKey }, hidden: true }) : null)))),
    h('div.nav-foot',
      h('div.who', state.me.user.name),
      h('div.role', roleLabel(state.me.user.role) + ' · ' + state.me.user.email),
      h('button.btn.sm', { onclick: logout }, 'Sign out'),
      h('div.small', { style: { marginTop: '10px', opacity: '0.78', fontSize: '11px', lineHeight: '1.4' } },
        'Built by ',
        h('a', { href: 'https://www.twoitsolutions.com', target: '_blank', rel: 'noopener', style: { color: '#CCBB8D', textDecoration: 'underline' } }, 'TwoIT Solutions LLC'))));
  const scrim = h('div.scrim', { onclick: closeNav });
  const crumbs = h('div.crumbs#crumbs');
  const topbar = h('header.topbar',
    h('button.btn.ghost.menu-btn', { 'aria-label': 'Open menu', onclick: () => { state.navOpen = true; nav.classList.add('open'); scrim.classList.add('open'); } }, icon('menu')),
    crumbs, h('div.spacer'),
    h('span.mode-pill', { class: isDemo ? '' : 'live', title: isDemo ? 'Fictitious data; no real system connected' : 'Connected to live UBC systems' }, isDemo ? 'DEMO' : 'LIVE'));
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
  const activeNav = navParentFor(hash);
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === activeNav));
  const crumbs = document.getElementById('crumbs');
  if (crumbs) crumbs.textContent = m.route.title;
  document.title = m.route.title + ' · UBC Commerce Hub';
  const view = document.getElementById('view');
  const seq = ++renderSeq;
  clear(view);
  view.removeAttribute('data-route');
  try {
    const ctx = {
      api: state.api,
      me: state.me,
      system: state.system,
      showUpcMatches: !state.settings || !state.settings.availability || state.settings.availability.showUpcMatches !== false,
      can,
      params: m.params,
      query: m.query,
      isCurrent: () => seq === renderSeq,
      refreshBadges,
      refreshNav: refreshNavVisibility,
      navigate: (to) => { location.hash = to; },
    };
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
    const email = h('input', { type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', placeholder: 'ubcbike', required: true, id: 'login-email' });
    const pw = h('input', { type: 'password', autocomplete: 'current-password', required: true, id: 'login-pw' });
    const btn = h('button.btn.primary.lg.full', { type: 'submit' }, 'Sign in to UBC Hub');
    body = h('form.stack', {
      onsubmit: async (e) => {
        e.preventDefault();
        btn.disabled = true;
        clear(err);
        try { await state.api.login(email.value.trim(), pw.value); await afterLogin(); } catch (ex) { err.appendChild(h('div.notice.bad', ex.message)); btn.disabled = false; }
      },
    }, h('label.field', 'User', email), h('label.field', 'Password', pw), err, btn);
  }
  mount(app, h('div.login', h('div.login-shell',
    h('img.login-top-logo', { src: 'assets/ubc-logo-white.png', alt: 'UBC University Bicycle Center' }),
    h('div.card', h('div.card-body',
      h('div.brand',
        h('div.login-title', 'Commerce Hub'),
        h('div.muted.small', 'Online Store, Store POS & B2B Control')),
      body)),
    h('div.small', { style: { textAlign: 'center', marginTop: '14px', color: 'rgba(255,255,255,0.75)' } },
      'Built by ',
      h('a', { href: 'https://www.twoitsolutions.com', target: '_blank', rel: 'noopener', style: { color: '#CCBB8D', textDecoration: 'underline' } }, 'TwoIT Solutions LLC')))));
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
    renderLogin();
  }
}

boot().catch((e) => {
  mount(app, h('div.boot.boot-error', h('h1', 'Could not start UBC Commerce Hub'), h('p', e.message || String(e))));
});
