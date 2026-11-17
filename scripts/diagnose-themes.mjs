import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

function stripJsonComments(raw) {
  // Shopify allows leading /* ... */ comment headers in OS 2.0 JSON files
  return raw.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, '');
}

const DAWN_SCHEMALESS_SECTIONS = new Set([
  'cart-drawer.liquid',
  'cart-icon-bubble.liquid',
  'cart-live-region-text.liquid',
  'cart-notification-button.liquid',
  'cart-notification-product.liquid',
  'main-404.liquid',
  'pickup-availability.liquid',
  'predictive-search.liquid',
]);

async function auditTheme(label, dir) {
  console.log(`\n================ AUDIT: ${label} (${dir}) ================`);
  const issues = [];

  // 1. Check required directories & files + critical Dawn config integrity (>= 38 KB schema + scheme-1..scheme-5)
  for (const req of ['layout/theme.liquid', 'config/settings_schema.json', 'config/settings_data.json', 'templates/index.json']) {
    if (!existsSync(join(dir, req))) {
      issues.push(`MISSING REQUIRED FILE: ${req}`);
    }
  }
  if (existsSync(join(dir, 'config/settings_schema.json'))) {
    const schemaStat = await stat(join(dir, 'config/settings_schema.json'));
    console.log(`settings_schema.json: ${(schemaStat.size / 1024).toFixed(1)} KB`);
    if (schemaStat.size < 38000) {
      issues.push(`CRITICAL: config/settings_schema.json is ${schemaStat.size} bytes (< 38 KB)!`);
    }
  }
  if (existsSync(join(dir, 'config/settings_data.json'))) {
    try {
      const sd = JSON.parse(stripJsonComments(await readFile(join(dir, 'config/settings_data.json'), 'utf8')));
      if (dir.includes('dawn-ubc') && (typeof sd.current !== 'object' || !sd.current)) {
        issues.push(`CRITICAL: config/settings_data.json uses legacy string "current": ${JSON.stringify(sd.current)} instead of an OS 2.0 object!`);
      }
      const active = typeof sd.current === 'object' && sd.current ? sd.current : sd.presets?.[sd.current];
      for (const sc of ['scheme-1', 'scheme-2', 'scheme-3', 'scheme-4', 'scheme-5']) {
        if (!active?.color_schemes?.[sc]?.settings?.background) {
          issues.push(`CRITICAL: Missing ${sc} in config/settings_data.json!`);
        }
      }
    } catch (err) {
      issues.push(`CRITICAL: Unparseable config/settings_data.json: ${err.message}`);
    }
  }

  // 2. Parse all JSON files
  const jsonDirs = ['config', 'locales', 'sections', 'templates', 'templates/customers'];
  const parsedJson = new Map();
  for (const sub of jsonDirs) {
    const fullSub = join(dir, sub);
    if (!existsSync(fullSub)) continue;
    const entries = await readdir(fullSub, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.json')) continue;
      const rel = `${sub}/${e.name}`;
      const raw = await readFile(join(fullSub, e.name), 'utf8');
      try {
        const data = JSON.parse(stripJsonComments(raw));
        parsedJson.set(rel, data);
      } catch (err) {
        issues.push(`INVALID JSON in ${rel}: ${err.message}`);
      }
    }
  }

  // 3. Parse all section schemas
  const secDir = join(dir, 'sections');
  const secEntries = await readdir(secDir, { withFileTypes: true });
  const sectionSchemas = new Map();
  for (const e of secEntries) {
    if (!e.isFile() || !e.name.endsWith('.liquid')) continue;
    const secType = e.name.replace(/\.liquid$/, '');
    const raw = await readFile(join(secDir, e.name), 'utf8');
    const m = raw.match(/\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/);
    if (!m) {
      if (DAWN_SCHEMALESS_SECTIONS.has(e.name)) {
        sectionSchemas.set(secType, { settings: [], blocks: [] });
      } else {
        issues.push(`MISSING {% schema %} in sections/${e.name}`);
      }
      continue;
    }
    try {
      const schema = JSON.parse(m[1]);
      sectionSchemas.set(secType, schema);

      // Check unwired section.settings.<id> in custom UBC/Fable sections
      if (e.name.startsWith('fable-') || e.name.startsWith('ubc-')) {
        const liquidBody = raw.slice(0, m.index);
        for (const s of schema.settings || []) {
          if (s.id && !liquidBody.includes(`section.settings.${s.id}`)) {
            issues.push(`UNWIRED SETTING section.settings.${s.id} in sections/${e.name}`);
          }
        }
      }

      if (schema.name && !schema.name.startsWith('t:') && schema.name.length > 25) {
        issues.push(`SCHEMA NAME > 25 CHARS in sections/${e.name}: "${schema.name}" (${schema.name.length})`);
      }
      if (Array.isArray(schema.presets)) {
        for (const p of schema.presets) {
          if (p.name && !p.name.startsWith('t:') && p.name.length > 25) {
            issues.push(`PRESET NAME > 25 CHARS in sections/${e.name}: "${p.name}" (${p.name.length})`);
          }
        }
      }

      // Check settings constraints
      const allSettings = [
        ...(schema.settings || []),
        ...((schema.blocks || []).flatMap((b) => b.settings || [])),
      ];
      for (const s of allSettings) {
        if (['url', 'product', 'collection', 'image_picker', 'video', 'article', 'blog', 'page'].includes(s.type)) {
          if ('default' in s && (s.default === '' || s.default !== undefined)) {
            // Note: url allows "/" or "/collections/all" only, NEVER ""
            if (s.type !== 'url' || s.default === '') {
              issues.push(`FORBIDDEN DEFAULT on type="${s.type}" id="${s.id}" in sections/${e.name}: ${JSON.stringify(s.default)}`);
            }
          }
        }
        if (s.type === 'range') {
          const steps = (s.max - s.min) / s.step;
          if (steps > 100 || !Number.isInteger(Math.round(steps * 1000) / 1000)) {
            issues.push(`INVALID RANGE steps=${steps} id="${s.id}" in sections/${e.name}`);
          }
          if (s.unit && s.unit.length > 3) {
            issues.push(`RANGE UNIT > 3 CHARS id="${s.id}" unit="${s.unit}" in sections/${e.name}`);
          }
        }
      }
    } catch (err) {
      issues.push(`INVALID SCHEMA JSON in sections/${e.name}: ${err.message}`);
    }

    // Check Liquid pitfalls
    if (raw.includes('forloop.parentloop')) {
      issues.push(`USES forloop.parentloop in sections/${e.name}`);
    }
  }

  // 4. Validate section groups (header-group.json, footer-group.json) & templates/*.json
  for (const [rel, data] of parsedJson.entries()) {
    if (!rel.startsWith('sections/') && !rel.startsWith('templates/')) continue;
    const isGroup = rel.startsWith('sections/');
    const groupType = data.type; // 'header' or 'footer'
    const sectionsObj = data.sections || {};

    for (const [secKey, secInst] of Object.entries(sectionsObj)) {
      const sType = secInst.type;
      const schema = sectionSchemas.get(sType);
      if (!schema) {
        issues.push(`${rel} references missing section type "${sType}" (key "${secKey}")`);
        continue;
      }

      if (isGroup) {
        // Check enabled_on / disabled_on rules for section groups!
        if (schema.disabled_on?.groups?.includes(groupType) || schema.disabled_on?.groups?.includes('*')) {
          issues.push(`${rel} uses "${sType}" which is disabled_on group "${groupType}"`);
        }
        if (schema.enabled_on?.groups && !schema.enabled_on.groups.includes(groupType) && !schema.enabled_on.groups.includes('*')) {
          issues.push(`${rel} uses "${sType}" whose enabled_on.groups=${JSON.stringify(schema.enabled_on.groups)} excludes "${groupType}"`);
        }
        if (schema.enabled_on?.templates && !schema.enabled_on?.groups) {
          issues.push(`${rel} uses "${sType}" which only enables templates, not group "${groupType}"`);
        }
        // Notice: custom sections in groups without enabled_on.groups or presets
        if (!sType.startsWith('header') && !sType.startsWith('footer') && (!schema.enabled_on?.groups || !schema.enabled_on.groups.includes(groupType))) {
          issues.push(`ADVISORY/UPLOAD RISK: ${rel} custom section "${sType}" lacks enabled_on.groups: ["${groupType}"]`);
        }
      }

      // Check block types & settings in JSON match schema
      const schemaSettings = new Map((schema.settings || []).filter((s) => s.id).map((s) => [s.id, s]));
      for (const [k, val] of Object.entries(secInst.settings || {})) {
        if (!schemaSettings.has(k)) {
          issues.push(`${rel} -> ${secKey}.settings.${k} DOES NOT EXIST in sections/${sType}.liquid schema!`);
        }
      }

      const blockSchemas = new Map((schema.blocks || []).map((b) => [b.type, b]));
      for (const [bKey, bInst] of Object.entries(secInst.blocks || {})) {
        const bSchema = blockSchemas.get(bInst.type);
        if (!bSchema) {
          issues.push(`${rel} -> ${secKey}.blocks.${bKey} has unknown block type "${bInst.type}" for "${sType}"!`);
          continue;
        }
        const bSettings = new Map((bSchema.settings || []).filter((s) => s.id).map((s) => [s.id, s]));
        for (const [bk, bval] of Object.entries(bInst.settings || {})) {
          if (!bSettings.has(bk)) {
            issues.push(`${rel} -> ${secKey}.blocks.${bKey}.settings.${bk} DOES NOT EXIST in "${sType}" block "${bInst.type}"!`);
          }
        }
      }
    }

    // Check order array matches keys
    const secKeys = Object.keys(sectionsObj);
    const orderKeys = data.order || [];
    for (const k of orderKeys) {
      if (!sectionsObj[k]) issues.push(`${rel} order references missing key "${k}"`);
    }
    for (const k of secKeys) {
      if (!orderKeys.includes(k)) issues.push(`${rel} section "${k}" missing from order[]`);
    }
  }

  // 5. Check assets for size or weird names & check ubc-motion.js
  const assetsDir = join(dir, 'assets');
  const assetEntries = await readdir(assetsDir, { withFileTypes: true });
  let maxAsset = { name: '', size: 0 };
  for (const a of assetEntries) {
    if (!a.isFile()) continue;
    const st = await stat(join(assetsDir, a.name));
    if (st.size === 0) issues.push(`ZERO-BYTE ASSET: assets/${a.name}`);
    if (st.size > maxAsset.size) maxAsset = { name: a.name, size: st.size };
    if (/[^a-zA-Z0-9._-]/.test(a.name)) {
      issues.push(`UNSAFE ASSET FILENAME: assets/${a.name}`);
    }
  }
  console.log(`Assets count: ${assetEntries.length}, largest: ${maxAsset.name} (${(maxAsset.size / 1024).toFixed(1)} KB)`);

  if (issues.length === 0) {
    console.log('0 issues found!');
  } else {
    for (const i of issues) console.log('  [!] ' + i);
  }
}

await auditTheme('v9 (Shopify Export Reference)', 'C:/Users/PMC/.gemini/antigravity/brain/b52a5da2-98e9-4fe1-9336-f1c3a32b9d9b/scratch/ubc-sobre-dawn-v9');
await auditTheme('v11 (Boutique Dawn)', resolve('apps/dawn-ubc-theme'));
await auditTheme('v24 (UBC Dawn Ecommerce)', resolve('apps/dawn-ubc-fable-theme'));
