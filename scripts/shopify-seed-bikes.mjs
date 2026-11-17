// Ensures UBC metafield definitions (`ubc.availability`, `ubc.lead_time_days`,
// `ubc.click_and_collect_only`), seeds 4 realistic cycling products on the
// SANDBOX Shopify store (`twoit-pruebas-pipeline.myshopify.com`), and sets live
// unit costs + physical store inventory quantities (`write_inventory`).
//
// Safety rails:
//  - Refuses to run unless the shop domain looks like a sandbox/dev store OR
//    `ALLOW_SEED_BIKES=true` is explicitly set.
//  - Requires `SHOPIFY_WRITES_ENABLED=true` and `write_products` + `write_inventory`
//    scopes on the Shopify Dev Dashboard app.
import { randomUUID } from 'node:crypto';
import { ShopifyAdminApi, ShopifyAdminClient } from '../packages/integrations/dist/index.js';

const shopDomain = (process.env.SHOPIFY_SHOP_DOMAIN || '').trim();
if (!/pruebas|sandbox|test|dev/i.test(shopDomain) && process.env.ALLOW_SEED_BIKES !== 'true') {
  console.error(`Refusing to seed sample cycling products into non-sandbox shop "${shopDomain}".`);
  process.exit(1);
}

const writesEnabled = process.env.SHOPIFY_WRITES_ENABLED === 'true' || process.env.SHOPIFY_WRITES_ENABLED === '1';
if (!writesEnabled) {
  console.log('SHOPIFY_WRITES_ENABLED is false — skipping live mutations.');
  console.log('To push sample cycling products + UBC metafields to your sandbox store:');
  console.log('  1. Ensure your Dev Dashboard app has scopes: write_products, write_inventory');
  console.log('  2. Set SHOPIFY_WRITES_ENABLED=true in .env');
  console.log('  3. Run: npm run shopify:seed-bikes && npm run shopify:bootstrap');
  process.exit(0);
}

const client = new ShopifyAdminClient({
  shopDomain,
  clientId: process.env.SHOPIFY_CLIENT_ID?.trim(),
  clientSecret: process.env.SHOPIFY_CLIENT_SECRET?.trim(),
  accessToken: process.env.SHOPIFY_ADMIN_ACCESS_TOKEN?.trim(),
  apiVersion: process.env.SHOPIFY_API_VERSION?.trim() || undefined,
  plan: (process.env.SHOPIFY_PLAN?.trim() || 'basic'),
  writesEnabled: true,
});

const health = await client.health();
console.log('Shop health:', health.detail);
if (health.status !== 'connected') {
  console.error('Shopify is not connected.');
  process.exit(1);
}

const neededScopes = ['write_products', 'write_inventory'].filter(
  (sc) => client.grantedScopes.length > 0 && !client.grantedScopes.includes(sc),
);
if (neededScopes.length > 0) {
  console.error(`\nBlocked by Shopify OAuth scopes on "${shopDomain}":`);
  console.error(`  Current scopes : ${client.grantedScopes.join(', ')}`);
  console.error(`  Missing scopes : ${neededScopes.join(', ')}`);
  console.error('\nApprove write_products & write_inventory in Shopify Dev Dashboard (Release version + Update in store Admin), then re-run `npm run shopify:seed-bikes`.');
  process.exit(1);
}

const api = new ShopifyAdminApi(client);
console.log('1/3 Ensuring UBC metafield definitions (`ubc.*`) on Shopify...');
const defs = await api.ensureUbcMetafieldDefinitions();
console.log('    Metafields:', JSON.stringify(defs));

const SAMPLE_PRODUCTS = [
  {
    title: 'Specialized Tarmac SL7 Sport — 56cm',
    vendor: 'Specialized',
    productType: 'Road Bikes',
    sku: 'UBC-SPZ-SL7-56',
    barcode: '888818626144',
    price: '2799.99',
    unitCost: '1820.00',
    onHandQty: 2,
    availability: 'in_stock',
    leadDays: 0,
    pickupOnly: true,
  },
  {
    title: 'Surly Midnight Special Frame — 54cm',
    vendor: 'Surly',
    productType: 'Gravel Frames',
    sku: 'UBC-SUR-MS-54',
    barcode: '036000291452',
    price: '899.99',
    unitCost: '585.00',
    onHandQty: 0,
    availability: 'special_order',
    leadDays: 4,
    pickupOnly: false,
  },
  {
    title: 'Continental Grand Prix 5000 700x28c Tire',
    vendor: 'Continental',
    productType: 'Tires',
    sku: 'UBC-CON-GP5K-28',
    barcode: '768686473494',
    price: '79.99',
    unitCost: '44.50',
    onHandQty: 0,
    availability: 'special_order',
    leadDays: 3,
    pickupOnly: false,
  },
  {
    title: 'Bell Z20 MIPS Road Helmet — Medium',
    vendor: 'Bell',
    productType: 'Helmets',
    sku: 'UBC-BEL-Z20-M',
    barcode: '768686209277',
    price: '149.99',
    unitCost: '82.00',
    onHandQty: 8,
    availability: 'in_stock',
    leadDays: 0,
    pickupOnly: false,
  },
];

console.log('2/3 Creating sample cycling products (idempotent by SKU check)...');
let catalog = await api.listVariants(null);
const bySku = new Map(catalog.variants.filter((v) => v.sku).map((v) => [v.sku, v]));

const CREATE_PRODUCT = `mutation CreateSampleProduct($input: ProductSetInput!) {
  productSet(synchronous: true, input: $input) {
    product { id title variants(first: 1) { nodes { id sku inventoryItem { id } } } }
    userErrors { field message }
  }
}`;

