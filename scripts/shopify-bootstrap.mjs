// Bootstraps a PostgreSQL / Supabase database with an isolated tenant
// (`twoit-sandbox` automatically for test stores like `twoit-pruebas-pipeline.myshopify.com`,
// or `ubc` for UBC's real store), supplier sync schedules (QBP, JBI, Specialized),
// operator accounts, and pulls the live Shopify catalog in 100% read-only mode.
import { randomBytes } from 'node:crypto';
import { createPool, hashPassword, runMigrations } from '../packages/database/dist/index.js';
import { DEFAULT_CAMPAIGN_RULES } from '../packages/shared/dist/index.js';
import { ShopifyAdminApi, ShopifyAdminClient } from '../packages/integrations/dist/index.js';
import { loadConfig } from '../apps/api/dist/config/env.js';
import { createConnectors } from '../apps/api/dist/services/connectors.js';
import { syncFromShopifyJob } from '../apps/api/dist/services/shopify-sync.js';

const cfg = loadConfig(process.env);
const shopDomain = (cfg.env.SHOPIFY_SHOP_DOMAIN || '').toLowerCase();
const isSandboxStore = /pruebas|sandbox|test|dev|ubcbike-hub/.test(shopDomain) || cfg.env.SHOPIFY_PLAN === 'trial' || cfg.env.SHOPIFY_PLAN === 'basic';

const tenantSlug = (process.env.BOOTSTRAP_COMPANY_SLUG || (isSandboxStore ? 'twoit-sandbox' : 'ubc')).trim();
const tenantName = (process.env.BOOTSTRAP_COMPANY_NAME || (tenantSlug === 'twoit-sandbox' ? 'TwoIT Pruebas Pipeline (Sandbox)' : 'University Bicycle Center')).trim();
const emailDomain = tenantSlug === 'twoit-sandbox' ? 'twoit.sandbox' : 'ubc.demo';

const pool = createPool(cfg.env.DATABASE_URL);

