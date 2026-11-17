/**
 * READ-ONLY audit: Lightspeed matrices (same product in several colors/sizes) vs. the Shopify store,
 * with the UPC as the key. Writes nothing to Lightspeed, Shopify or the Hub.
 *
 *   node --env-file=.env scripts/audit-matrices-upc.mjs
 *
 * Reports:
 *  - Lightspeed items without a usable UPC (empty, invalid check digit, only in EAN field), in stock first
 *  - UPCs repeated inside Lightspeed
 *  - Matrices fully / partly / not found in Shopify
 *  - Matrices split across several Shopify products, and Shopify products mixing several matrices
 *  - Size / color that disagrees between Lightspeed and the Shopify variant with the same UPC (= wrong UPC)
 * Writes a CSV with every problem row to build/audit-matrices-upc.csv
 */
import fs from 'node:fs';
import { normalizeGtin } from '../packages/business-rules/dist/index.js';
import { lsOptionValues } from '../packages/integrations/dist/index.js';
import { createPool } from '../packages/database/dist/index.js';
import { loadConfig } from '../apps/api/dist/config/env.js';
import { createConnectors } from '../apps/api/dist/services/connectors.js';

const SHOP = (process.env.UBC_LIVE_SHOPIFY_DOMAIN || '').toLowerCase();
const TOKEN = process.env.UBC_LIVE_SHOPIFY_ACCESS_TOKEN;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const digits = (s) => String(s ?? '').replace(/\D/g, '');
const loose = (s) => digits(s).replace(/^0+/, '');

async function gql(query) {
  const res = await fetch(`https://${SHOP}/admin/api/2026-10/graphql.json`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN }, body: JSON.stringify({ query }),
  });
  const j = await res.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 300));
  return j.data;
}

async function readShopify() {
  const cur = await gql(`{ currentBulkOperation(type: QUERY) { status } }`);
  if (cur.currentBulkOperation && ['CREATED', 'RUNNING'].includes(cur.currentBulkOperation.status)) throw new Error('bulk query already running');
  const run = await gql(`mutation { bulkOperationRunQuery(query: """
    { productVariants { edges { node { id barcode sku displayName selectedOptions { name value } product { id title } } } } }
  """) { userErrors { message } } }`);
  if (run.bulkOperationRunQuery.userErrors.length) throw new Error(JSON.stringify(run.bulkOperationRunQuery.userErrors));
  for (;;) {
    await sleep(4000);
    const s = (await gql(`{ currentBulkOperation(type: QUERY) { status url objectCount } }`)).currentBulkOperation;
    if (s.status === 'COMPLETED') return (await (await fetch(s.url)).text()).trim().split('\n').map((l) => JSON.parse(l));
    if (['FAILED', 'CANCELED', 'EXPIRED'].includes(s.status)) throw new Error(`bulk ${s.status}`);
  }
}

// Size words → canonical, so "M" == "Medium", "XL" == "X-Large", "S3" == "S3".
const SIZE = { xxs: 'XXS', xs: 'XS', 'x-small': 'XS', 'extra small': 'XS', s: 'S', sm: 'S', small: 'S', m: 'M', md: 'M', med: 'M', medium: 'M', l: 'L', lg: 'L', large: 'L', xl: 'XL', 'x-large': 'XL', 'extra large': 'XL', xxl: 'XXL', '2xl': 'XXL', 'xx-large': 'XXL', xxxl: 'XXXL', '3xl': 'XXXL', os: 'OS', 'one size': 'OS', onesize: 'OS' };
const canonSize = (v) => {
  const t = String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return SIZE[t] ?? t.replace(/[^a-z0-9.]/g, '');
};
function sizeAgrees(lsSize, shopVariant) {
  if (!lsSize) return null;
  const want = canonSize(lsSize);
  const opts = shopVariant.selectedOptions ?? [];
  const sizeOpt = opts.find((o) => /size|talla|frame/i.test(o.name));
  if (sizeOpt) return canonSize(sizeOpt.value) === want || canonSize(sizeOpt.value).includes(want) || want.includes(canonSize(sizeOpt.value));
  // No "Size" option in Shopify: accept if any option or the title contains it as a word.
  const hay = [...opts.map((o) => o.value), shopVariant.displayName].join(' / ').toLowerCase();
  return opts.some((o) => canonSize(o.value) === want) || new RegExp(`(^|[^a-z0-9])${want.toLowerCase()}([^a-z0-9]|$)`).test(hay);
}
function colorAgrees(lsColor, shopVariant) {
  if (!lsColor) return null;
  const words = String(lsColor).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  if (!words.length) return null;
  const hay = [...(shopVariant.selectedOptions ?? []).map((o) => o.value), shopVariant.displayName].join(' ').toLowerCase();
  return words.some((w) => hay.includes(w));
}

