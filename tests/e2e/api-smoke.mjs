// Browser smoke test of the admin against the real API (http driver + PostgreSQL).
// Requires a seeded DEMO database: TEST_DATABASE_URL (default: local ubc_hub_test).
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const URL = process.env.TEST_DATABASE_URL ?? 'postgres://ubc:ubc_dev@127.0.0.1:5432/ubc_hub_test';

const { createPool, runMigrations, seedDemo } = await import(join(root, 'packages/database/dist/index.js'));
const { buildApp } = await import(join(root, 'apps/api/dist/app.js'));
const { loadConfig } = await import(join(root, 'apps/api/dist/config/env.js'));
const { startWorkerLoop } = await import(join(root, 'apps/api/dist/workers/runner.js'));

const pool = createPool(URL);
await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
await runMigrations(pool, () => {});
await seedDemo(pool, { carlosPassword: 'carlos-e2e-password-1', adminPassword: 'admin-e2e-password-12' });
const config = loadConfig({ DATABASE_URL: URL, LOG_LEVEL: 'warn', ADMIN_DIR: join(root, 'apps/admin') });
const { app, ctx } = await buildApp({ pool, config, logger: false });
const stop = startWorkerLoop(ctx, { intervalMs: 300 });
await app.listen({ port: 0, host: '127.0.0.1' });
const base = `http://127.0.0.1:${app.server.address().port}/`;

let pass = 0, fail = 0;
const check = (n, ok, d) => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${d ? ' — ' + d : ''}`); };

const browser = await chromium.launch();
for (const [label, opts] of [['api-desktop', { viewport: { width: 1280, height: 800 } }], ['api-iphone', devices['iPhone 13']]]) {
  const page = await (await browser.newContext(opts)).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('401')) errors.push(m.text()); });
  await page.goto(base);
  await page.waitForSelector('#login-email');
  check(`${label}: login form shown to anonymous users`, true);
  await page.fill('#login-email', 'carlos@ubc.demo');
  await page.fill('#login-pw', 'wrong-password');
  await page.click('button:has-text("Sign in")');
  await page.waitForSelector('.notice.bad');
  check(`${label}: wrong password rejected`, (await page.textContent('.notice.bad')).includes('incorrect'));
  await page.fill('#login-pw', 'carlos-e2e-password-1');
  await page.click('button:has-text("Sign in")');
  await page.waitForSelector('.kpis');
  check(`${label}: Carlos signs in, dashboard loads`, (await page.textContent('.nav-foot .who')) === 'Carlos Mirabal');
  await page.goto(base + '#/promotions/new');
  await page.waitForSelector('form');
  await page.click('button:has-text("Preview impact")');
  await page.waitForSelector('.summary-strip', { timeout: 20000 });
  check(`${label}: promotion preview from PostgreSQL`, (await page.textContent('.summary-strip')).includes('Blocked'));
  await page.click('button:has-text("Approve & schedule")');
  await page.click('.modal-foot button:has-text("Approve & schedule")');
  await page.waitForFunction(() => document.body.textContent.includes('Applied to'), null, { timeout: 30000 });
  check(`${label}: campaign applied via background job`, true);
  await page.click('button:has-text("Restore original prices")');
  await page.click('.modal-foot button:has-text("Restore prices")');
  await page.waitForFunction(() => Array.from(document.querySelectorAll('#view .badge')).some((b) => b.textContent === 'Restored'), null, { timeout: 30000 });
  check(`${label}: campaign restored`, true);
  await page.goto(base + '#/integrations');
  await page.waitForSelector('.integration');
  check(`${label}: integrations report demo adapters`, (await page.locator('.integration').count()) === 5);
  check(`${label}: no JS / CSP errors`, errors.length === 0, errors.slice(0, 2).join(' | '));
  await page.context().close();
}
await browser.close();
stop();
await app.close();
await pool.end();
console.log(`\n${pass}/${pass + fail} checks passed`);
process.exitCode = fail ? 1 : 0;
