// End-to-end browser tests for the admin (static DEMO build by default).
//   node tests/e2e/run.mjs                         -> serves build/static-demo locally
//   E2E_URL=https://user:pass@host node tests/e2e/run.mjs  -> tests a deployed site
// Runs desktop Chromium (1440px) and iPhone emulation (390px, touch, iOS UA).
// NOTE: iPhone emulation uses Chromium, not WebKit (WebKit is not installed here).
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SHOTS = process.env.E2E_SHOTS || join(root, 'test-results');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain' };
async function serveStatic(dir) {
  const server = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      const file = join(dir, p);
      if (!file.startsWith(dir)) { res.writeHead(403); return res.end(); }
      await stat(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(await readFile(file));
    } catch { res.writeHead(404); res.end('not found'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function noHorizontalOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

const SUBNAV_PARENT = {
  '#/inventory': '#/products',
  '#/pricing': '#/products',
  '#/pipeline': '#/suppliers',
  '#/integrations': '#/settings',
  '#/activity': '#/settings',
  '#/store': '#/settings',
};

async function nav(page, hash, mobile) {
  const parent = SUBNAV_PARENT[hash];
  const targetSidebar = parent || hash;
  if (mobile) {
    await page.click('.menu-btn');
    await page.waitForSelector('.nav.open');
    await page.click(`.nav a[href="${targetSidebar}"]`);
  } else {
    await page.click(`.nav a[href="${targetSidebar}"]`);
  }
  await page.waitForSelector(`#view[data-route="${targetSidebar}"] .page-head`, { timeout: 15000 });
  if (parent) {
    await page.click(`.subnav a[href="${hash}"]`);
    await page.waitForSelector(`#view[data-route="${hash}"] .page-head`, { timeout: 15000 });
  }
}

async function runSuite(browser, label, contextOpts, baseUrl) {
  console.log(`\n=== ${label} ===`);
  const mobile = !!contextOpts.isMobile;
  const ctx = await browser.newContext({ ...contextOpts, ignoreHTTPSErrors: false });
  const page = await ctx.newPage();
  const consoleErrors = [];
  const failed = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  page.on('requestfailed', (r) => failed.push(r.url()));
  page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });
  page.on('dialog', (d) => d.dismiss());

  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ubcReady === true, null, { timeout: 15000 });
  check(`${label}: app boots (not blank)`, await page.locator('.login, .shell').count() > 0);

  // Login as Carlos (demo role picker)
  await page.click('text=Carlos Mirabal');
  await page.waitForSelector('.shell');
  await page.waitForSelector('.kpis');
  check(`${label}: dashboard loads with statistics`, await page.locator('.kpi').count() >= 8);
  check(`${label}: Carlos Mirabal is shown`, (await page.textContent('.nav-foot .who')).includes('Carlos Mirabal'));
  check(`${label}: demo data clearly labelled`, (await page.textContent('.demo-banner')).includes('DEMO') && (await page.textContent('.mode-pill')) === 'DEMO');
  check(`${label}: no horizontal overflow (dashboard)`, await noHorizontalOverflow(page));
  await page.screenshot({ path: join(SHOTS, `${label}-dashboard.png`), fullPage: false });

  // Navigation across every sidebar section + unified workspace tabs
  const sections = ['#/products', '#/inventory', '#/pricing', '#/orders', '#/purchasing', '#/suppliers', '#/pipeline', '#/promotions', '#/settings', '#/integrations', '#/activity', '#/store', '#/dashboard'];
  let navOk = true;
  for (const s of sections) {
    try { await nav(page, s, mobile); if (!(await noHorizontalOverflow(page))) { navOk = false; console.log('    overflow on', s); } } catch (e) { navOk = false; console.log('    nav failed', s, e.message); }
  }
  check(`${label}: all 13 routes (6 sidebar + sub-tabs) navigate without overflow`, navOk);

  // Catalog: filters, search, selection, publish/hide
  await nav(page, '#/products', mobile);
  await page.waitForSelector('table.t tbody tr');
  await page.screenshot({ path: join(SHOTS, `${label}-item-search.png`), fullPage: false });
  const totalText = async () => page.textContent('.pager span');
  const before = await totalText();
  await page.fill('input[type=search]', 'helmet');
  await page.waitForFunction((b) => document.querySelector('.pager span') && document.querySelector('.pager span').textContent !== b, before, { timeout: 5000 });
  const afterSearch = await totalText();
  check(`${label}: search filters products`, afterSearch !== before, `${before} → ${afterSearch}`);
  await page.selectOption('select >> nth=0', 'physical');
  await page.waitForTimeout(400);
  const rows = await page.locator('table.t tbody tr').count();
  const badges = await page.locator('table.t tbody .badge.ok').count();
  check(`${label}: availability filter (in stock) works`, rows > 0 && badges >= rows, `${rows} rows`);
  await page.click('button:has-text("Clear")');
  await page.waitForTimeout(400);
  await page.locator('table.t tbody tr td.check input').nth(0).check();
  await page.locator('table.t tbody tr td.check input').nth(1).check();
  check(`${label}: products can be selected`, (await page.textContent('.selection-bar strong')).startsWith('2 selected'));
  await page.click('.selection-bar button:has-text("Hide")');
  await page.click('.modal-foot button:has-text("Hide")');
  await page.waitForSelector('.toast.ok', { timeout: 10000 });
  check(`${label}: bulk hide (simulated) completes`, (await page.textContent('.toast.ok')).includes('Hidden'));
  await page.waitForTimeout(500);
  await page.locator('table.t tbody tr td.check input').nth(0).check();
  await page.click('.selection-bar button:has-text("Publish")');
  await page.click('.modal-foot button:has-text("Publish")');
  await page.waitForFunction(() => Array.from(document.querySelectorAll('.toast.ok')).some((t) => t.textContent.includes('Published')), null, { timeout: 10000 });
  check(`${label}: bulk publish (simulated) completes`, true);

  // Promotions: category, %, preview with MAP/margin, apply, restore
  await nav(page, '#/promotions', mobile);
  await page.screenshot({ path: join(SHOTS, `${label}-promotions-hub.png`), fullPage: false });
  await page.click('a:has-text("New promotion")');
  await page.waitForSelector('form');
  await page.fill('#promo-value', '25');
  await page.screenshot({ path: join(SHOTS, `${label}-promotions-wizard.png`), fullPage: false });
  await page.click('button:has-text("Preview impact")');
  await page.waitForSelector('.summary-strip', { timeout: 20000 });
  const strip = await page.textContent('.summary-strip');
  const blocked = Number((/Blocked \(MAP \/ margin\)(\d+)/.exec(strip) || [])[1]);
  const willApply = Number((/Will apply(\d+)/.exec(strip) || [])[1]);
  check(`${label}: preview recalculates prices for the category`, willApply > 0, strip.replace(/\s+/g, ' ').slice(0, 120));
  check(`${label}: MAP / margin restrictions shown`, blocked > 0 && (await page.textContent('#view')).includes('Below MAP'));
  await page.click('button:has-text("Approve & schedule")');
  await page.click('.modal-foot button:has-text("Approve & schedule")');
  await page.waitForFunction(() => document.body.textContent.includes('Applied to'), null, { timeout: 30000 });
  check(`${label}: campaign applied (simulated)`, (await page.textContent('.badge.ok')).includes('Active') || (await page.textContent('#view')).includes('Active'));
  await page.click('button:has-text("Restore original prices")');
  await page.click('.modal-foot button:has-text("Restore prices")');
  await page.waitForFunction(() => Array.from(document.querySelectorAll('#view .badge')).some((b) => b.textContent === 'Restored'), null, { timeout: 30000 });
  check(`${label}: original prices restored`, true);

  // Store: add to cart, checkout -> appears in orders as special order
  await nav(page, '#/store', mobile);
  await page.waitForSelector('.product-card');
  const specialCard = page.locator('.product-card', { has: page.locator('.badge.violet') }).first();
  await specialCard.locator('button:has-text("Add to cart")').click();
  check(`${label}: item added to cart`, (await page.textContent('#view')).includes('Cart (1)'));
  await page.click('button:has-text("Complete demo purchase")');
  await page.waitForFunction(() => location.hash.indexOf('#/orders/') === 0, null, { timeout: 15000 });
  await page.waitForSelector('.stepper');
  check(`${label}: purchase appears in orders`, (await page.textContent('h1')).includes('#DEMO-'));
  // review job moves it to awaiting approval
  await page.waitForTimeout(1500);
  await page.reload();
  await page.waitForSelector('.stepper');
  await page.waitForFunction(() => document.body.textContent.includes('Approve B2B purchase'), null, { timeout: 10000 });
  check(`${label}: special order awaits Carlos's approval`, (await page.textContent('.stepper .current')).includes('Awaiting Approval'));
  await page.click('button:has-text("Approve B2B purchase")');
  await page.click('.modal-foot button:has-text("Approve B2B purchase")');
  await page.waitForFunction(() => document.body.textContent.includes('Mark ordered in B2B'), null, { timeout: 10000 });
  check(`${label}: Carlos approves (simulated)`, (await page.textContent('.stepper .current')).includes('Approved'));
  await page.click('button:has-text("Mark ordered in B2B")');
  await page.click('.modal-foot button:has-text("Mark ordered in B2B")');
  await page.waitForFunction(() => document.body.textContent.includes('Supplier confirmed'), null, { timeout: 15000 });
  await page.click('button:has-text("Supplier confirmed")');
  await page.waitForFunction(() => document.querySelector('.stepper .current') && document.querySelector('.stepper .current').textContent.includes('Supplier Confirmed'), null, { timeout: 10000 });
  check(`${label}: order statuses can be updated`, true);

  // Orders list: select an existing order
  await nav(page, '#/orders', mobile);
  await page.screenshot({ path: join(SHOTS, `${label}-special-orders.png`), fullPage: false });
  await page.locator('table.t tbody tr').first().click();
  await page.waitForSelector('.timeline');
  check(`${label}: orders list → order detail`, (await page.locator('.timeline li').count()) > 0);

  // Integrations
  await nav(page, '#/integrations', mobile);
  const integ = await page.textContent('#view');
  const allFive = ['Shopify', 'Lightspeed Retail R-Series', 'QBP', 'JBI', 'Specialized'].every((n) => integ.includes(n));
  check(`${label}: all 5 integrations listed`, allFive);
  check(`${label}: no real connection claimed`, integ.includes('Demo adapter') && !integ.includes('Connected (authenticated'));

  // Touch targets on mobile
  if (mobile) {
    const small = await page.evaluate(() => Array.from(document.querySelectorAll('.btn, .nav a, .chip, input, select')).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.height < 32;
    }).length);
    check(`${label}: touch targets ≥ 32px high`, small === 0, `${small} smaller`);
  }

  // Reset demo data
  await nav(page, '#/settings', mobile);
  await page.click('button:has-text("Reset demo data")');
  await page.click('.modal-foot button:has-text("Reset demo data")');
  await page.waitForFunction(() => window.__ubcReady === true && document.querySelector('.login, .shell'), null, { timeout: 15000 });
  await page.waitForTimeout(500);
  check(`${label}: demo reset returns to a clean state`, await page.locator('.login').count() === 1);

  // Storage blocked (Safari private-mode-like): app must still render
  const ctx2 = await browser.newContext(contextOpts);
  await ctx2.addInitScript(() => {
    const thrower = () => { throw new DOMException('blocked', 'SecurityError'); };
    try { Object.defineProperty(window, 'localStorage', { get: thrower }); Object.defineProperty(window, 'sessionStorage', { get: thrower }); } catch (e) { /* ignore */ }
  });
  const p2 = await ctx2.newPage();
  const errs2 = [];
  p2.on('pageerror', (e) => errs2.push(String(e)));
  await p2.goto(baseUrl);
  await p2.waitForFunction(() => window.__ubcReady === true, null, { timeout: 15000 });
  await p2.click('text=Carlos Mirabal');
  await p2.waitForSelector('.kpis');
  check(`${label}: works with storage blocked (private mode)`, errs2.length === 0, errs2.join('; '));
  await ctx2.close();

  check(`${label}: no JavaScript errors`, consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  check(`${label}: no failed resources`, failed.length === 0, failed.slice(0, 3).join(' | '));
  await ctx.close();
}

const { mkdirSync } = await import('node:fs');
mkdirSync(SHOTS, { recursive: true });
let base = process.env.E2E_URL;
let srv = null;
if (!base) {
  srv = await serveStatic(join(root, 'build/static-demo'));
  base = srv.url;
}
const browser = await chromium.launch();
let httpCreds;
try {
  const u = new URL(base);
  if (u.username) { httpCreds = { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) }; u.username = ''; u.password = ''; base = u.toString(); }
} catch { /* ignore */ }
const extra = httpCreds ? { httpCredentials: httpCreds } : {};
try {
  await runSuite(browser, 'desktop-1440', { viewport: { width: 1440, height: 900 }, ...extra }, base);
  await runSuite(browser, 'iphone-390', { ...devices['iPhone 13'], ...extra }, base);
} catch (e) {
  check('suite crashed', false, e.stack);
} finally {
  await browser.close();
  srv?.server.close();
}
const failedChecks = results.filter((r) => !r.ok);
console.log(`\n${results.length - failedChecks.length}/${results.length} checks passed`);
process.exitCode = failedChecks.length ? 1 : 0;