for (const item of SAMPLE_PRODUCTS) {
  let existingVariant = bySku.get(item.sku);
  if (existingVariant) {
    console.log(`    [exists] ${item.sku} — ${item.title} (${existingVariant.variantId})`);
  } else {
    const res = await client.mutate(CREATE_PRODUCT, {
      input: {
        title: item.title,
        vendor: item.vendor,
        productType: item.productType,
        status: 'ACTIVE',
        productOptions: [{ name: 'Title', values: [{ name: 'Default Title' }] }],
        variants: [
          {
            optionValues: [{ optionName: 'Title', name: 'Default Title' }],
            sku: item.sku,
            barcode: item.barcode,
            price: item.price,
            inventoryPolicy: item.availability === 'special_order' ? 'CONTINUE' : 'DENY',
          },
        ],
      },
    });
    const errs = res.productSet?.userErrors || [];
    if (errs.length) {
      console.error(`    [error] ${item.sku}:`, errs.map((e) => e.message).join('; '));
      continue;
    }
    const vNode = res.productSet?.product?.variants?.nodes?.[0];
    console.log(`    [created] ${item.sku} — ${item.title} (${vNode?.id})`);
    existingVariant = {
      variantId: vNode?.id,
      inventoryItemId: vNode?.inventoryItem?.id ?? null,
    };
  }

  if (existingVariant?.variantId) {
    await api.setVariantFulfillmentMetafields([
      {
        variantId: existingVariant.variantId,
        availability: item.availability,
        leadTimeDays: item.leadDays || null,
        clickAndCollectOnly: item.pickupOnly,
      },
    ]);
  }
}

console.log('3/3 Syncing inventory tracking, unit costs, and physical store on-hand quantities...');
catalog = await api.listVariants(null);
const refreshedBySku = new Map(catalog.variants.filter((v) => v.sku).map((v) => [v.sku, v]));

let locationId = (process.env.SHOPIFY_PHYSICAL_LOCATION_ID || '').trim();
if (!locationId) {
  const locations = await api.listLocations();
  locationId = locations.find((l) => l.isActive)?.id || '';
}

const INVENTORY_ITEM_UPDATE = `mutation UpdateInvItem($id: ID!, $input: InventoryItemInput!) {
  inventoryItemUpdate(id: $id, input: $input) {
    inventoryItem { id tracked }
    userErrors { field message }
  }
}`;

const INVENTORY_ACTIVATE = `mutation ActivateInv($inventoryItemId: ID!, $locationId: ID!, $idempotencyKey: String!) {
  inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) @idempotent(key: $idempotencyKey) {
    inventoryLevel { id }
    userErrors { field message }
  }
}`;

const qtyUpdates = [];
for (const item of SAMPLE_PRODUCTS) {
  const v = refreshedBySku.get(item.sku);
  if (!v?.inventoryItemId) continue;
  const upd = await client.mutate(INVENTORY_ITEM_UPDATE, {
    id: v.inventoryItemId,
    input: { tracked: true, cost: item.unitCost },
  });
  const updErrs = upd.inventoryItemUpdate?.userErrors || [];
  if (updErrs.length) {
    console.error(`    [inv-item error] ${item.sku}:`, updErrs.map((e) => e.message).join('; '));
  }
  if (locationId) {
    await client.mutate(INVENTORY_ACTIVATE, {
      idempotencyKey: randomUUID(),
      inventoryItemId: v.inventoryItemId,
      locationId,
    });
    qtyUpdates.push({ inventoryItemId: v.inventoryItemId, quantity: item.onHandQty });
  }
}

if (locationId && qtyUpdates.length) {
  await api.setInventoryOnHand(locationId, qtyUpdates);
  console.log(`    [inventory] Updated ${qtyUpdates.length} cycling SKUs at location ${locationId}`);
}

console.log('4/4 Ensuring `bikes` collection exists for UBC sobre Dawn v10 Showcase...');
const cyclingProductIds = SAMPLE_PRODUCTS.map((item) => refreshedBySku.get(item.sku)?.productId).filter(Boolean);
if (cyclingProductIds.length) {
  const FIND_BIKES = `query { collectionByHandle(handle: "bikes") { id handle } }`;
  const found = await client.query(FIND_BIKES);
  if (found.collectionByHandle?.id) {
    const ADD_PRODS = `mutation AddToBikes($id: ID!, $productIds: [ID!]!) {
      collectionAddProducts(id: $id, productIds: $productIds) {
        userErrors { field message }
      }
    }`;
    await client.mutate(ADD_PRODS, { id: found.collectionByHandle.id, productIds: cyclingProductIds });
    console.log(`    [collection] Synced ${cyclingProductIds.length} products into existing 'bikes' collection (${found.collectionByHandle.id})`);
  } else {
    const CREATE_COLL = `mutation CreateBikes($input: CollectionInput!) {
      collectionCreate(input: $input) {
        collection { id handle }
        userErrors { field message }
      }
    }`;
    const created = await client.mutate(CREATE_COLL, {
      input: {
        title: 'Bikes & Gear',
        handle: 'bikes',
        products: cyclingProductIds,
      },
    });
    const cErrs = created.collectionCreate?.userErrors || [];
    if (cErrs.length) {
      console.error('    [collection error]', cErrs.map((e) => e.message).join('; '));
    } else {
      console.log(`    [collection] Created 'bikes' collection (${created.collectionCreate?.collection?.id}) with ${cyclingProductIds.length} cycling products`);
    }
  }
}

console.log('Done! Run `npm run shopify:bootstrap` to sync new variants into Supabase.');