async function main() {
  const cfg = loadConfig(process.env);
  const pool = createPool(cfg.env.DATABASE_URL);
  const problems = [];
  try {
    const companyId = (await pool.query(`SELECT id FROM companies WHERE slug = 'twoit-sandbox' LIMIT 1`)).rows[0].id;
    const ls = createConnectors(cfg, pool, companyId).lightspeed;
    await ls.ensureConfigured();
    const sets = await ls.listItemAttributeSets();

    console.log('1) Reading every Lightspeed item (read-only)...');
    const items = [];
    for await (const page of ls.iterateItems()) {
      for (const it of page) {
        const shops = it.ItemShops ? [].concat(it.ItemShops.ItemShop) : [];
        const qty = shops.filter((s) => s.shopID !== '0').reduce((n, s) => n + Math.max(0, Number(s.qoh) || 0), 0);
        const opts = lsOptionValues(it.ItemAttributes, sets);
        items.push({
          id: it.itemID, desc: it.description, upcRaw: it.upc || '', eanRaw: it.ean || '', matrix: it.itemMatrixID && it.itemMatrixID !== '0' ? it.itemMatrixID : null,
          opts, size: opts.Size ?? opts.size ?? null, color: opts.Color ?? opts.color ?? null, qty, sku: it.customSku || '', mpn: it.manufacturerSku || '',
        });
      }
      if (items.length % 5000 < 100) process.stdout.write(`   ${items.length}\r`);
    }
    console.log(`   ${items.length.toLocaleString('en-US')} items, ${new Set(items.filter((i) => i.matrix).map((i) => i.matrix)).size.toLocaleString('en-US')} matrices`);

    console.log('2) Reading every Shopify variant (bulk, read-only)...');
    const nodes = (await readShopify()).filter((n) => n.id?.includes('ProductVariant'));
    const shopByGtin = new Map();
    const shopByLoose = new Map();
    for (const n of nodes) {
      const g = normalizeGtin(n.barcode);
      if (g) shopByGtin.set(g, [...(shopByGtin.get(g) ?? []), n]);
      const l = loose(n.barcode);
      if (l.length >= 6) shopByLoose.set(l, [...(shopByLoose.get(l) ?? []), n]);
    }
    console.log(`   ${nodes.length.toLocaleString('en-US')} variants`);

    // --- UPC quality in Lightspeed
    const gtinCount = new Map();
    for (const it of items) {
      it.gtin = normalizeGtin(it.upcRaw);
      it.eanGtin = normalizeGtin(it.eanRaw);
      if (it.gtin) gtinCount.set(it.gtin, (gtinCount.get(it.gtin) ?? 0) + 1);
    }
    const q = { ok: 0, empty: 0, emptyButEan: 0, invalid: 0, invalidButFoundInShopify: 0, dup: 0 };
    for (const it of items) {
      if (it.gtin) {
        q.ok++;
        if (gtinCount.get(it.gtin) > 1) { q.dup++; problems.push({ type: 'Duplicate UPC in Lightspeed', ...it }); }
        continue;
      }
      if (!digits(it.upcRaw)) {
        if (it.eanGtin) { q.emptyButEan++; problems.push({ type: 'No UPC but valid EAN (usable)', ...it, found: shopByGtin.has(it.eanGtin) ? 'found in Shopify' : '' }); }
        else { q.empty++; if (it.qty > 0) problems.push({ type: 'Missing UPC (in stock)', ...it }); }
      } else {
        q.invalid++;
        const hit = shopByLoose.get(loose(it.upcRaw));
        if (hit) q.invalidButFoundInShopify++;
        problems.push({ type: hit ? 'Invalid UPC check digit - same code exists in Shopify' : 'Invalid UPC check digit', ...it });
      }
    }

    // --- Matrices
    const byMatrix = new Map();
    for (const it of items) if (it.matrix) byMatrix.set(it.matrix, [...(byMatrix.get(it.matrix) ?? []), it]);
    const m = { full: 0, partial: 0, none: 0, split: 0, sizeMismatch: 0, colorMismatch: 0, matchedItems: 0 };
    const productMatrices = new Map(); // shopify product -> Set(matrix)
    const examples = { split: [], mixed: [], size: [], color: [], partial: [] };
    for (const [mid, its] of byMatrix) {
      const withUpc = its.filter((i) => i.gtin && gtinCount.get(i.gtin) === 1);
      const found = withUpc.filter((i) => shopByGtin.has(i.gtin));
      m.matchedItems += found.length;
      if (!found.length) m.none++;
      else if (found.length === its.length) m.full++;
      else {
        m.partial++;
        if (examples.partial.length < 6 && its.some((i) => i.qty > 0)) examples.partial.push(`${its[0].desc} — ${found.length}/${its.length} variantes encontradas`);
      }
      const products = new Set();
      for (const i of found) {
        for (const sv of shopByGtin.get(i.gtin)) {
          products.add(sv.product.id);
          productMatrices.set(sv.product.id, (productMatrices.get(sv.product.id) ?? new Set()).add(mid));
          const sz = sizeAgrees(i.size, sv);
          if (sz === false) {
            m.sizeMismatch++;
            problems.push({ type: 'SIZE MISMATCH (wrong UPC?)', ...i, shopify: sv.displayName });
            if (examples.size.length < 10) examples.size.push(`LS "${i.desc}" (talla ${i.size}) ↔ Shopify "${sv.displayName}" · UPC ${i.upcRaw}`);
          }
          const co = colorAgrees(i.color, sv);
          if (co === false) {
            m.colorMismatch++;
            problems.push({ type: 'Color mismatch (review)', ...i, shopify: sv.displayName });
            if (examples.color.length < 6) examples.color.push(`LS "${i.desc}" (color ${i.color}) ↔ Shopify "${sv.displayName}"`);
          }
        }
      }
      if (products.size > 1) {
        m.split++;
        if (examples.split.length < 6) examples.split.push(`${its[0].desc} — en ${products.size} productos de Shopify`);
      }
    }
    let mixed = 0;
    for (const [pid, mids] of productMatrices) {
      if (mids.size > 1) {
        mixed++;
        const n = nodes.find((x) => x.product.id === pid);
        if (examples.mixed.length < 6) examples.mixed.push(`${n?.product.title} — mezcla ${mids.size} matrices de Lightspeed`);
      }
    }

    const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
    console.log(`\n=== UPC en Lightspeed (${items.length.toLocaleString('en-US')} artículos) ===`);
    console.log(`  UPC válido ................................ ${q.ok.toLocaleString('en-US')} (${pct(q.ok, items.length)})`);
    console.log(`  Sin UPC ................................... ${q.empty.toLocaleString('en-US')}  (con stock: ${problems.filter((p) => p.type === 'Missing UPC (in stock)').length})`);
    console.log(`  UPC vacío pero EAN válido ................. ${q.emptyButEan}`);
    console.log(`  Invalid UPC check digit ....... ${q.invalid}  (de ellos aparecen igual en Shopify: ${q.invalidButFoundInShopify})`);
    console.log(`  UPC repetido en varios artículos .......... ${q.dup}`);
    console.log(`\n=== Matrices (${byMatrix.size.toLocaleString('en-US')}) ===`);
    console.log(`  Completas en Shopify ...................... ${m.full}`);
    console.log(`  Parciales (faltan colores/tallas) ......... ${m.partial}`);
    console.log(`  No están en Shopify ....................... ${m.none}`);
    console.log(`  Repartidas en varios productos Shopify .... ${m.split}`);
    console.log(`  Productos Shopify que mezclan matrices .... ${mixed}`);
    console.log(`  Talla distinta con el mismo UPC ........... ${m.sizeMismatch}`);
    console.log(`  Color distinto con el mismo UPC ........... ${m.colorMismatch}`);
    for (const [k, title] of [['size', 'Talla no coincide'], ['color', 'Color no coincide'], ['split', 'Matriz repartida'], ['mixed', 'Producto mezclado'], ['partial', 'Matriz parcial con stock']]) {
      if (examples[k].length) console.log(`\n  ${title}:\n   • ${examples[k].join('\n   • ')}`);
    }

    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = ['issue,lightspeed_item_id,description,upc,ean,matrix,color,size,stock,shopify']
      .concat(problems.map((p) => [p.type, p.id, p.desc, p.upcRaw, p.eanRaw, p.matrix, p.color, p.size, p.qty, p.shopify ?? p.found ?? ''].map(esc).join(',')));
    fs.mkdirSync('build', { recursive: true });
    fs.writeFileSync('build/audit-matrices-upc.csv', '﻿' + csv.join('\n'), 'utf8');
    console.log(`\nCSV con ${problems.length.toLocaleString('en-US')} filas: build/audit-matrices-upc.csv`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error('audit failed:', e.message); process.exit(1); });
