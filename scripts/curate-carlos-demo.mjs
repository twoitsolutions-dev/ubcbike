// Curates a clean, realistic University Bicycle Center (UBC) showcase environment
// across the Shopify Sandbox (`twoit-pruebas-pipeline.myshopify.com`) and the
// `twoit-sandbox` tenant in Supabase PostgreSQL — strictly isolated from any non-sandbox tenant.
//
// Provides 1 authentic cycling example of every key business scenario so Carlos Mirabal
// can inspect each case immediately AND run live hands-on tests.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { normalizeGtin, normalizeSupplierPayload } from '../packages/business-rules/dist/index.js';
import { createPool } from '../packages/database/dist/index.js';
import { ShopifyAdminApi, ShopifyAdminClient } from '../packages/integrations/dist/index.js';
import { loadConfig } from '../apps/api/dist/config/env.js';
import { createConnectors } from '../apps/api/dist/services/connectors.js';
import { syncFromShopifyJob } from '../apps/api/dist/services/shopify-sync.js';
import { importSupplierRecords } from '../apps/api/dist/services/suppliers.js';
import { approveCampaign, applyCampaignJob, createCampaign } from '../apps/api/dist/services/campaigns.js';

function gs1Upc12(prefix11) {
  if (!/^\d{11}$/.test(prefix11)) throw new Error(`Expected 11 digits, got ${prefix11}`);
  let sum = 0;
  for (let i = 0; i < 11; i++) {
    sum += Number(prefix11[i]) * (i % 2 === 0 ? 3 : 1);
  }
  const check = (10 - (sum % 10)) % 10;
  const upc = `${prefix11}${check}`;
  if (!normalizeGtin(upc)) throw new Error(`Invalid GTIN computed: ${upc}`);
  return upc;
}

const shopDomain = (process.env.SHOPIFY_SHOP_DOMAIN || '').trim();
if (!/pruebas|sandbox|test|dev|ubcbike-hub/i.test(shopDomain)) {
  throw new Error(`Refusing to curate demo data on non-sandbox shop "${shopDomain}".`);
}

const cfg = loadConfig({ ...process.env, SHOPIFY_WRITES_ENABLED: 'true' });
const pool = createPool(cfg.env.DATABASE_URL);

const shopifyClient = new ShopifyAdminClient({
  shopDomain,
  clientId: process.env.SHOPIFY_CLIENT_ID?.trim(),
  clientSecret: process.env.SHOPIFY_CLIENT_SECRET?.trim(),
  accessToken: process.env.SHOPIFY_ADMIN_ACCESS_TOKEN?.trim(),
  apiVersion: process.env.SHOPIFY_API_VERSION?.trim() || '2026-10',
  plan: (process.env.SHOPIFY_PLAN?.trim() || 'basic'),
  physicalLocationId: process.env.SHOPIFY_PHYSICAL_LOCATION_ID?.trim(),
  writesEnabled: true,
});
const shopifyApi = new ShopifyAdminApi(shopifyClient);

const ctx = {
  pool,
  config: cfg,
  connectors: {
    ...createConnectors(cfg, pool),
    shopify: shopifyApi,
    shopifyHealth: () => shopifyClient.health(),
  },
};

