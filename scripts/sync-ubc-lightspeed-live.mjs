/**
 * Live Read-Only Sync of UNIVERSITY BICYCLE CENTER (Lightspeed R-Series #114391)
 * into UBC Commerce Hub (`twoit-sandbox`), plus Workstand "00"-Prefixed UPC Verification
 * against Carlos's real POS items.
 *
 * Strict safety guarantees:
 *  - 100% Read-Only against Lightspeed POS (`employee:inventory_read`, zero PUT/POST to items).
 *  - Never prints tokens, secrets, or connection strings.
 *  - Syncs new POS-only items as `draft` so `ubcbike-hub.myshopify.com` stays curated & clean.
 */
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createPool } from '../packages/database/dist/index.js';
import { normalizeCyclingCategory } from '../packages/integrations/dist/index.js';
import { loadConfig } from '../apps/api/dist/config/env.js';
import { createConnectors, resolveLiveStoreConfigFromDb } from '../apps/api/dist/services/connectors.js';
import { formatPosBrand, ingestLightspeedItemsBatch } from '../apps/api/dist/services/lightspeed-sync.js';
import { importSupplierRecords } from '../apps/api/dist/services/suppliers.js';

const ROOT = process.cwd();
const ENV_PATH = path.join(ROOT, '.env');

function syncLocalEnvRefreshToken(newRefreshToken) {
  if (!newRefreshToken || !fs.existsSync(ENV_PATH)) return;
  const raw = fs.readFileSync(ENV_PATH, 'utf8');
  if (!/^LIGHTSPEED_R_REFRESH_TOKEN=/m.test(raw)) return;
  const updated = raw.replace(/^LIGHTSPEED_R_REFRESH_TOKEN=.*$/m, `LIGHTSPEED_R_REFRESH_TOKEN=${newRefreshToken}`);
  if (updated !== raw) fs.writeFileSync(ENV_PATH, updated, 'utf8');
}