try {
  console.log(`Target tenant: slug="${tenantSlug}" (${tenantName}) <- shop="${shopDomain || 'unconfigured'}"`);
  console.log('1/3 Ensuring PostgreSQL migrations are up to date...');
  const applied = await runMigrations(pool);
  console.log(applied.length ? `    Applied: ${applied.join(', ')}` : '    Schema already up to date.');

  console.log('2/3 Ensuring tenant, physical store location, supplier schedules & operator users...');
  const client = await pool.connect();
  let companyId;
  const createdUsers = [];
  try {
    await client.query('BEGIN');
    const existing = await client.query(`SELECT id FROM companies WHERE slug = $1`, [tenantSlug]);
    if (existing.rowCount) {
      companyId = existing.rows[0].id;
    } else {
      companyId = (await client.query(
        `INSERT INTO companies (slug, name) VALUES ($1, $2) RETURNING id`,
        [tenantSlug, tenantName],
      )).rows[0].id;

      const storeLabel = tenantSlug === 'twoit-sandbox' ? 'TwoIT Pruebas Pipeline' : 'UBC Omnichannel Store';
      const storeId = (await client.query(
        `INSERT INTO stores (company_id, name, shopify_shop_domain) VALUES ($1, $2, $3) RETURNING id`,
        [companyId, storeLabel, cfg.env.SHOPIFY_SHOP_DOMAIN || null],
      )).rows[0].id;

      const locLabel = tenantSlug === 'twoit-sandbox' ? 'Sandbox Main Location' : 'UBC Main Store';
      await client.query(
        `INSERT INTO locations (company_id, store_id, name, kind, shopify_location_id)
         VALUES ($1, $2, $3, 'physical', $4)`,
        [companyId, storeId, locLabel, cfg.env.SHOPIFY_PHYSICAL_LOCATION_ID || null],
      );

      await client.query(
        `INSERT INTO company_settings (company_id, campaign_rules, availability_rules)
         VALUES ($1, $2, $3)`,
        [
          companyId,
          JSON.stringify(DEFAULT_CAMPAIGN_RULES),
          JSON.stringify({ physicalSafetyQty: 0, supplierSafetyQty: 2, maxOfferAgeHours: 48, handlingDays: 2 }),
        ],
      );

      const suppliers = [
        { code: 'QBP', name: 'Quality Bicycle Products', connector: 'qbp', methods: ['api', 'catalog_feed', 'sftp'], notes: 'Authorized dealer — availability 15-30m, costs 6-12h.' },
        { code: 'JBI', name: 'J&B Importers', connector: 'jbi', methods: ['catalog_feed', 'sftp'], notes: 'Authorized dealer — FTP/CSV feed monitored by 48h watchdog.' },
        { code: 'SPECIALIZED', name: 'Specialized Bicycle Components', connector: 'specialized', methods: ['catalog_feed', 'dealer_portal'], notes: 'Authorized dealer — strict MAP + Click & Collect for complete bikes.' },
      ];
      for (const s of suppliers) {
        const supId = (await client.query(
          `INSERT INTO suppliers (company_id, code, name, connector, methods, notes)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [companyId, s.code, s.name, s.connector, s.methods, s.notes],
        )).rows[0].id;

        await client.query(
          `INSERT INTO supplier_sync_schedules (company_id, supplier_id, stream, interval_minutes, max_silence_hours)
           VALUES
             ($1, $2, 'availability', 20,   2),
             ($1, $2, 'costs',        540,  24),
             ($1, $2, 'content',      1440, 48),
             ($1, $2, 'full_catalog', NULL, 48)
           ON CONFLICT (company_id, supplier_id, stream) DO NOTHING`,
          [companyId, supId],
        );
      }

      const genPw = () => randomBytes(12).toString('base64url');
      const accounts = [
        { email: `carlos@${emailDomain}`, name: 'Carlos Mirabal', role: 'purchasing', pw: process.env.SEED_CARLOS_PASSWORD || genPw() },
        { email: `admin@${emailDomain}`, name: 'TwoIT Admin', role: 'owner', pw: process.env.SEED_ADMIN_PASSWORD || genPw() },
      ];
      for (const u of accounts) {
        const existingUser = await client.query(`SELECT id FROM users WHERE lower(email) = lower($1)`, [u.email]);
        const userId = existingUser.rowCount
          ? existingUser.rows[0].id
          : (await client.query(
              `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id`,
              [u.email, u.name, await hashPassword(u.pw)],
            )).rows[0].id;
        await client.query(
          `INSERT INTO memberships (user_id, company_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [userId, companyId, u.role],
        );
        if (!existingUser.rowCount) {
          createdUsers.push({ email: u.email, role: u.role, pw: u.pw });
        }
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  if (createdUsers.length) {
    console.log('    Created operator accounts (save these passwords — shown once):');
    for (const u of createdUsers) {
      console.log(`      - ${u.role.padEnd(10)} ${u.email}  password: ${u.pw}`);
    }
  } else {
    console.log(`    Tenant '${tenantSlug}' (${companyId}) already initialized.`);
  }

  console.log('3/3 Syncing live Shopify catalog (read-only) into PostgreSQL...');
  const shopifyClient = new ShopifyAdminClient({
    shopDomain: cfg.env.SHOPIFY_SHOP_DOMAIN,
    clientId: cfg.env.SHOPIFY_CLIENT_ID,
    clientSecret: cfg.env.SHOPIFY_CLIENT_SECRET,
    accessToken: cfg.env.SHOPIFY_ADMIN_ACCESS_TOKEN,
    apiVersion: cfg.env.SHOPIFY_API_VERSION,
    plan: cfg.env.SHOPIFY_PLAN,
    physicalLocationId: cfg.env.SHOPIFY_PHYSICAL_LOCATION_ID,
    writesEnabled: false,
  });
  const baseConnectors = createConnectors(cfg, pool);
  const ctx = {
    pool,
    config: cfg,
    connectors: {
      ...baseConnectors,
      shopify: new ShopifyAdminApi(shopifyClient),
      shopifyHealth: () => shopifyClient.health(),
    },
  };
  const summary = await syncFromShopifyJob(ctx, companyId);
  console.log('    Shopify sync summary:', JSON.stringify(summary));
  console.log(`\nBootstrap complete for tenant '${tenantSlug}'! Ready to launch 'npm run dev' and 'npm run worker'.`);
} finally {
  await pool.end();
}