const CURATED_CATALOG = [
  {
    sku: 'UBC-SPZ-SL7-56',
    lsId: 'LS-204101',
    title: 'Specialized Tarmac SL7 Sport — 56cm',
    vendor: 'Specialized',
    category: 'Road Bikes',
    mpn: 'TARMAC-SL7-56',
    upc: gs1Upc12('88881862614'),
    basePrice: '2799.99',
    unitCost: '1820.00',
    mapCents: 279999,
    mapPolicy: 'map',
    onHandQty: 2,
    reservedQty: 0,
    availability: 'in_stock',
    leadDays: 0,
    pickupOnly: true,
    imageAsset: 'fable-bike-tarmac.png',
    description: 'FACT 9r carbon aero road bike with Shimano 105 12-speed drivetrain and hydraulic disc brakes. Includes certified UBC Tampa mechanic assembly & rider fit.',
  },
  {
    sku: 'UBC-SPZ-VADO-L',
    lsId: 'LS-204102',
    title: 'Specialized Turbo Vado 4.0 Step-Through E-Bike — Large',
    vendor: 'Specialized',
    category: 'Electric Bikes',
    mpn: '95224-5004',
    upc: gs1Upc12('88881874512'),
    basePrice: '3249.99',
    unitCost: '2150.00',
    mapCents: 324999,
    mapPolicy: 'map',
    onHandQty: 0,
    reservedQty: 0,
    availability: 'special_order',
    leadDays: 5,
    pickupOnly: true,
    imageAsset: 'spz-turbo-vado-4.png',
    description: 'Full-power Turbo Full Power 2.0E 250W motor with 710Wh integrated battery, MasterMind TCD display, Garmin radar, and integrated commuter rack & fenders.',
  },
  {
    sku: 'UBC-BEL-Z20-M',
    lsId: 'LS-204103',
    title: 'Bell Z20 MIPS Road Helmet — Medium',
    vendor: 'Bell',
    category: 'Helmets',
    mpn: 'BELL-7087706',
    upc: gs1Upc12('76868620927'),
    basePrice: '149.99',
    unitCost: '78.00',
    mapCents: 12499,
    mapPolicy: 'map',
    onHandQty: 8,
    reservedQty: 0,
    availability: 'in_stock',
    leadDays: 0,
    pickupOnly: false,
    imageAsset: 'fable-gear-agilis.png',
    description: 'Progressive layering dual-density EPS road helmet with integrated MIPS rotational impact protection, Float Fit Race retention, and 18 wind-tunnel vents.',
  },
  {
    sku: 'UBC-SKR-HYD-LEM',
    lsId: 'LS-204104',
    title: 'Skratch Labs Sport Hydration Drink Mix — Lemon Lime (440g)',
    vendor: 'Skratch Labs',
    category: 'Nutrition & Hydration',
    mpn: 'SKR-440-LL',
    upc: gs1Upc12('85569900302'),
    basePrice: '24.99',
    unitCost: '12.50',
    mapCents: null,
    mapPolicy: 'none',
    onHandQty: 24,
    reservedQty: 0,
    availability: 'in_stock',
    leadDays: 0,
    pickupOnly: false,
    imageAsset: 'supp-skratch-hydration.png',
    description: 'Electrolyte hydration mix made with real lemon & lime fruit for Florida heat rides. 20 servings per 440g resealable pouch.',
  },
  {
    sku: 'UBC-SUR-MS-54',
    lsId: 'LS-204105',
    title: 'Surly Midnight Special Frame — 54cm',
    vendor: 'Surly',
    category: 'Gravel Frames',
    mpn: 'MIDNIGHT-SP-54',
    upc: gs1Upc12('03600029145'),
    basePrice: '899.99',
    unitCost: '585.00',
    mapCents: 79999,
    mapPolicy: 'map',
    onHandQty: 0,
    reservedQty: 0,
    availability: 'special_order',
    leadDays: 4,
    pickupOnly: false,
    imageAsset: 'ubc-bike-diverge.png',
    description: '4130 CroMoly steel road-plus and gravel frameset with 44mm headtube, flat-mount disc mounts, thru-axles, and 650b x 60mm / 700c x 42mm clearance.',
  },
  {
    sku: 'UBC-SHM-R8170-GRP',
    lsId: 'LS-204106',
    title: 'Shimano Ultegra R8170 Di2 12-Speed Disc Groupset',
    vendor: 'Shimano',
    category: 'Drivetrain & Groupsets',
    mpn: 'IR8170GRP',
    upc: gs1Upc12('68922891742'),
    basePrice: '1799.99',
    unitCost: '1190.00',
    mapCents: 159999,
    mapPolicy: 'map',
    onHandQty: 0,
    reservedQty: 0,
    availability: 'special_order',
    leadDays: 3,
    pickupOnly: false,
    imageAsset: 'cat-sram-s200.png',
    description: 'Semi-wireless 2x12-speed Di2 electronic road groupset with Hyperglide+ shifting, hydraulic Servo Wave disc calipers, and 52/36T crankset.',
  },
  {
    sku: 'UBC-CON-GP5K-28',
    lsId: 'LS-204107',
    title: 'Continental Grand Prix 5000 700x28c Tire',
    vendor: 'Continental',
    category: 'Tires',
    mpn: 'GP5000-700X28',
    upc: gs1Upc12('76868647349'),
    basePrice: '79.99',
    unitCost: '44.50',
    mapCents: 7499,
    mapPolicy: 'map',
    onHandQty: 12,
    reservedQty: 2,
    availability: 'in_stock',
    leadDays: 0,
    pickupOnly: false,
    imageAsset: 'ubc-part-tires.png',
    description: 'Benchmark BlackChili compound road folding tire with VectranBreaker puncture protection and Lazer Grip cornering shoulder profile.',
  },
  {
    sku: 'UBC-PRK-PCS103',
    lsId: 'LS-204108',
    title: 'Park Tool PCS-10.3 Deluxe Home Mechanic Repair Stand',
    vendor: 'Park Tool',
    category: 'Tools & Workshop',
    mpn: 'PCS-10.3',
    upc: gs1Upc12('76347700595'),
    basePrice: '269.95',
    unitCost: '178.00',
    mapCents: 26995,
    mapPolicy: 'map',
    onHandQty: 0,
    reservedQty: 0,
    availability: 'special_order',
    leadDays: 4,
    pickupOnly: false,
    imageAsset: 'cat-kuat-mount.jpg',
    description: 'Cam-actuated micro-adjustable clamp workstand with teardrop steel tubing, integrated parts tray, and 80 lb capacity for road, MTB, and e-bikes.',
  },
  {
    sku: 'UBC-SPZ-PWR-143',
    lsId: 'LS-204109',
    title: 'Specialized Power Expert Saddle — 143mm',
    vendor: 'Specialized',
    category: 'Saddles & Cockpit',
    mpn: '27120-8503',
    upc: gs1Upc12('88881859102'),
    basePrice: '159.99',
    unitCost: '133.00', // ~16.9% gross margin -> showcases Low-Margin Warning in Item Search -> Margins & MAP!
    mapCents: 15999,
    mapPolicy: 'map',
    onHandQty: 4,
    reservedQty: 0,
    availability: 'in_stock',
    leadDays: 0,
    pickupOnly: false,
    imageAsset: 'spz-power-saddle.png',
    description: 'Body Geometry cutout performance saddle with hollow titanium rails and Level 2 medium-density PU padding for road and gravel riders.',
  },
  {
    sku: 'UBC-GRM-RS200',
    lsId: 'LS-204110',
    title: 'Garmin Rally RS200 Dual-Sensing Power Meter Pedals',
    vendor: 'Garmin',
    category: 'Electronics & Pedals',
    mpn: '010-02388-00',
    upc: gs1Upc12('75375925695'),
    basePrice: '1099.99',
    unitCost: '715.00',
    mapCents: 109999,
    mapPolicy: 'map',
    onHandQty: 0,
    reservedQty: 0,
    availability: 'unavailable',
    leadDays: 0,
    pickupOnly: false,
    imageAsset: 'spz-stix-light.png',
    description: 'Dual-sensing Shimano SPD-SL road power meter pedals measuring total power, cadence, left/right balance, and cycling dynamics.',
  },
];

