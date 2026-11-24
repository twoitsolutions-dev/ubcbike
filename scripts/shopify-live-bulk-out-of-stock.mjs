// Step 4c: Bulk-update all remaining out-of-stock products (totalInventory <= 0) on ubcbike.myshopify.com
// using Shopify Admin GraphQL bulkOperationRunMutation (server-side, fast, zero SKU/price/inventory changes).
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
const targets = backup.products.filter((p) => (p.totalInventory || 0) <= 0);
console.log(`Preparing bulk mutation JSONL for ${targets.length} out-of-stock products...`);

function classifyProduct(p) {
  const pt = (p.productType || '').toLowerCase().trim();
  const text = `${p.title} ${p.handle} ${p.category?.fullName || ''}`.toLowerCase();
  const oldTags = p.tags || [];
  const hasTag = (t) => oldTags.includes(t);

  let cat = 'cat:accessories';
  let type = 'Other Accessories';
  let sub = null;
  let discipline = null;

  if (pt === 'electric_bikes' || pt === 'ebikes' || hasTag('dept-electric-bikes') || /\be-?bike\b|electric bike|turbo vado|turbo levo|turbo creo|super73/i.test(text)) {
    cat = 'cat:bikes'; type = 'Electric Bikes'; sub = 'subcat:electric-bikes'; discipline = 'Electric';
  } else if (pt === 'road_bike' || hasTag('dept-road-bikes')) {
    cat = 'cat:bikes'; type = 'Road Bikes'; discipline = /gravel/i.test(text) ? 'Gravel' : 'Road';
    sub = /gravel|diverg|checkpoint|revolt|topstone/i.test(text) ? 'subsub:gravel' : /triathlon|shiv|speed concept/i.test(text) ? 'subsub:triathlon' : 'subsub:sport-performance';
  } else if (pt === 'mountain_bike' || hasTag('dept-mountain-bikes')) {
    cat = 'cat:bikes'; type = 'Mountain Bikes'; discipline = 'MTB';
  } else if (pt === 'cyclocross_bike') {
    cat = 'cat:bikes'; type = 'Cyclocross Bikes'; discipline = 'Gravel';
  } else if (pt === 'urban_bike' || pt === 'commuter_bike' || pt === 'fixed_gear_bike') {
    cat = 'cat:bikes'; type = 'Commuter & Urban Bikes'; discipline = 'Commuter';
  } else if (pt === 'hybrid_bike' || pt === 'comfort_bike' || pt === 'fitness_bike' || hasTag('dept-hybrid-bikes') || hasTag('dept-comfort-bikes')) {
    cat = 'cat:bikes'; type = 'Hybrid & Comfort Bikes'; discipline = 'Commuter';
  } else if (pt === 'childrens_bike' || pt === 'kids_bike' || hasTag('dept-kids-bikes')) {
    cat = 'cat:bikes'; type = 'Kids Bikes';
  } else if (pt === 'bmx_bike') {
    cat = 'cat:bikes'; type = 'BMX Bikes'; discipline = 'BMX';
  } else if (hasTag('dept-bikes') || pt.endsWith('_bike') || pt === 'bicycles') {
    cat = 'cat:bikes'; type = 'Other Bikes';
  } else if (pt === 'shoes' || pt === 'cycling_shoes' || hasTag('dept-shoes')) {
    cat = 'cat:apparel'; type = 'Cycling Shoes'; sub = 'subcat:shoes';
  } else if (pt === 'gloves') {
    cat = 'cat:apparel'; type = 'Gloves';
  } else if (pt === 'socks') {
    cat = 'cat:apparel'; type = 'Socks';
  } else if (pt === 'clothing' || hasTag('dept-clothing') || /jersey|shorts|bib|jacket|vest|apparel/i.test(pt)) {
    cat = 'cat:apparel';
    if (/glove/i.test(text)) type = 'Gloves';
    else if (/sock/i.test(text)) type = 'Socks';
    else if (/long sleeve/i.test(text)) type = 'Long Sleeve Jerseys';
    else if (/jersey/i.test(text)) type = 'Short Sleeve Jerseys';
    else if (/jacket|vest|rain|wind/i.test(text)) type = 'Outerwear';
    else if (/short|bib|tight|pant/i.test(text)) type = 'Cycling Shorts & Bottoms';
    else type = 'Apparel Accessories';
  } else if (pt === 'helmets' || pt === 'helmet_parts_and_accessories' || hasTag('dept-helmets')) {
    cat = 'cat:accessories'; type = 'Helmets';
  } else if (pt === 'eyewear' || hasTag('dept-eyewear')) {
    cat = 'cat:accessories'; type = 'Eyewear';
  } else if (pt === 'lighting_accessories' || pt === 'lights' || /headlight|taillight|light set/i.test(pt)) {
    cat = 'cat:accessories'; type = 'Lighting';
  } else if (pt === 'bike_locks' || pt === 'locks') {
    cat = 'cat:accessories'; type = 'Locks & Security';
  } else if (pt === 'bags_and_packs' || pt === 'hydration_packs' || pt === 'baskets') {
    cat = 'cat:accessories'; type = 'Packs & Baskets';
  } else if (pt === 'bottles_and_cages' || hasTag('dept-bottles-cages') || hasTag('dept-hydration')) {
    cat = 'cat:accessories'; type = 'Hydration';
  } else if (pt === 'nutrition' || hasTag('dept-nutrition')) {
    cat = 'cat:accessories'; type = 'Nutrition';
  } else if (pt === 'pumps') {
    cat = 'cat:accessories'; type = 'Pumps & Inflation';
  } else if (pt === 'tools_and_workstands' || pt === 'lubes_and_cleaners' || hasTag('dept-tools')) {
    cat = 'cat:accessories'; type = 'Tools & Maintenance';
  } else if (pt === 'car_rack_parts_and_accessories' || pt === 'car_racks') {
    cat = 'cat:accessories'; type = 'Car Racks';
  } else if (pt === 'fenders') {
    cat = 'cat:accessories'; type = 'Fenders';
  } else if (pt === 'electronic_parts_and_accessories' || pt === 'cycling_computers') {
    cat = 'cat:accessories'; type = 'Electronics';
  } else if (pt === 'trainers' || pt === 'indoor_cycling') {
    cat = 'cat:accessories'; type = 'Indoor Cycling';
  } else if (pt === 'cargo_trailers' || pt === 'child_seats') {
    cat = 'cat:accessories'; type = 'Trailers & Strollers';
  } else if (pt === 'tires' || (/tire/i.test(pt) && !/tube/i.test(pt))) {
    cat = 'cat:components'; type = 'Tires'; sub = 'subcat:tires-tubes';
  } else if (pt === 'tubes' || hasTag('dept-tubes')) {
    cat = 'cat:components'; type = 'Tubes'; sub = 'subcat:tires-tubes';
  } else if (hasTag('dept-tires-tubes')) {
    cat = 'cat:components'; sub = 'subcat:tires-tubes';
    type = /\btube\b/i.test(text) ? 'Tubes' : 'Tires';
  } else if (pt === 'saddles' || hasTag('dept-saddles')) {
    cat = 'cat:components'; type = 'Saddles';
  } else if (pt === 'pedals' || hasTag('dept-pedals')) {
    cat = 'cat:components'; type = 'Pedals';
  } else if (pt === 'brake_parts' || pt === 'brakes' || /brake|caliper|rotor|pad/i.test(pt)) {
    cat = 'cat:components'; type = 'Brakes & Levers';
  } else if (pt === 'crankset_parts' || pt === 'cranksets') {
    cat = 'cat:components'; type = 'Cranksets';
  } else if (pt === 'groupsets' || /groupset/i.test(text)) {
    cat = 'cat:components'; type = 'Groupsets';
  } else if (pt === 'seatposts') {
    cat = 'cat:components'; type = 'Seatposts';
  } else if (pt === 'shifters') {
    cat = 'cat:components'; type = 'Shifters';
  } else if (pt === 'bike_wheels' || pt === 'bike_wheel_parts' || pt === 'wheel_hubs' || pt === 'rims' || pt === 'spokes') {
    cat = 'cat:components'; type = 'Wheels';
  } else if (pt === 'handlebars') {
    cat = 'cat:components'; type = 'Handlebars';
  } else if (pt === 'handlebar_grips' || pt === 'handlebar_tape') {
    cat = 'cat:components'; type = 'Grips & Tape';
  } else if (pt === 'stems_parts' || pt === 'stems') {
    cat = 'cat:components'; type = 'Stems';
  } else if (pt === 'chainring_parts' || pt === 'chainrings') {
    cat = 'cat:components'; type = 'Chainrings';
  } else if (pt === 'chains') {
    cat = 'cat:components'; type = 'Chains';
  } else if (pt === 'cassettes_and_freewheels_parts' || pt === 'cassettes') {
    cat = 'cat:components'; type = 'Cassettes & Freewheels';
  } else if (pt === 'derailleurs' || pt === 'derailleur_parts') {
    cat = 'cat:components'; type = 'Derailleurs';
  } else if (pt === 'forks_with_suspension' || pt === 'forks') {
    cat = 'cat:components'; type = 'Forks';
  } else if (pt === 'headsets' || pt === 'headset_parts') {
    cat = 'cat:components'; type = 'Headsets';
  } else if (pt === 'cables' || pt === 'cable_and_housing') {
    cat = 'cat:components'; type = 'Cables';
  } else if (pt === 'bottom_brackets_parts' || pt === 'bottom_brackets' || pt === 'parts_other' || hasTag('dept-parts')) {
    cat = 'cat:components';
    if (/brake|rotor|caliper|disc pad|lever/i.test(text)) type = 'Brakes & Levers';
    else if (/crank/i.test(text)) type = 'Cranksets';
    else if (/groupset|ultegra|105|dura-ace|red axs|force axs/i.test(text) && /group/i.test(text)) type = 'Groupsets';
    else if (/seatpost|dropper/i.test(text)) type = 'Seatposts';
    else if (/shifter|shift lever/i.test(text)) type = 'Shifters';
    else if (/wheel|hub|rim|spoke/i.test(text)) type = 'Wheels';
    else if (/derailleur|hanger/i.test(text)) type = 'Derailleurs';
    else if (/cassette|freewheel/i.test(text)) type = 'Cassettes & Freewheels';
    else if (/chainring/i.test(text)) type = 'Chainrings';
    else if (/\bchain\b/i.test(text)) type = 'Chains';
    else if (/cable|housing/i.test(text)) type = 'Cables';
    else if (/stem\b/i.test(text)) type = 'Stems';
    else if (/handlebar/i.test(text)) type = 'Handlebars';
    else if (/grip|bar tape/i.test(text)) type = 'Grips & Tape';
    else if (/headset/i.test(text)) type = 'Headsets';
    else type = 'Other Components';
  } else if (hasTag('dept-lights-locks')) {
    cat = 'cat:accessories'; type = /lock/i.test(text) ? 'Locks & Security' : 'Lighting';
  }

  const preserved = oldTags.filter((t) => /^(ubc-|black-friday|eoy|dept-|cat:|subcat:|subsub:|promo:|fulfillment:)/i.test(t));
  const nextTags = new Set(preserved);
  nextTags.add(cat);
  if (sub) nextTags.add(sub);

  const hasSale = (p.variants?.nodes || []).some((v) => v.compareAtPrice && Number(v.compareAtPrice) > Number(v.price));
  if (hasSale || hasTag('eoy2026') || hasTag('black-friday-2026')) nextTags.add('promo:closeout');

  const gender = /\bwomen'?s\b|\bwmn\b|\bladies\b/i.test(text)
    ? "Women's"
    : /\bmen'?s\b/i.test(text)
      ? "Men's"
      : /\bkids\b|\byouth\b|\bchild/i.test(text)
        ? 'Kids'
        : 'Unisex';
  const yrMatch = text.match(/\b(201[6-9]|202[0-7])\b/);
  const modelYear = yrMatch ? yrMatch[1] : null;
  const wheelSize = /\b700c|\b700x/i.test(text) ? '700c'
    : /\b29\s?["x]|\b29er\b/i.test(text) ? '29"'
    : /\b27\.5/i.test(text) ? '27.5"'
    : /\b26\s?["x]/i.test(text) ? '26"'
    : /\b24\s?["x]/i.test(text) ? '24"'
    : /\b20\s?["x]/i.test(text) ? '20"'
    : /\b16\s?["x]/i.test(text) ? '16"'
    : /\b12\s?["x]/i.test(text) ? '12"' : null;
  const condition = nextTags.has('promo:closeout') ? 'Closeout' : 'New';
  if (!discipline) {
    if (/\bmtb\b|mountain|\btrail\b|\benduro\b|\bxc\b/i.test(text)) discipline = 'MTB';
    else if (/\bgravel\b/i.test(text)) discipline = 'Gravel';
    else if (/\broad\b/i.test(text)) discipline = 'Road';
    else if (/\bcommuter\b|\burban\b|\bcity\b/i.test(text)) discipline = 'Commuter';
    else if (/\bbmx\b/i.test(text)) discipline = 'BMX';
  }

  const metafields = [
    { namespace: 'custom', key: 'gender', type: 'single_line_text_field', value: gender },
    { namespace: 'custom', key: 'condition', type: 'single_line_text_field', value: condition },
  ];
  if (modelYear) metafields.push({ namespace: 'custom', key: 'model_year', type: 'number_integer', value: modelYear });
  if (wheelSize) metafields.push({ namespace: 'custom', key: 'wheel_size', type: 'single_line_text_field', value: wheelSize });
  if (discipline) metafields.push({ namespace: 'custom', key: 'discipline', type: 'single_line_text_field', value: discipline });

  return {
    product: {
      id: p.id,
      productType: type,
      tags: Array.from(nextTags),
      metafields,
    },
  };
}

const lines = targets.map((p) => JSON.stringify(classifyProduct(p)));
const jsonl = lines.join('\n') + '\n';
await fs.writeFile('build/ubcbike-out-of-stock-bulk.jsonl', jsonl);

// 1. Create staged upload
const stageRes = await client.mutate(`mutation($input: [StagedUploadInput!]!) {
  stagedUploadsCreate(input: $input) {
    stagedTargets {
      url
      resourceUrl
      parameters { name value }
    }
    userErrors { field message }
  }
}`, {
  input: [{
    resource: 'BULK_MUTATION_VARIABLES',
    filename: 'ubcbike-out-of-stock-bulk.jsonl',
    mimeType: 'text/jsonl',
    httpMethod: 'POST',
  }],
});

if (stageRes.stagedUploadsCreate.userErrors?.length) {
  throw new Error(JSON.stringify(stageRes.stagedUploadsCreate.userErrors));
}
const target = stageRes.stagedUploadsCreate.stagedTargets[0];

// 2. Upload JSONL via multipart/form-data
const form = new FormData();
for (const param of target.parameters) {
  form.append(param.name, param.value);
}
form.append('file', new Blob([jsonl], { type: 'text/jsonl' }), 'ubcbike-out-of-stock-bulk.jsonl');
const upRes = await fetch(target.url, { method: 'POST', body: form });
if (!upRes.ok) {
  throw new Error(`Staged upload failed HTTP ${upRes.status}: ${await upRes.text()}`);
}

const keyParam = target.parameters.find((p) => p.name === 'key')?.value;
if (!keyParam) throw new Error('Missing key parameter from staged target');

// 3. Start bulkOperationRunMutation
const bulkRes = await client.mutate(`mutation($mutation: String!, $stagedUploadPath: String!) {
  bulkOperationRunMutation(mutation: $mutation, stagedUploadPath: $stagedUploadPath) {
    bulkOperation { id status }
    userErrors { field message }
  }
}`, {
  mutation: `mutation call($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product { id }
      userErrors { field message }
    }
  }`,
  stagedUploadPath: keyParam,
});

if (bulkRes.bulkOperationRunMutation.userErrors?.length) {
  throw new Error(JSON.stringify(bulkRes.bulkOperationRunMutation.userErrors));
}
console.log('BULK_MUTATION_STARTED:', JSON.stringify(bulkRes.bulkOperationRunMutation.bulkOperation));
