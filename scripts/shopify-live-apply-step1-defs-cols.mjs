// Step 4a: Create custom.* metafield definitions + create/update automated collections on ubcbike.myshopify.com
import fs from 'node:fs/promises';
import { ShopifyAdminClient } from '../packages/integrations/dist/index.js';

const shopDomain = (process.env.UBC_LIVE_SHOPIFY_DOMAIN || '').trim();
const accessToken = (process.env.UBC_LIVE_SHOPIFY_ACCESS_TOKEN || '').trim();
const client = new ShopifyAdminClient({
  shopDomain,
  accessToken,
  apiVersion: process.env.SHOPIFY_API_VERSION?.trim() || '2026-10',
  plan: 'plus',
  writesEnabled: true,
});

const backup = JSON.parse(await fs.readFile('build/ubcbike-live-backup-2026-11-24T20-12-30-066Z.json', 'utf8'));
const existingDefs = new Set((backup.metafieldDefinitions || []).map((d) => `${d.namespace}.${d.key}`));
const existingColsByHandle = new Map((backup.collections || []).map((c) => [c.handle, c]));

const TARGET_DEFS = [
  { name: 'Gender', namespace: 'custom', key: 'gender', type: 'single_line_text_field' },
  { name: 'Model Year', namespace: 'custom', key: 'model_year', type: 'number_integer' },
  { name: 'Wheel Size', namespace: 'custom', key: 'wheel_size', type: 'single_line_text_field' },
  { name: 'Condition', namespace: 'custom', key: 'condition', type: 'single_line_text_field' },
  { name: 'Discipline', namespace: 'custom', key: 'discipline', type: 'single_line_text_field' },
];

for (const def of TARGET_DEFS) {
  const full = `${def.namespace}.${def.key}`;
  if (existingDefs.has(full)) {
    console.log(`Metafield def exists: ${full}`);
    continue;
  }
  const r = await client.mutate(`mutation($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id key }
      userErrors { field message }
    }
  }`, {
    definition: { ...def, ownerType: 'PRODUCT', pin: true },
  });
  const errs = r.metafieldDefinitionCreate.userErrors;
  if (errs.length) console.warn(`Warn def ${full}:`, errs);
  else console.log(`Created metafield def: ${full}`);
}

const invRule = { column: 'VARIANT_INVENTORY', relation: 'GREATER_THAN', condition: '0' };
const typeCol = (title, handle, typeName = title) => ({
  title,
  handle,
  disjunctive: false,
  rules: [{ column: 'TYPE', relation: 'EQUALS', condition: typeName }, invRule],
});
const tagCol = (title, handle, tag) => ({
  title,
  handle,
  disjunctive: false,
  rules: [{ column: 'TAG', relation: 'EQUALS', condition: tag }, invRule],
});