async function stageUploadLocalImage(assetFilename) {
  const filePath = resolve(process.cwd(), 'apps/dawn-ubc-fable-theme/assets', assetFilename);
  const buf = await readFile(filePath);
  const ext = extname(assetFilename).toLowerCase();
  const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';

  const STAGED_CREATE = `mutation StageImg($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets { url resourceUrl parameters { name value } }
      userErrors { field message }
    }
  }`;
  const res = await shopifyClient.mutate(STAGED_CREATE, {
    input: [{
      filename: basename(assetFilename),
      mimeType,
      httpMethod: 'POST',
      resource: 'PRODUCT_IMAGE',
      fileSize: String(buf.length),
    }],
  });
  const target = res.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target) {
    throw new Error(`stagedUploadsCreate failed: ${JSON.stringify(res.stagedUploadsCreate?.userErrors)}`);
  }
  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  form.append('file', new Blob([buf], { type: mimeType }), basename(assetFilename));
  const up = await fetch(target.url, { method: 'POST', body: form });
  if (!up.ok && up.status !== 201 && up.status !== 204) {
    throw new Error(`Staged image POST failed (${up.status}) for ${assetFilename}`);
  }
  return target.resourceUrl;
}

function toCatalogRecord(norm) {
  return {
    supplierSku: norm.supplierSku,
    brand: norm.brand,
    title: norm.title,
    mpn: norm.mpn,
    upc: norm.upc,
    category: norm.category ?? undefined,
    costCents: norm.costCents ?? 0,
    msrpCents: norm.msrpCents,
    mapCents: norm.mapCents,
    qtyAvailable: norm.qtyAvailable,
    dropShip: norm.dropShip,
    leadDays: norm.leadDays,
    contentLicensed: norm.contentLicensed,
  };
}