async function main() {
  const t0 = performance.now();
  const cfg = loadConfig(process.env);
  if (!cfg.env.DATABASE_URL) throw new Error('DATABASE_URL missing in .env');

  const pool = createPool(cfg.env.DATABASE_URL);
  try {
    const compRes = await pool.query(`SELECT id, name FROM companies WHERE slug = 'twoit-sandbox' LIMIT 1`);
    if (!compRes.rows[0]) throw new Error('Company twoit-sandbox not found');
    const companyId = compRes.rows[0].id;

    // Ensure primary physical location has a crystal-clear Tampa name and lightspeed_shop_id = '1'
    await pool.query(
      `UPDATE locations
       SET name = 'UBC Tampa Showroom', lightspeed_shop_id = '1'
       WHERE id = (
         SELECT id FROM locations
         WHERE company_id = $1 AND kind = 'physical'
         ORDER BY (shopify_location_id IS NULL), name
         LIMIT 1
       )`,
      [companyId],
    );

    await resolveLiveStoreConfigFromDb(pool, cfg);
    const connectors = createConnectors(cfg, pool);
    const ctx = { pool, config: cfg, connectors };
    const ls = connectors.lightspeed;
    if (!ls) throw new Error('Lightspeed connector not initialized (check APP_MODE=live)');

    const health = await ls.health();
    console.log(`\n══════════════════════════════════════════════════════════════════════`);
    console.log(`  UBC Commerce Hub · Live Read-Only Sync from Lightspeed R-Series`);
    console.log(`  Status: ${health.status.toUpperCase()} — ${health.detail}`);
    console.log(`══════════════════════════════════════════════════════════════════════\n`);
    if (health.status !== 'connected') {
      throw new Error(`Lightspeed not connected: ${health.detail}`);
    }

    const forceFull = process.argv.includes('--full');
    const cursorRow = await pool.query(
      `SELECT sync_cursor FROM integration_connections WHERE company_id = $1 AND system = 'lightspeed_r'`,
      [companyId],
    );
    const sinceCursor = forceFull ? undefined : (cursorRow.rows[0]?.sync_cursor ?? undefined);
    if (sinceCursor) {
      console.log(`  Incremental delta mode since ${sinceCursor} (pass --full for full 25k+ resync)`);
    }

    let totalSeen = 0;
    let totalCreated = 0;
    let totalUpdated = 0;
    let totalStaged = 0;
    let latestCursor = sinceCursor ?? null;
    let buffer = [];
    let pageNum = 0;

    const flush = async () => {
      if (!buffer.length) return;
      const batch = buffer;
      buffer = [];
      const r = await ingestLightspeedItemsBatch(ctx, companyId, batch, { publishNew: false });
      totalSeen += r.seen;
      totalCreated += r.createdVariants;
      totalUpdated += r.updatedVariants;
      totalStaged += r.stagedForShopify;
      if (r.latestTimestamp && (!latestCursor || r.latestTimestamp > latestCursor)) {
        latestCursor = r.latestTimestamp;
      }
      const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
      console.log(
        `  [${elapsed}s] Synced ${totalSeen.toLocaleString('en-US')} active POS items ` +
        `(+${totalCreated.toLocaleString('en-US')} new, ${totalUpdated.toLocaleString('en-US')} enriched)...`,
      );
    };

    for await (const page of ls.iterateItems(sinceCursor)) {
      pageNum++;
      buffer.push(...page);
      if (buffer.length >= 500) {
        await flush();
      } else if (pageNum % 2 === 0) {
        process.stdout.write(`  Fetching page ${pageNum} (${totalSeen + buffer.length} items read)...\r`);
      }
    }
    await flush();

    // Update integration_connections telemetry
    await pool.query(
      `INSERT INTO integration_connections (
         company_id, system, status, detail, missing, writes_enabled, last_checked_at, sync_cursor, last_synced_at, records_synced
       )
       VALUES ($1, 'lightspeed_r', 'connected', 'Authenticated (account 114391, read-only; POS event writes disabled)', '[]'::jsonb, false, now(), $2, now(), $3)
       ON CONFLICT (company_id, system) DO UPDATE SET
         status = 'connected',
         detail = EXCLUDED.detail,
         missing = '[]'::jsonb,
         writes_enabled = false,
         last_checked_at = now(),
         sync_cursor = COALESCE(EXCLUDED.sync_cursor, integration_connections.sync_cursor),
         last_synced_at = now(),
         records_synced = GREATEST(integration_connections.records_synced, EXCLUDED.records_synced)`,
      [companyId, latestCursor, totalSeen],
    );

    // Keep local .env refresh_token aligned with the latest rotated vault token
    const vaultRow = await pool.query(
      `SELECT refresh_token FROM integration_oauth_tokens WHERE system = 'lightspeed_r' LIMIT 1`,
    );
    if (vaultRow.rows[0]?.refresh_token) {
      syncLocalEnvRefreshToken(vaultRow.rows[0].refresh_token);
    }

    if (process.argv.includes('--reclassify')) {
      console.log(`  Re-normalizing POS brands & cycling categories across existing LS products...`);
      const rows = await pool.query(
        `SELECT id, brand, category, title, status FROM products WHERE company_id = $1 AND ref LIKE 'ls-%'`,
        [companyId],
      );
      const updates = [];
      for (const r of rows.rows) {
        const rawB = r.brand === 'Smp' ? 'SMP' : r.brand === '-Ubc' ? '-UBC' : r.brand;
        const nb = formatPosBrand(rawB, r.title);
        const nc = normalizeCyclingCategory(r.category, r.title);
        const ns = nc === 'Workshop Services' ? 'hidden' : r.status;
        if (nb !== r.brand || nc !== r.category || ns !== r.status) {
          updates.push({ id: r.id, brand: nb, category: nc, status: ns });
        }
      }
      for (let i = 0; i < updates.length; i += 2000) {
        const ch = updates.slice(i, i + 2000);
        await pool.query(
          `UPDATE products p
           SET brand = r.brand, category = r.category, status = r.status, updated_at = now()
           FROM jsonb_to_recordset($1::jsonb) AS r(id uuid, brand text, category text, status text)
           WHERE p.id = r.id`,
          [JSON.stringify(ch)],
        );
      }
      await pool.query(
        `UPDATE variants v SET status = 'hidden', updated_at = now()
         FROM products p
         WHERE v.company_id = $1 AND v.product_id = p.id AND p.category = 'Workshop Services' AND v.status <> 'hidden'`,
        [companyId],
      );
      console.log(`  ✓ Re-normalized ${updates.length.toLocaleString('en-US')} POS products cleanly.`);
    }

    // -------------------------------------------------------------------------
    // Workstand "00"-Prefixed UPC Proof on Real UBC Lightspeed Items (#114391)
    // -------------------------------------------------------------------------
    console.log(`\n  Verifying Workstand "00"-prefixed UPC & 15-digit EAN healing on real UBC items...`);
    const qbpSup = await pool.query(
      `SELECT id FROM suppliers WHERE company_id = $1 AND code = 'QBP' LIMIT 1`,
      [companyId],
    );
    if (qbpSup.rows[0]) {
      const qbpId = qbpSup.rows[0].id;

      // Pick up to 24 real unique-UPC items from UBC's synced catalog (including 13-digit EANs & leading-0 UPCs)
      const uniqueRealUpcs = await pool.query(
        `SELECT v.sku, v.title, v.upc, v.mpn, v.price_cents, v.cost_cents, p.brand, p.category
         FROM variants v
         JOIN products p ON p.id = v.product_id
         WHERE v.company_id = $1
           AND v.upc IS NOT NULL
           AND length(regexp_replace(v.upc, '\\D', '', 'g')) IN (12, 13)
           AND v.upc IN (
             SELECT upc FROM variants WHERE company_id = $1 AND upc IS NOT NULL GROUP BY upc HAVING count(*) = 1
           )
         ORDER BY
           (CASE WHEN length(v.upc) = 13 THEN 0 WHEN v.upc LIKE '0%' THEN 1 ELSE 2 END),
           v.updated_at DESC
         LIMIT 24`,
        [companyId],
      );

      // Also pick 1 real duplicate-UPC pair (e.g. RYSE single drink vs case of 12 sharing UPC 810137321806)
      const dupRealUpc = await pool.query(
        `SELECT v.sku, v.title, v.upc, v.mpn, v.price_cents, v.cost_cents, p.brand, p.category
         FROM variants v
         JOIN products p ON p.id = v.product_id
         WHERE v.company_id = $1
           AND v.upc IN (
             SELECT upc FROM variants WHERE company_id = $1 AND upc IS NOT NULL GROUP BY upc HAVING count(*) > 1
           )
         LIMIT 1`,
        [companyId],
      );

      const workstandRecords = [];
      for (const r of uniqueRealUpcs.rows) {
        const cleanDigits = r.upc.replace(/\D+/g, '');
        // Simulate Workstand's exact bug: prepending "00" to every 12-digit UPC (14 digits) & 13-digit EAN (15 digits)!
        const workstandCorruptedUpc = `00${cleanDigits}`;
        const costCents = r.cost_cents && r.cost_cents > 0 ? r.cost_cents : Math.max(200, Math.round(r.price_cents * 0.58));
        workstandRecords.push({
          supplierSku: `WS-QBP-${cleanDigits.slice(-8)}`,
          brand: r.brand,
          title: r.title,
          upc: workstandCorruptedUpc,
          mpn: r.mpn || undefined,
          category: r.category,
          costCents,
          msrpCents: r.price_cents,
          mapCents: null,
          qtyAvailable: 14,
          dropShip: true,
          leadDays: 3,
          contentLicensed: true,
        });
      }

      if (dupRealUpc.rows[0]) {
        const d = dupRealUpc.rows[0];
        const cleanDigits = d.upc.replace(/\D+/g, '');
        workstandRecords.push({
          supplierSku: `WS-DUP-${cleanDigits.slice(-8)}`,
          brand: d.brand,
          title: `${d.title} (Workstand Feed Ambiguous Pack)`,
          upc: `00${cleanDigits}`,
          mpn: d.mpn || undefined,
          category: d.category,
          costCents: d.cost_cents || 2400,
          msrpCents: d.price_cents,
          mapCents: null,
          qtyAvailable: 8,
          dropShip: false,
          leadDays: 4,
          contentLicensed: true,
        });
      }

      if (workstandRecords.length > 0) {
        const wsRes = await importSupplierRecords(ctx, companyId, 'QBP', workstandRecords, 'full_catalog');
        console.log(
          `  ✓ Workstand "00"-prefix batch (${workstandRecords.length} real UBC items): ` +
          `${wsRes.autoMatched} auto-matched cleanly, ${wsRes.review} multi-pack ambiguity safely quarantined for review!`,
        );
      }
    }

    // Print final summary telemetry
    const [locSummary, catSummary, brandSummary, totRow] = await Promise.all([
      pool.query(
        `SELECT l.name, l.lightspeed_shop_id, count(il.variant_id)::int AS skus_in_stock, coalesce(sum(il.on_hand), 0)::int AS total_units
         FROM locations l
         LEFT JOIN inventory_levels il ON il.location_id = l.id
         WHERE l.company_id = $1
         GROUP BY l.id
         ORDER BY l.lightspeed_shop_id NULLS LAST, l.name`,
        [companyId],
      ),
      pool.query(
        `SELECT category, count(*)::int AS n FROM products WHERE company_id = $1 GROUP BY 1 ORDER BY n DESC LIMIT 10`,
        [companyId],
      ),
      pool.query(
        `SELECT brand, count(*)::int AS n FROM products WHERE company_id = $1 GROUP BY 1 ORDER BY n DESC LIMIT 12`,
        [companyId],
      ),
      pool.query(
        `SELECT
           (SELECT count(*)::int FROM products WHERE company_id = $1) AS products,
           (SELECT count(*)::int FROM variants WHERE company_id = $1) AS variants,
           (SELECT count(*)::int FROM variants WHERE company_id = $1 AND status = 'published') AS published_variants,
           (SELECT count(*)::int FROM variants WHERE company_id = $1 AND status = 'hidden') AS hidden_services`,
        [companyId],
      ),
    ]);

    const totalSec = ((performance.now() - t0) / 1000).toFixed(1);
    console.log(`\n══════════════════════════════════════════════════════════════════════`);
    console.log(`  SYNC COMPLETE IN ${totalSec}s — UNIVERSITY BICYCLE CENTER (#114391)`);
    console.log(`══════════════════════════════════════════════════════════════════════`);
    console.log(`  Canonical Products : ${totRow.rows[0].products.toLocaleString('en-US')}`);
    console.log(`  Canonical Variants : ${totRow.rows[0].variants.toLocaleString('en-US')}`);
    console.log(`  Online Published   : ${totRow.rows[0].published_variants.toLocaleString('en-US')} (Shopify storefront clean)`);
    console.log(`  Workshop Services  : ${totRow.rows[0].hidden_services.toLocaleString('en-US')} (auto-hidden from web)`);
    console.log(`\n  Physical Shop Stock (Never Summed With Vendors):`);
    for (const l of locSummary.rows) {
      console.log(`    • ${l.name} (shop #${l.lightspeed_shop_id ?? '?'}): ${l.skus_in_stock.toLocaleString('en-US')} SKUs in stock · ${l.total_units.toLocaleString('en-US')} units on hand`);
    }
    console.log(`\n  Top Categories:`);
    for (const c of catSummary.rows) {
      console.log(`    • ${c.category}: ${c.n.toLocaleString('en-US')}`);
    }
    console.log(`\n  Top Brands:`);
    console.log(`    ${brandSummary.rows.map((b) => `${b.brand} (${b.n})`).join(' · ')}`);
    console.log(`══════════════════════════════════════════════════════════════════════\n`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Sync failed:', err.message);
  process.exit(1);
});