const TARGET_COLLECTIONS = [
  // Level 1 Parents (Bikes & E-Bikes keeps Electric Bikes inside)
  { title: 'Bikes & E-Bikes', handle: 'bikes', disjunctive: false, rules: [{ column: 'TAG', relation: 'EQUALS', condition: 'cat:bikes' }, invRule] },
  tagCol('Components', 'parts-components', 'cat:components'),
  tagCol('Accessories', 'accessories-gear', 'cat:accessories'),
  tagCol('Apparel, Jerseys & Shorts', 'clothing', 'cat:apparel'),
  {
    title: 'Sales & Closeouts',
    handle: 'sales-closeouts',
    disjunctive: true,
    rules: [
      { column: 'VARIANT_COMPARE_AT_PRICE', relation: 'GREATER_THAN', condition: '0' },
      { column: 'TAG', relation: 'EQUALS', condition: 'promo:closeout' },
      { column: 'TAG', relation: 'EQUALS', condition: 'black-friday-2026' },
      { column: 'TAG', relation: 'EQUALS', condition: 'eoy2026' },
    ],
  },

  // Bikes Level 2
  typeCol('Road & Gravel Bikes', 'road-bikes', 'Road Bikes'),
  typeCol('Mountain Bikes', 'mountain-bikes', 'Mountain Bikes'),
  typeCol('Hybrid & Comfort Bikes', 'hybrid-bikes', 'Hybrid & Comfort Bikes'),
  typeCol('Commuter & Urban Bikes', 'commuter-urban-bikes', 'Commuter & Urban Bikes'),
  typeCol('Electric Bikes', 'electric-bikes', 'Electric Bikes'),
  typeCol('Kids Bikes', 'kids-bikes', 'Kids Bikes'),
  typeCol('BMX Bikes', 'bmx-bikes', 'BMX Bikes'),

  // Components Level 2
  tagCol('Tires, Tubes & Tubeless', 'tires-tubes', 'subcat:tires-tubes'),
  typeCol('Tires', 'bicycle-tires', 'Tires'),
  typeCol('Tubes', 'tubes', 'Tubes'),
  typeCol('Brakes & Levers', 'brakes-levers', 'Brakes & Levers'),
  typeCol('Cables', 'cables', 'Cables'),
  typeCol('Cassettes & Freewheels', 'cassettes-freewheels', 'Cassettes & Freewheels'),
  typeCol('Chainrings', 'chainrings', 'Chainrings'),
  typeCol('Chains', 'chains', 'Chains'),
  typeCol('Cranksets', 'cranksets', 'Cranksets'),
  typeCol('Derailleurs', 'derailleurs', 'Derailleurs'),
  typeCol('Forks', 'forks', 'Forks'),
  typeCol('Groupsets', 'groupsets', 'Groupsets'),
  typeCol('Grips & Tape', 'grips-tape', 'Grips & Tape'),
  typeCol('Handlebars', 'handlebars', 'Handlebars'),
  typeCol('Headsets', 'headsets', 'Headsets'),
  typeCol('Pedals', 'pedals', 'Pedals'),
  typeCol('Saddles', 'saddles', 'Saddles'),
  typeCol('Seatposts', 'seatposts', 'Seatposts'),
  typeCol('Shifters', 'shifters', 'Shifters'),
  typeCol('Stems', 'stems', 'Stems'),
  typeCol('Wheels', 'wheels', 'Wheels'),
  typeCol('Other Components', 'other-components', 'Other Components'),

  // Accessories Level 2
  typeCol('Helmets', 'helmets', 'Helmets'),
  typeCol('Car Racks', 'car-racks', 'Car Racks'),
  typeCol('Electronics', 'electronics', 'Electronics'),
  typeCol('Eyewear', 'eyewear', 'Eyewear'),
  typeCol('Fenders', 'fenders', 'Fenders'),
  typeCol('Hydration', 'hydration-nutrition', 'Hydration'),
  typeCol('Lighting', 'lighting', 'Lighting'),
  typeCol('Locks & Security', 'locks-security', 'Locks & Security'),
  typeCol('Nutrition', 'nutrition', 'Nutrition'),
  typeCol('Packs & Baskets', 'packs-baskets', 'Packs & Baskets'),
  typeCol('Pumps & Inflation', 'pumps-inflation', 'Pumps & Inflation'),
  typeCol('Tools & Maintenance', 'tools-workshop', 'Tools & Maintenance'),
  typeCol('Other Accessories', 'other-accessories', 'Other Accessories'),

  // Apparel Level 2
  typeCol('Cycling Shoes', 'cycling-shoes', 'Cycling Shoes'),
  typeCol('Gloves', 'gloves', 'Gloves'),
  typeCol('Short Sleeve Jerseys', 'jerseys-short-sleeve', 'Short Sleeve Jerseys'),
  typeCol('Long Sleeve Jerseys', 'jerseys-long-sleeve', 'Long Sleeve Jerseys'),
  typeCol('Outerwear', 'outerwear', 'Outerwear'),
  typeCol('Cycling Shorts & Bottoms', 'cycling-shorts-bottoms', 'Cycling Shorts & Bottoms'),
  typeCol('Socks', 'socks', 'Socks'),
  typeCol('Apparel Accessories', 'apparel-accessories', 'Apparel Accessories'),
];

let created = 0;
let updated = 0;
for (const c of TARGET_COLLECTIONS) {
  const existing = existingColsByHandle.get(c.handle);
  if (existing) {
    if (!existing.ruleSet) {
      console.log(`Skipping manual collection ${c.handle}`);
      continue;
    }
    const r = await client.mutate(`mutation($input: CollectionInput!) {
      collectionUpdate(input: $input) {
        collection { id handle title }
        userErrors { field message }
      }
    }`, {
      input: {
        id: existing.id,
        ruleSet: { appliedDisjunctively: c.disjunctive, rules: c.rules },
      },
    });
    const errs = r.collectionUpdate.userErrors;
    if (errs.length) console.error(`Error updating ${c.handle}:`, errs);
    else { updated++; console.log(`Updated collection: ${c.handle} (${c.title})`); }
  } else {
    const r = await client.mutate(`mutation($input: CollectionInput!) {
      collectionCreate(input: $input) {
        collection { id handle title }
        userErrors { field message }
      }
    }`, {
      input: {
        title: c.title,
        handle: c.handle,
        ruleSet: { appliedDisjunctively: c.disjunctive, rules: c.rules },
      },
    });
    const errs = r.collectionCreate.userErrors;
    if (errs.length) console.error(`Error creating ${c.handle}:`, errs);
    else { created++; console.log(`Created collection: ${c.handle} (${c.title})`); }
  }
}
console.log(`\nStep 4a complete: created=${created}, updated=${updated}`);