try {
  console.log('=== Curating UBC Commerce Hub & Shopify Sandbox for Carlos ===\n');
  const compRes = await pool.query(`SELECT id, slug, name FROM companies WHERE slug = 'twoit-sandbox'`);
  if (!compRes.rowCount) throw new Error('Tenant twoit-sandbox not found!');
  const companyId = compRes.rows[0].id;
  console.log(`Target tenant verified: ${compRes.rows[0].slug} (${companyId})`);

  // Ensure company display name is clean for Carlos
  await pool.query(
    `UPDATE companies SET name = 'University Bicycle Center (Sandbox)' WHERE id = $1`,
    [companyId],
  );
  await pool.query(
    `UPDATE locations SET name = 'UBC Tampa Showroom' WHERE company_id = $1 AND kind = 'physical'`,
    [companyId],
  );

  // 1. Archive default Shopify template products (Snowboards, Ski Wax, Gift Card) cleanly
  console.log('\n1/6 Archiving default Shopify template items (Snowboards / Ski Wax / Gift Card)...');
  await shopifyApi.ensureUbcMetafieldDefinitions();
  const existingProds = await shopifyClient.query(`{
    products(first: 100) {
      nodes {
        id title status
        featuredMedia { id }
        variants(first: 20) { nodes { id sku inventoryItem { id } } }
      }
    }
  }`);

  const curatedSkuSet = new Set(CURATED_CATALOG.map((c) => c.sku));
  let archivedCount = 0;
  for (const p of existingProds.products.nodes) {
    const hasCuratedSku = p.variants.nodes.some((v) => v.sku && curatedSkuSet.has(v.sku));
    if (!hasCuratedSku && p.status !== 'ARCHIVED') {
      await shopifyClient.mutate(
        `mutation ArchiveTemplateProd($product: ProductUpdateInput!) {
          productUpdate(product: $product) { userErrors { field message } }
        }`,
        { product: { id: p.id, status: 'ARCHIVED' } },
      );
      archivedCount++;
    }
  }
  console.log(`    Archived ${archivedCount} non-cycling Shopify template products.`);

  // 2. Upsert all 10 curated UBC cycling products in Shopify WITH product images, base prices, costs & inventory
  console.log('\n2/6 Syncing 10 authentic UBC cycling products + images + inventory on Shopify...');
  const bySkuProd = new Map();
  for (const p of existingProds.products.nodes) {
    for (const v of p.variants.nodes) {
      if (v.sku && curatedSkuSet.has(v.sku)) {
        bySkuProd.set(v.sku, { product: p, variant: v });
      }
    }
  }

  const PRODUCT_SET = `mutation UpsertBikeProduct($input: ProductSetInput!) {
    productSet(synchronous: true, input: $input) {
      product {
        id title
        featuredMedia { id }
        variants(first: 1) { nodes { id sku inventoryItem { id } } }
      }
      userErrors { field message }
    }
  }`;

  const upsertedBySku = new Map();
  for (const item of CURATED_CATALOG) {
    const existing = bySkuProd.get(item.sku);
    const needsImage = !existing?.product?.featuredMedia;
    let resourceUrl = null;
    if (needsImage) {
      resourceUrl = await stageUploadLocalImage(item.imageAsset);
    }

    const input = {
      ...(existing ? { id: existing.product.id } : {}),
      title: item.title,
      descriptionHtml: `<p>${item.description}</p>`,
      vendor: item.vendor,
      productType: item.category,
      status: 'ACTIVE',
      productOptions: [{ name: 'Title', values: [{ name: 'Default Title' }] }],
      variants: [
        {
          ...(existing ? { id: existing.variant.id } : {}),
          optionValues: [{ optionName: 'Title', name: 'Default Title' }],
          sku: item.sku,
          barcode: item.upc,
          price: item.basePrice,
          compareAtPrice: null,
          inventoryPolicy: item.availability === 'special_order' ? 'CONTINUE' : 'DENY',
        },
      ],
      ...(resourceUrl
        ? { files: [{ originalSource: resourceUrl, contentType: 'IMAGE', alt: item.title }] }
        : {}),
    };

    const res = await shopifyClient.mutate(PRODUCT_SET, { input });
    const errs = res.productSet?.userErrors || [];
    if (errs.length) {
      throw new Error(`productSet error on ${item.sku}: ${errs.map((e) => e.message).join('; ')}`);
    }
    const prod = res.productSet.product;
    const vNode = prod.variants.nodes[0];
    upsertedBySku.set(item.sku, {
      productId: prod.id,
      variantId: vNode.id,
      inventoryItemId: vNode.inventoryItem.id,
    });

    await shopifyApi.setVariantFulfillmentMetafields([
      {
        variantId: vNode.id,
        availability: item.availability,
        leadTimeDays: item.leadDays || null,
        clickAndCollectOnly: item.pickupOnly,
      },
    ]);
    console.log(`    [synced] ${item.sku.padEnd(18)} | $${item.basePrice.padStart(7)} | ${item.availability.padEnd(13)} | ${item.title}`);
  }

  // Update unit costs + physical inventory on Shopify
  let shopifyLocationId = (process.env.SHOPIFY_PHYSICAL_LOCATION_ID || '').trim();
  if (!shopifyLocationId) {
    const locs = await shopifyApi.listLocations();
    shopifyLocationId = locs.find((l) => l.isActive)?.id || '';
  }

  const qtyUpdates = [];
  for (const item of CURATED_CATALOG) {
    const info = upsertedBySku.get(item.sku);
    await shopifyClient.mutate(
      `mutation($id: ID!, $input: InventoryItemInput!) {
        inventoryItemUpdate(id: $id, input: $input) { userErrors { message } }
      }`,
      { id: info.inventoryItemId, input: { tracked: true, cost: item.unitCost } },
    );
    if (shopifyLocationId) {
      await shopifyClient.mutate(
        `mutation($inventoryItemId: ID!, $locationId: ID!, $key: String!) {
          inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) @idempotent(key: $key) {
            userErrors { message }
          }
        }`,
        { inventoryItemId: info.inventoryItemId, locationId: shopifyLocationId, key: randomUUID() },
      );
      qtyUpdates.push({ inventoryItemId: info.inventoryItemId, quantity: item.onHandQty });
    }
  }
  if (shopifyLocationId && qtyUpdates.length) {
    await shopifyApi.setInventoryOnHand(shopifyLocationId, qtyUpdates);
    console.log(`    Updated Shopify physical stock for ${qtyUpdates.length} cycling SKUs at ${shopifyLocationId}`);
  }

  // Sync curated products into `bikes` and `frontpage` manual collections
  const allProductIds = CURATED_CATALOG.map((c) => upsertedBySku.get(c.sku).productId);
  for (const handle of ['bikes', 'frontpage']) {
    const colRes = await shopifyClient.query(`query($h: String!) { collectionByHandle(handle: $h) { id } }`, { h: handle });
    let colId = colRes.collectionByHandle?.id;
    if (!colId && handle === 'bikes') {
      const createdCol = await shopifyClient.mutate(
        `mutation($input: CollectionInput!) {
          collectionCreate(input: $input) { collection { id } userErrors { message } }
        }`,
        { input: { title: 'Bikes & Gear', handle: 'bikes', products: allProductIds } },
      );
      colId = createdCol.collectionCreate?.collection?.id;
    } else if (colId) {
      await shopifyClient.mutate(
        `mutation($id: ID!, $productIds: [ID!]!) {
          collectionAddProducts(id: $id, productIds: $productIds) { userErrors { message } }
        }`,
        { id: colId, productIds: allProductIds },
      );
    }
  }

  // 3. Clean `twoit-sandbox` operational & template rows (strictly scoped to companyId!)
  console.log('\n3/6 Resetting stale sandbox test artifacts in `twoit-sandbox` & pulling clean Shopify catalog...');
  await pool.query(`DELETE FROM purchase_orders WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM orders WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM campaigns WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM price_history WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM outbound_sync_staging WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM match_reviews WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM supplier_offer_history WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM supplier_offers WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM supplier_sync_runs WHERE company_id = $1`, [companyId]);
  // Remove non-UBC template variants/products in `twoit-sandbox` so archived Snowboards never clutter Item Search
  const nonUbcProds = await pool.query(
    `SELECT p.id FROM products p
     WHERE p.company_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM variants v WHERE v.product_id = p.id AND v.company_id = $1 AND v.sku = ANY($2::text[])
       )`,
    [companyId, [...curatedSkuSet]],
  );
  if (nonUbcProds.rowCount) {
    const delIds = nonUbcProds.rows.map((r) => r.id);
    await pool.query(`DELETE FROM external_ids WHERE company_id = $1 AND entity_type = 'product' AND entity_id = ANY($2::uuid[])`, [companyId, delIds]);
    await pool.query(
      `DELETE FROM external_ids WHERE company_id = $1 AND entity_type = 'variant'
       AND entity_id IN (SELECT id FROM variants WHERE company_id = $1 AND product_id = ANY($2::uuid[]))`,
      [companyId, delIds],
    );
    await pool.query(`DELETE FROM products WHERE company_id = $1 AND id = ANY($2::uuid[])`, [companyId, delIds]);
  }

  // Point store & physical location in `twoit-sandbox` to the active Shopify store & clear stale Shopify GID mappings
  await pool.query(
    `UPDATE stores SET name = 'University Bicycle Center Online', shopify_shop_domain = $2 WHERE company_id = $1`,
    [companyId, shopDomain],
  );
  if (shopifyLocationId) {
    await pool.query(
      `UPDATE locations SET shopify_location_id = $2 WHERE company_id = $1 AND kind = 'physical'`,
      [companyId, shopifyLocationId],
    );
  }
  await pool.query(`DELETE FROM external_ids WHERE company_id = $1 AND system = 'shopify'`, [companyId]);

  const syncSummary = await syncFromShopifyJob(ctx, companyId);
  console.log('    Shopify -> Hub sync summary:', JSON.stringify(syncSummary));

  // Enrich the 10 synced variants with MPN, MAP, Lightspeed R-Series Item IDs & reserved qty
  const locRow = await pool.query(`SELECT id FROM locations WHERE company_id = $1 AND kind = 'physical' LIMIT 1`, [companyId]);
  const hubLocationId = locRow.rows[0].id;
  const storeRow = await pool.query(`SELECT id FROM stores WHERE company_id = $1 LIMIT 1`, [companyId]);
  const hubStoreId = storeRow.rows[0].id;

  const variantIdBySku = new Map();
  for (const item of CURATED_CATALOG) {
    const vRes = await pool.query(`SELECT id, product_id FROM variants WHERE company_id = $1 AND sku = $2`, [companyId, item.sku]);
    const vRow = vRes.rows[0];
    variantIdBySku.set(item.sku, vRow.id);

    await pool.query(
      `UPDATE products SET brand = $2, category = $3, title = $4, description = $5, map_policy = $6, status = 'published', updated_at = now()
       WHERE id = $1 AND company_id = $7`,
      [vRow.product_id, item.vendor, item.category, item.title, item.description, item.mapPolicy, companyId],
    );
    await pool.query(
      `UPDATE variants SET title = $2, upc = $3, mpn = $4, map_cents = $5, cost_cents = $6, status = 'published', updated_at = now()
       WHERE id = $1 AND company_id = $7`,
      [vRow.id, item.title, item.upc, item.mpn, item.mapCents, Math.round(Number(item.unitCost) * 100), companyId],
    );
    await pool.query(
      `INSERT INTO inventory_levels (variant_id, location_id, company_id, on_hand, reserved, source)
       VALUES ($1, $2, $3, $4, $5, 'lightspeed_r')
       ON CONFLICT (variant_id, location_id) DO UPDATE SET on_hand = EXCLUDED.on_hand, reserved = EXCLUDED.reserved, source = 'lightspeed_r', updated_at = now()`,
      [vRow.id, hubLocationId, companyId, item.onHandQty, item.reservedQty],
    );
    await pool.query(
      `INSERT INTO external_ids (company_id, entity_type, entity_id, system, external_id)
       VALUES ($1, 'variant', $2, 'lightspeed_r', $3)
       ON CONFLICT (company_id, system, entity_type, entity_id) DO UPDATE SET external_id = EXCLUDED.external_id`,
      [companyId, vRow.id, item.lsId],
    );
  }

  // 4. Import fresh Vendor Catalogs (QBP, JBI, SPECIALIZED) + Cost Hike Versioning + MAP Quarantine + Match Reviews
  console.log('\n4/6 Importing fresh Vendor Catalogs (QBP, JBI, Specialized), MAP Quarantine & Matching queue...');
  const surlyItem = CURATED_CATALOG.find((x) => x.sku === 'UBC-SUR-MS-54');
  const bellItem = CURATED_CATALOG.find((x) => x.sku === 'UBC-BEL-Z20-M');
  const skrItem = CURATED_CATALOG.find((x) => x.sku === 'UBC-SKR-HYD-LEM');
  const shmItem = CURATED_CATALOG.find((x) => x.sku === 'UBC-SHM-R8170-GRP');
  const grmItem = CURATED_CATALOG.find((x) => x.sku === 'UBC-GRM-RS200');
  const contiItem = CURATED_CATALOG.find((x) => x.sku === 'UBC-CON-GP5K-28');
  const prkItem = CURATED_CATALOG.find((x) => x.sku === 'UBC-PRK-PCS103');
  const sl7Item = CURATED_CATALOG.find((x) => x.sku === 'UBC-SPZ-SL7-56');
  const vadoItem = CURATED_CATALOG.find((x) => x.sku === 'UBC-SPZ-VADO-L');

  // Initial QBP feed (with Surly at $560.00 first so the follow-up $585.00 update records a clean cost-hike version!)
  const qbpInitial = [
    normalizeSupplierPayload('QBP', {
      item_number: 'QBP-FM4500', brand_name: 'Surly', item_description: surlyItem.title,
      manufacturer_part_number: surlyItem.mpn, upc: surlyItem.upc,
      dealer_cost: '560.00', map_price: '799.99', msrp: '899.99', qty_available: 9, dropship: 'true', lead_days: 4,
    }),
    normalizeSupplierPayload('QBP', {
      item_number: 'QBP-DR8170', brand_name: 'Shimano', item_description: shmItem.title,
      manufacturer_part_number: shmItem.mpn, upc: shmItem.upc,
      dealer_cost: '1190.00', map_price: '1599.99', msrp: '1799.99', qty_available: 6, dropship: 'false', lead_days: 3,
    }),
    normalizeSupplierPayload('QBP', {
      item_number: 'QBP-HE8821', brand_name: 'Bell', item_description: bellItem.title,
      manufacturer_part_number: bellItem.mpn, upc: bellItem.upc,
      dealer_cost: '78.00', map_price: '124.99', msrp: '149.99', qty_available: 18, dropship: 'true', lead_days: 3,
    }),
    normalizeSupplierPayload('QBP', {
      item_number: 'QBP-NU1104', brand_name: 'Skratch Labs', item_description: skrItem.title,
      manufacturer_part_number: skrItem.mpn, upc: skrItem.upc,
      dealer_cost: '12.50', msrp: '24.99', qty_available: 60, dropship: 'false', lead_days: 2,
    }),
    normalizeSupplierPayload('QBP', {
      item_number: 'QBP-PD9200', brand_name: 'Garmin', item_description: grmItem.title,
      manufacturer_part_number: grmItem.mpn, upc: grmItem.upc,
      dealer_cost: '715.00', map_price: '1099.99', msrp: '1099.99', qty_available: 0, dropship: 'false', lead_days: 5,
    }),
    // Dubious record (no barcode, matches Bell MPN) -> goes to match_reviews!
    normalizeSupplierPayload('QBP', {
      item_number: 'QBP-HE8821-ALT', brand_name: 'Bell', item_description: 'Bell Z20 MIPS Aero Road Helmet Med (Matte Slate)',
      manufacturer_part_number: bellItem.mpn, upc: '',
      dealer_cost: '79.50', map_price: '124.99', msrp: '149.99', qty_available: 7, lead_days: 3,
    }),
  ].filter(Boolean).map(toCatalogRecord);
  await importSupplierRecords(ctx, companyId, 'QBP', qbpInitial, 'full_catalog');

  // Follow-up QBP `costs` stream raising Surly frame from $560.00 -> $585.00
  const qbpCostHike = [
    normalizeSupplierPayload('QBP', {
      item_number: 'QBP-FM4500', brand_name: 'Surly', item_description: surlyItem.title,
      manufacturer_part_number: surlyItem.mpn, upc: surlyItem.upc,
      dealer_cost: '585.00', map_price: '799.99', msrp: '899.99', qty_available: 9, dropship: 'true', lead_days: 4,
    }),
  ].filter(Boolean).map(toCatalogRecord);
  await importSupplierRecords(ctx, companyId, 'QBP', qbpCostHike, 'costs');

  // JBI feed — includes second vendor offer for Shimano Ultegra ($1,215 vs QBP $1,190), Park Tool PCS-10.3,
  // AND Continental GP5000 with MAP $84.99 (> published $79.99) -> triggers MAP Quarantine (`held`)!
  const jbiFeed = [
    normalizeSupplierPayload('JBI', {
      sku: 'JBI-TL4103', mfg: 'Park Tool', desc: prkItem.title,
      mfg_part_no: prkItem.mpn, gtin: prkItem.upc,
      dealer_cost: '178.00', map: '269.95', msrp: '269.95', qoh: 14, lead_time_days: 4,
    }),
    normalizeSupplierPayload('JBI', {
      sku: 'JBI-98170', mfg: 'Shimano', desc: shmItem.title,
      mfg_part_no: shmItem.mpn, gtin: shmItem.upc,
      dealer_cost: '1215.00', map: '1599.99', msrp: '1799.99', qoh: 4, lead_time_days: 4,
    }),
    normalizeSupplierPayload('JBI', {
      sku: 'JBI-61028', mfg: 'Continental', desc: contiItem.title,
      mfg_part_no: contiItem.mpn, gtin: contiItem.upc,
      dealer_cost: '44.50', map: '84.99', msrp: '89.99', qoh: 28, lead_time_days: 3,
    }),
  ].filter(Boolean).map(toCatalogRecord);
  await importSupplierRecords(ctx, companyId, 'JBI', jbiFeed, 'full_catalog');
  // Keep Continental's canonical variant MAP at $74.99 while JBI's new $84.99 MAP sits safely held in quarantine!
  await pool.query(`UPDATE variants SET map_cents = 7499 WHERE id = $1`, [variantIdBySku.get('UBC-CON-GP5K-28')]);

  // Specialized feed — Tarmac SL7 + Turbo Vado 4.0 + 1 dubious MPN-only colorway for match_reviews
  const specFeed = [
    ...([
      normalizeSupplierPayload('SPECIALIZED', {
        partNumber: 'SPEC-94424-56', brand: 'Specialized', productName: sl7Item.title,
        mpn: sl7Item.mpn, ean: sl7Item.upc, category: 'Road Bikes',
        dealerPrice: '1820.00', mapPrice: '2799.99', retailPrice: '2799.99', inventory: 4, leadDays: 5,
      }),
      normalizeSupplierPayload('SPECIALIZED', {
        partNumber: 'SPEC-95224-5004', brand: 'Specialized', productName: vadoItem.title,
        mpn: vadoItem.mpn, ean: vadoItem.upc, category: 'Electric Bikes',
        dealerPrice: '2150.00', mapPrice: '3249.99', retailPrice: '3249.99', inventory: 5, leadDays: 5,
      }),
    ].filter(Boolean).map(toCatalogRecord)),
    {
      supplierSku: 'SPEC-UNVERIFIED-56',
      brand: 'Specialized',
      title: 'Tarmac SL7 Sport 56cm — Gloss Carbon/Metallic Frame Listing',
      mpn: sl7Item.mpn,
      upc: null,
      category: 'Road Bikes',
      costCents: 179500,
      msrpCents: 279999,
      mapCents: 279999,
      qtyAvailable: 2,
      dropShip: false,
      leadDays: 6,
      contentLicensed: false,
    },
  ];
  await importSupplierRecords(ctx, companyId, 'SPECIALIZED', specFeed, 'full_catalog');

  // Keep only 1 clean `held` (Continental MAP violation) and 1 clean `ready` (Shimano Ultegra) in outbound_sync_staging
  // so `#/pipeline` is super clear and easy for Carlos to read at a glance!
  await pool.query(
    `DELETE FROM outbound_sync_staging
     WHERE company_id = $1
       AND variant_id NOT IN ($2, $3)`,
    [companyId, variantIdBySku.get('UBC-CON-GP5K-28'), variantIdBySku.get('UBC-SHM-R8170-GRP')],
  );

  // 5. Curate 4 realistic Customer Orders & 2 Linked B2B Purchase Orders
  console.log('\n5/6 Creating 4 realistic Customer Orders & 2 B2B Purchase Orders (`#UBC-1041`..`#UBC-1044`)...');
  const supRows = await pool.query(`SELECT id, code FROM suppliers WHERE company_id = $1`, [companyId]);
  const supByCode = new Map(supRows.rows.map((s) => [s.code, s.id]));

  const ownerRes = await pool.query(
    `SELECT u.id FROM users u JOIN memberships m ON m.user_id = u.id
     WHERE m.company_id = $1 ORDER BY (lower(u.email) LIKE 'ubcbike%') DESC, (m.role = 'owner') DESC LIMIT 1`,
    [companyId],
  );
  const operatorUserId = ownerRes.rows[0].id;

  // Order #UBC-1044: Special Order Awaiting Carlos's B2B Approval (`To Order in B2B`)
  const o1044 = (await pool.query(
    `INSERT INTO orders (company_id, store_id, shopify_order_id, number, customer_name, fulfillment_method, financial_status, shopify_fulfillment_status, internal_status, is_special_order, total_cents, created_at)
     VALUES ($1, $2, 'ubc-sandbox-1044', '#UBC-1044', 'Marcus Vance', 'pickup', 'paid', 'unfulfilled', 'awaiting_approval', true, 179999, now() - interval '35 minutes')
     RETURNING id`,
    [companyId, hubStoreId],
  )).rows[0].id;
  const ol1044 = (await pool.query(
    `INSERT INTO order_lines (order_id, variant_id, sku, title, qty, price_cents, source, supplier_id, quoted_cost_cents)
     VALUES ($1, $2, 'UBC-SHM-R8170-GRP', $3, 1, 179999, 'supplier', $4, 119000) RETURNING id`,
    [o1044, variantIdBySku.get('UBC-SHM-R8170-GRP'), shmItem.title, supByCode.get('QBP')],
  )).rows[0].id;
  const po1044 = (await pool.query(
    `INSERT INTO purchase_orders (company_id, supplier_id, order_id, po_number, status, ship_to, total_cents, idempotency_key, created_at)
     VALUES ($1, $2, $3, 'PO-UBC-1044', 'awaiting_approval', 'ubc_store', 119000, 'po:ubc-1044:QBP', now() - interval '35 minutes') RETURNING id`,
    [companyId, supByCode.get('QBP'), o1044],
  )).rows[0].id;
  await pool.query(
    `INSERT INTO purchase_order_lines (purchase_order_id, order_line_id, supplier_sku, qty, expected_cost_cents)
     VALUES ($1, $2, 'QBP-DR8170', 1, 119000)`,
    [po1044, ol1044],
  );
  await pool.query(
    `INSERT INTO order_events (order_id, from_status, to_status, actor, note, created_at)
     VALUES
       ($1, NULL, 'new_order', 'shopify_webhook', 'Shopify order #UBC-1044 paid online (Pickup at UBC Tampa Showroom)', now() - interval '35 minutes'),
       ($1, 'new_order', 'awaiting_approval', 'hub_router', '0 in store; best vendor offer selected: QBP (QBP-DR8170 @ $1,190.00, 3 days). Queued for B2B approval.', now() - interval '34 minutes')`,
    [o1044],
  );

  // Order #UBC-1043: Special Order Already Ordered in B2B & In Transit (`Ordered & In Transit`)
  const o1043 = (await pool.query(
    `INSERT INTO orders (company_id, store_id, shopify_order_id, number, customer_name, fulfillment_method, financial_status, shopify_fulfillment_status, internal_status, is_special_order, total_cents, tracking, created_at)
     VALUES ($1, $2, 'ubc-sandbox-1043', '#UBC-1043', 'Elena Rostova', 'pickup', 'paid', 'unfulfilled', 'in_transit', true, 26995, '1Z999AA10123456784', now() - interval '2 days')
     RETURNING id`,
    [companyId, hubStoreId],
  )).rows[0].id;
  const ol1043 = (await pool.query(
    `INSERT INTO order_lines (order_id, variant_id, sku, title, qty, price_cents, source, supplier_id, quoted_cost_cents)
     VALUES ($1, $2, 'UBC-PRK-PCS103', $3, 1, 26995, 'supplier', $4, 17800) RETURNING id`,
    [o1043, variantIdBySku.get('UBC-PRK-PCS103'), prkItem.title, supByCode.get('JBI')],
  )).rows[0].id;
  const po1043 = (await pool.query(
    `INSERT INTO purchase_orders (company_id, supplier_id, order_id, po_number, status, ship_to, total_cents, idempotency_key, external_ref, tracking, approved_by, approved_at, submitted_at, created_at)
     VALUES ($1, $2, $3, 'PO-UBC-1043', 'in_transit', 'ubc_store', 17800, 'po:ubc-1043:JBI', 'JBI-WEB-774920', '1Z999AA10123456784', $4, now() - interval '46 hours', now() - interval '45 hours', now() - interval '2 days') RETURNING id`,
    [companyId, supByCode.get('JBI'), o1043, operatorUserId],
  )).rows[0].id;
  await pool.query(
    `INSERT INTO purchase_order_lines (purchase_order_id, order_line_id, supplier_sku, qty, expected_cost_cents)
     VALUES ($1, $2, 'JBI-TL4103', 1, 17800)`,
    [po1043, ol1043],
  );
  await pool.query(
    `INSERT INTO order_events (order_id, from_status, to_status, actor, note, created_at)
     VALUES
       ($1, NULL, 'awaiting_approval', 'shopify_webhook', 'Special order queued for JBI (JBI-TL4103)', now() - interval '2 days'),
       ($1, 'awaiting_approval', 'po_submitted', 'Carlos Mirabal', 'Ordered on JBI B2B portal — Ref JBI-WEB-774920', now() - interval '45 hours'),
       ($1, 'po_submitted', 'in_transit', 'Carlos Mirabal', 'Shipped from JBI Miami warehouse — UPS 1Z999AA10123456784', now() - interval '20 hours')`,
    [o1043],
  );

  // Order #UBC-1042: In-Store Stock Pickup Order (`ready_for_pickup`)
  const o1042 = (await pool.query(
    `INSERT INTO orders (company_id, store_id, shopify_order_id, number, customer_name, fulfillment_method, financial_status, shopify_fulfillment_status, internal_status, is_special_order, total_cents, created_at)
     VALUES ($1, $2, 'ubc-sandbox-1042', '#UBC-1042', 'Daniel Morales', 'pickup', 'paid', 'unfulfilled', 'ready_for_pickup', false, 15998, now() - interval '4 hours')
     RETURNING id`,
    [companyId, hubStoreId],
  )).rows[0].id;
  await pool.query(
    `INSERT INTO order_lines (order_id, variant_id, sku, title, qty, price_cents, source, quoted_cost_cents)
     VALUES ($1, $2, 'UBC-CON-GP5K-28', $3, 2, 7999, 'ubc_stock', 4450)`,
    [o1042, variantIdBySku.get('UBC-CON-GP5K-28'), contiItem.title],
  );
  await pool.query(
    `INSERT INTO order_events (order_id, from_status, to_status, actor, note, created_at)
     VALUES
       ($1, NULL, 'allocated_local_stock', 'hub_router', '2 units reserved from UBC Tampa Showroom floor stock', now() - interval '4 hours'),
       ($1, 'allocated_local_stock', 'ready_for_pickup', 'UBC Counter', 'Pulled and tagged at pickup counter for Daniel Morales', now() - interval '3 hours')`,
    [o1042],
  );

  // Order #UBC-1041: Completed Order (`completed`)
  const o1041 = (await pool.query(
    `INSERT INTO orders (company_id, store_id, shopify_order_id, number, customer_name, fulfillment_method, financial_status, shopify_fulfillment_status, internal_status, is_special_order, total_cents, created_at)
     VALUES ($1, $2, 'ubc-sandbox-1041', '#UBC-1041', 'Hannah Sterling', 'pickup', 'paid', 'fulfilled', 'completed', false, 14798, now() - interval '3 days')
     RETURNING id`,
    [companyId, hubStoreId],
  )).rows[0].id;
  await pool.query(
    `INSERT INTO order_lines (order_id, variant_id, sku, title, qty, price_cents, source, quoted_cost_cents)
     VALUES
       ($1, $2, 'UBC-BEL-Z20-M', $3, 1, 12699, 'ubc_stock', 7800),
       ($1, $4, 'UBC-SKR-HYD-LEM', $5, 1, 2099, 'ubc_stock', 1250)`,
    [o1041, variantIdBySku.get('UBC-BEL-Z20-M'), bellItem.title, variantIdBySku.get('UBC-SKR-HYD-LEM'), skrItem.title],
  );
  await pool.query(
    `INSERT INTO order_events (order_id, from_status, to_status, actor, note, created_at)
     VALUES
       ($1, NULL, 'ready_for_pickup', 'hub_router', 'In-store items pulled from Tampa floor stock', now() - interval '3 days'),
       ($1, 'ready_for_pickup', 'completed', 'UBC Counter', 'Picked up in store by customer', now() - interval '2 days')`,
    [o1041],
  );

  // 6. Create & Apply 1 Live Active Promotion + Create 1 Draft Storewide Event Preview
  console.log('\n6/6 Creating 1 Active Online Promo (live on Shopify) + 1 Draft Black Friday Preview...');
  const activePromo = await createCampaign(ctx, companyId, operatorUserId, {
    name: 'Helmet, Tire & Hydration Promo — 15% Off Online',
    channel: 'online',
    selection: { categories: ['Helmets', 'Nutrition & Hydration', 'Tires'] },
    adjustment: { type: 'percent_off', value: 0.15, rounding: 'charm_99' },
    rules: { minMarginPct: 0.20, warnMarginPct: 0.25, clampToMinMargin: false, excludeWithoutCost: true },
  });
  console.log('    Created Promo #1:', JSON.stringify(activePromo.summary));
  const approval = await approveCampaign(ctx, companyId, operatorUserId, activePromo.id, activePromo.previewToken);
  if (approval.jobId) {
    // Claim and execute immediately if the remote worker hasn't already picked it up
    const checkCamp = await pool.query(`SELECT status FROM campaigns WHERE id = $1`, [activePromo.id]);
    if (checkCamp.rows[0]?.status !== 'active') {
      await applyCampaignJob(ctx, companyId, activePromo.id, approval.jobId);
      await pool.query(`UPDATE jobs SET status = 'succeeded', finished_at = now() WHERE id = $1 AND status = 'queued'`, [approval.jobId]);
    }
  }
  console.log('    Promo #1 is now ACTIVE on Shopify & Hub (Bell + Skratch discounted; Continental blocked by MAP `$74.99` vs `$67.99`!).');

  // Create Promo #2 AFTER Promo #1 applied so its previewToken matches current catalog prices!
  const draftBf = await createCampaign(ctx, companyId, operatorUserId, {
    name: 'Black Friday Storewide Preview — 10% Off (.99)',
    channel: 'online_and_pos',
    posEventType: 'black_friday',
    selection: {},
    adjustment: { type: 'percent_off', value: 0.10, rounding: 'charm_99' },
    rules: { minMarginPct: 0.20, warnMarginPct: 0.25, clampToMinMargin: false, excludeWithoutCost: true },
  });
  console.log('    Created Promo #2 (Draft ready for Carlos):', JSON.stringify(draftBf.summary));

  // Ensure all schedules are healthy and resolve any stale simulated watchdog errors
  await pool.query(
    `UPDATE supplier_sync_schedules SET last_status = 'succeeded', last_success_at = now(), last_run_at = now(), updated_at = now() WHERE company_id = $1`,
    [companyId],
  );
  await pool.query(
    `UPDATE error_log SET resolved_at = now() WHERE company_id = $1 AND resolved_at IS NULL`,
    [companyId],
  );

  console.log('\n=== Curation Complete! ===');
} finally {
  await pool.end();
}
