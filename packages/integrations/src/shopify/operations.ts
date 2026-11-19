/**
 * Shopify Admin GraphQL operations used by the Intermediary Engine (40K+ SKU Scale Ready).
 * Supports:
 *  - Read-only catalog, cost, price, inventory & location bootstrap from Shopify.
 *  - Full product/variant creation & sync (`upsertProduct` via `productSet` in API 2026-10)
 *    with multi-option Size/Color variants, barcodes, images, unit costs & location activation.
 *  - Chunked automatic discounts (safe beyond Shopify's 250-GID per-mutation limit).
 *  - Automated rule-based Smart Collections (`ensureSmartCollections`) so 30k–40k items
 *    sort automatically into storefront categories (`electric-bikes`, `road-bikes`, `helmets`, etc.).
 *  - Clean outbound sync of prices, product statuses, on-hand inventory, and `ubc.*` metafields.
 */
import { randomUUID } from 'node:crypto';
import type { ShopifyAdminClient } from './client.js';

export interface VariantFulfillmentMetafieldUpdate {
  variantId: string;
  availability: 'in_stock' | 'special_order' | 'unavailable';
  leadTimeDays: number | null;
  /** Read by Shopify Plus Delivery Customization Function (e.g. Specialized complete bikes -> pickup only). */
  clickAndCollectOnly?: boolean;
}

export interface ShopifyLocationRecord {
  id: string;
  name: string;
  isActive: boolean;
}

export interface ShopifyVariantRecord {
  variantId: string;
  productId: string;
  inventoryItemId: string | null;
  sku: string | null;
  barcode: string | null;
  priceCents: number;
  compareAtCents: number | null;
  unitCostCents: number | null;
  inventoryQuantity: number;
  inventoryPolicy: 'DENY' | 'CONTINUE';
  title: string;
  productTitle: string;
  productStatus: 'ACTIVE' | 'DRAFT' | 'ARCHIVED';
  vendor: string;
  productType: string;
}

export interface ShopifyUpsertVariantInput {
  sku: string;
  barcode?: string | null;
  priceCents: number;
  compareAtCents?: number | null;
  costCents?: number | null;
  optionValues?: Record<string, string>;
  availability?: 'in_stock' | 'special_order' | 'unavailable';
  onHandQty?: number;
}

export interface ShopifyUpsertProductInput {
  existingProductId?: string | null;
  title: string;
  vendor: string;
  productType: string;
  descriptionHtml?: string;
  status: 'ACTIVE' | 'DRAFT';
  tags?: string[];
  imageUrls?: string[];
  locationId?: string | null;
  variants: ShopifyUpsertVariantInput[];
}

export interface ShopifyUpsertedProductResult {
  productId: string;
  variants: { sku: string; variantId: string; inventoryItemId: string | null }[];
}

export interface ShopifyAdminPort {
  listLocations(): Promise<ShopifyLocationRecord[]>;
  listVariants(cursor: string | null): Promise<{ variants: ShopifyVariantRecord[]; nextCursor: string | null }>;
  upsertProduct(input: ShopifyUpsertProductInput): Promise<ShopifyUpsertedProductResult>;
  updateVariantPrices(productId: string, updates: { variantId: string; priceCents: number; compareAtCents: number | null }[]): Promise<void>;
  /**
   * Explicit, human-initiated creation of ONE draft product whose variants are Lightspeed items
   * (e.g. the 4 colors of a bike). Allowed even when the catalog belongs to Workstand (update_only),
   * unlike the automatic `upsertProduct`.
   */
  createDraftProductFromItems(input: ShopifyUpsertProductInput): Promise<ShopifyUpsertedProductResult>;
  /** Vendor, tags and lowest variant price of products by GID (read-only, 250 per call). */
  getProductsTagInfo(productIds: string[]): Promise<{ id: string; vendor: string; tags: string[]; minPriceCents: number }[]>;
  /** IDs of every product carrying a tag (read-only). */
  listProductIdsByTag(tag: string): Promise<string[]>;
  /** Add / remove tags on one product (only the given tags are touched). */
  updateProductTags(productId: string, add: string[], remove: string[]): Promise<void>;
  /** Read every variant of the store with a Shopify bulk query (read-only; streamed, low memory). */
  bulkReadVariants(onRow: (v: StoreVariantRow) => void): Promise<number>;
  /** Start stocking an inventory item at a location (needed before its quantity can be set there). */
  activateInventoryAtLocation(inventoryItemId: string, locationId: string): Promise<void>;
  /** Current on-hand quantity per location of inventory items (read-only): itemId → { locationId → qty }. */
  getInventoryOnHand(inventoryItemIds: string[]): Promise<Map<string, Record<string, number>>>;
  /** Current price / compare-at of up to 250 variants by GID (read-only). Missing variants are omitted. */
  getVariantPrices(variantIds: string[]): Promise<{ variantId: string; priceCents: number; compareAtCents: number | null }[]>;
  createAutomaticDiscount(input: { title: string; percentOff?: number; amountOffCents?: number; productIds: string[]; variantIds?: string[]; startsAt: string; endsAt: string | null }): Promise<string>;
  deactivateAutomaticDiscount(discountId: string): Promise<void>;
  setProductsStatus(productIds: string[], status: 'ACTIVE' | 'DRAFT'): Promise<void>;
  setVariantFulfillmentMetafields(updates: VariantFulfillmentMetafieldUpdate[]): Promise<void>;
  setInventoryOnHand(locationId: string, quantities: { inventoryItemId: string; quantity: number }[]): Promise<void>;
  ensureUbcMetafieldDefinitions(): Promise<{ created: string[]; existing: string[] }>;
  ensureSmartCollections(): Promise<{ created: string[]; existing: string[] }>;
  listActiveStockCollectionCoverage(): Promise<{
    id: string;
    title: string;
    vendor: string;
    productType: string;
    totalInventory: number;
    hasPhoto: boolean;
    tags: string[];
    collections: { handle: string; title: string }[];
  }[]>;
}

/** One store variant as read by `bulkReadVariants` (compare-at only when above price). */
export interface StoreVariantRow {
  variantId: string;
  productId: string;
  inventoryItemId: string | null;
  barcode: string | null;
  /** Shopify variant display name, e.g. "Jupiter Defiant E-Bike - Black". */
  title: string;
  /** Uploaded by the Workstand app (has the workstand.variant_uuid metafield) vs. created by hand in Shopify. */
  fromWorkstand: boolean;
  priceCents: number;
  compareAtCents: number | null;
}

const centsToStr = (c: number) => (c / 100).toFixed(2);
const strToCents = (s: string) => Math.round(Number(s) * 100);

export const LIST_LOCATIONS = /* GraphQL */ `
  query ListLocations {
    locations(first: 25, includeLegacy: false) {
      nodes { id name isActive }
    }
  }`;

export const LIST_VARIANTS = /* GraphQL */ `
  query ListVariants($cursor: String) {
    productVariants(first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        sku
        barcode
        price
        compareAtPrice
        displayName
        inventoryQuantity
        inventoryPolicy
        inventoryItem {
          id
          unitCost { amount }
        }
        product {
          id
          title
          status
          vendor
          productType
        }
      }
    }
  }`;

export const PRODUCT_SET = /* GraphQL */ `
  mutation UpsertProduct($input: ProductSetInput!, $identifier: ProductSetIdentifiers) {
    productSet(synchronous: true, input: $input, identifier: $identifier) {
      product {
        id
        variants(first: 100) {
          nodes {
            id
            sku
            inventoryItem { id }
          }
        }
      }
      userErrors { field message }
    }
  }`;

export const INVENTORY_ITEM_UPDATE = /* GraphQL */ `
  mutation UpdateInvItem($id: ID!, $input: InventoryItemInput!) {
    inventoryItemUpdate(id: $id, input: $input) {
      inventoryItem { id tracked }
      userErrors { field message }
    }
  }`;

export const INVENTORY_ACTIVATE = /* GraphQL */ `
  mutation ActivateInv($inventoryItemId: ID!, $locationId: ID!, $idempotencyKey: String!) {
    inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) @idempotent(key: $idempotencyKey) {
      inventoryLevel { id }
      userErrors { field message }
    }
  }`;

export const VARIANTS_BULK_UPDATE = /* GraphQL */ `
  mutation UpdatePrices($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      userErrors { field message }
    }
  }`;

export const DISCOUNT_AUTOMATIC_BASIC_CREATE = /* GraphQL */ `
  mutation CreateDiscount($automaticBasicDiscount: DiscountAutomaticBasicInput!) {
    discountAutomaticBasicCreate(automaticBasicDiscount: $automaticBasicDiscount) {
      automaticDiscountNode { id }
      userErrors { field message }
    }
  }`;

export const DISCOUNT_AUTOMATIC_BASIC_UPDATE = /* GraphQL */ `
  mutation UpdateDiscountProducts($id: ID!, $automaticBasicDiscount: DiscountAutomaticBasicInput!) {
    discountAutomaticBasicUpdate(id: $id, automaticBasicDiscount: $automaticBasicDiscount) {
      automaticDiscountNode { id }
      userErrors { field message }
    }
  }`;

export const DISCOUNT_AUTOMATIC_DEACTIVATE = /* GraphQL */ `
  mutation Deactivate($id: ID!) {
    discountAutomaticDeactivate(id: $id) { userErrors { field message } }
  }`;

export const PRODUCT_UPDATE_STATUS = /* GraphQL */ `
  mutation SetStatus($product: ProductUpdateInput!) {
    productUpdate(product: $product) { userErrors { field message } }
  }`;

export const METAFIELDS_SET = /* GraphQL */ `
  mutation SetFulfillmentMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors { field message }
    }
  }`;

export const INVENTORY_SET_QUANTITIES = /* GraphQL */ `
  mutation SetOnHandInventory($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
    inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
      userErrors { field message }
    }
  }`;

export const METAFIELD_DEFINITION_CREATE = /* GraphQL */ `
  mutation CreateUbcMetafieldDefinition($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id key }
      userErrors { code field message }
    }
  }`;

export const COLLECTION_BY_HANDLE = /* GraphQL */ `
  query FindCollection($handle: String!) {
    collectionByHandle(handle: $handle) { id handle }
  }`;

export const SMART_COLLECTION_CREATE = /* GraphQL */ `
  mutation CreateSmartCollection($input: CollectionInput!) {
    collectionCreate(input: $input) {
      collection { id handle }
      userErrors { field message }
    }
  }`;

const UBC_METAFIELD_DEFINITIONS = [
  {
    name: 'UBC Availability Status',
    namespace: 'ubc',
    key: 'availability',
    type: 'single_line_text_field',
    ownerType: 'PRODUCTVARIANT',
    description: 'Clean storefront availability computed by UBC Commerce Hub (in_stock | special_order | unavailable).',
  },
  {
    name: 'UBC Special Order Lead Time (Days)',
    namespace: 'ubc',
    key: 'lead_time_days',
    type: 'number_integer',
    ownerType: 'PRODUCTVARIANT',
    description: 'Estimated days until ready when fulfilled via distributor special order.',
  },
  {
    name: 'UBC In-Store Pickup Only',
    namespace: 'ubc',
    key: 'click_and_collect_only',
    type: 'boolean',
    ownerType: 'PRODUCTVARIANT',
    description: 'True when dealer terms require assembled in-store pickup at UBC (e.g. Specialized complete bikes).',
  },
] as const;

/** Automated rule-based Smart Collections so 30,000–40,000 items sort into storefront categories automatically. */
const UBC_SMART_COLLECTIONS = [
  {
    handle: 'electric-bikes',
    title: 'Electric Bikes & E-MTBs',
    rules: [
      { column: 'TYPE', relation: 'CONTAINS', condition: 'Electric' },
      { column: 'TITLE', relation: 'CONTAINS', condition: 'E-Bike' },
      { column: 'TITLE', relation: 'CONTAINS', condition: 'Turbo' },
    ],
  },
  {
    handle: 'road-bikes',
    title: 'Road & Gravel Bikes',
    rules: [
      { column: 'TYPE', relation: 'CONTAINS', condition: 'Road' },
      { column: 'TYPE', relation: 'CONTAINS', condition: 'Gravel' },
    ],
  },
  {
    handle: 'mountain-bikes',
    title: 'Mountain & Trail Bikes',
    rules: [
      { column: 'TYPE', relation: 'CONTAINS', condition: 'Mountain' },
      { column: 'TITLE', relation: 'CONTAINS', condition: 'MTB' },
    ],
  },
  {
    handle: 'hybrid-bikes',
    title: 'Hybrid, Fitness & Cruisers',
    rules: [
      { column: 'TYPE', relation: 'CONTAINS', condition: 'Hybrid' },
      { column: 'TYPE', relation: 'CONTAINS', condition: 'Comfort' },
    ],
  },
  {
    handle: 'helmets',
    title: 'Helmets & Rider Protection',
    rules: [
      { column: 'TYPE', relation: 'CONTAINS', condition: 'Helmet' },
      { column: 'TITLE', relation: 'CONTAINS', condition: 'Helmet' },
    ],
  },
  {
    handle: 'tires-tubes',
    title: 'Tires, Tubes & Tubeless',
    rules: [
      { column: 'TYPE', relation: 'CONTAINS', condition: 'Tire' },
      { column: 'TITLE', relation: 'CONTAINS', condition: 'Tire' },
    ],
  },
  {
    handle: 'hydration-nutrition',
    title: 'Hydration & Ride Nutrition',
    rules: [
      { column: 'TYPE', relation: 'CONTAINS', condition: 'Hydration' },
      { column: 'TYPE', relation: 'CONTAINS', condition: 'Nutrition' },
    ],
  },
  {
    handle: 'parts-components',
    title: 'Parts, Drivetrain & Workshop',
    rules: [
      { column: 'TYPE', relation: 'CONTAINS', condition: 'Parts' },
      { column: 'TYPE', relation: 'CONTAINS', condition: 'Components' },
      { column: 'TYPE', relation: 'CONTAINS', condition: 'Tools' },
    ],
  },
] as const;

function assertNoUserErrors(errs: { field?: string[] | null; message: string }[] | undefined) {
  if (errs && errs.length) throw new Error(`Shopify userErrors: ${errs.map((e) => e.message).join('; ')}`);
}

export class ShopifyAdminApi implements ShopifyAdminPort {
  constructor(private readonly client: ShopifyAdminClient) {}

  async listLocations(): Promise<ShopifyLocationRecord[]> {
    type R = { locations: { nodes: { id: string; name: string; isActive: boolean }[] } };
    const r = await this.client.query<R>(LIST_LOCATIONS);
    return r.locations.nodes;
  }

  async listVariants(cursor: string | null) {
    type Node = {
      id: string;
      sku: string | null;
      barcode: string | null;
      price: string;
      compareAtPrice?: string | null;
      displayName: string;
      inventoryQuantity?: number | null;
      inventoryPolicy?: 'DENY' | 'CONTINUE';
      inventoryItem?: { id: string; unitCost?: { amount: string } | null } | null;
      product: { id: string; title?: string; status?: 'ACTIVE' | 'DRAFT' | 'ARCHIVED'; vendor: string; productType: string };
    };
    type R = { productVariants: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: Node[] } };
    const r = await this.client.query<R>(LIST_VARIANTS, { cursor });
    return {
      variants: r.productVariants.nodes.map((n) => ({
        variantId: n.id,
        productId: n.product.id,
        inventoryItemId: n.inventoryItem?.id ?? null,
        sku: n.sku,
        barcode: n.barcode,
        priceCents: strToCents(n.price),
        compareAtCents: n.compareAtPrice ? strToCents(n.compareAtPrice) : null,
        unitCostCents: n.inventoryItem?.unitCost?.amount ? strToCents(n.inventoryItem.unitCost.amount) : null,
        inventoryQuantity: Math.max(0, Number(n.inventoryQuantity ?? 0)),
        inventoryPolicy: n.inventoryPolicy ?? 'DENY',
        title: n.displayName,
        productTitle: n.product.title || n.displayName,
        productStatus: n.product.status ?? 'ACTIVE',
        vendor: n.product.vendor,
        productType: n.product.productType,
      })),
      nextCursor: r.productVariants.pageInfo.hasNextPage ? r.productVariants.pageInfo.endCursor : null,
    };
  }

  async createDraftProductFromItems(input: ShopifyUpsertProductInput): Promise<ShopifyUpsertedProductResult> {
    return this.upsertProduct({ ...input, existingProductId: null, status: input.status ?? 'DRAFT', locationId: null });
  }

  async upsertProduct(input: ShopifyUpsertProductInput): Promise<ShopifyUpsertedProductResult> {
    const optNames = Array.from(
      new Set(input.variants.flatMap((v) => Object.keys(v.optionValues ?? {}))),
    );
    const hasOptions = optNames.length > 0 && input.variants.length > 0;
    const productOptions = hasOptions
      ? optNames.map((name) => ({
          name,
          values: Array.from(new Set(input.variants.map((v) => v.optionValues?.[name] || 'Standard'))).map((val) => ({ name: val })),
        }))
      : [{ name: 'Title', values: [{ name: 'Default Title' }] }];

    const variantsPayload = input.variants.map((v) => ({
      optionValues: hasOptions
        ? optNames.map((optName) => ({ optionName: optName, name: v.optionValues?.[optName] || 'Standard' }))
        : [{ optionName: 'Title', name: 'Default Title' }],
      sku: v.sku,
      ...(v.barcode ? { barcode: v.barcode } : {}),
      price: centsToStr(Math.max(100, v.priceCents)),
      ...(v.compareAtCents && v.compareAtCents > v.priceCents ? { compareAtPrice: centsToStr(v.compareAtCents) } : {}),
      inventoryPolicy: v.availability === 'special_order' ? 'CONTINUE' : 'DENY',
    }));

    const filesPayload = (input.imageUrls ?? [])
      .filter((u) => /^https?:\/\//i.test(u))
      .slice(0, 6)
      .map((originalSource) => ({ originalSource, contentType: 'IMAGE' }));

    type R = {
      productSet: {
        product: { id: string; variants: { nodes: { id: string; sku: string | null; inventoryItem: { id: string } | null }[] } } | null;
        userErrors: { field: string[]; message: string }[];
      };
    };

    const r = await this.client.mutate<R>(PRODUCT_SET, {
      identifier: input.existingProductId ? { id: input.existingProductId } : undefined,
      input: {
        title: input.title,
        vendor: input.vendor || 'UBC',
        productType: input.productType || 'Parts & Components',
        ...(input.descriptionHtml ? { descriptionHtml: input.descriptionHtml } : {}),
        status: input.status,
        ...(input.tags?.length ? { tags: input.tags } : {}),
        productOptions,
        variants: variantsPayload,
        ...(filesPayload.length ? { files: filesPayload } : {}),
      },
    });
    assertNoUserErrors(r.productSet.userErrors);
    const prod = r.productSet.product!;
    const outVariants = prod.variants.nodes.map((n) => ({
      sku: n.sku || '',
      variantId: n.id,
      inventoryItemId: n.inventoryItem?.id ?? null,
    }));

    // Sync unit cost & activate location tracking on newly created/updated variants.
    const onHandBatch: { inventoryItemId: string; quantity: number }[] = [];
    for (const v of outVariants) {
      if (!v.inventoryItemId) continue;
      const spec = input.variants.find((x) => x.sku === v.sku);
      await this.client.mutate(INVENTORY_ITEM_UPDATE, {
        id: v.inventoryItemId,
        input: {
          tracked: true,
          ...(spec?.costCents != null ? { cost: centsToStr(spec.costCents) } : {}),
        },
      });
      if (input.locationId) {
        await this.client.mutate(INVENTORY_ACTIVATE, {
          idempotencyKey: randomUUID(),
          inventoryItemId: v.inventoryItemId,
          locationId: input.locationId,
        });
        if (spec?.onHandQty != null) {
          onHandBatch.push({ inventoryItemId: v.inventoryItemId, quantity: spec.onHandQty });
        }
      }
    }
    if (input.locationId && onHandBatch.length) {
      await this.setInventoryOnHand(input.locationId, onHandBatch);
    }

    return { productId: prod.id, variants: outVariants };
  }

  async getProductsTagInfo(productIds: string[]) {
    type N = { id: string; vendor: string; tags: string[]; priceRangeV2: { minVariantPrice: { amount: string } } } | null;
    const out: { id: string; vendor: string; tags: string[]; minPriceCents: number }[] = [];
    for (let i = 0; i < productIds.length; i += 250) {
      const r = await this.client.query<{ nodes: N[] }>(
        `query($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { id vendor tags priceRangeV2 { minVariantPrice { amount } } } } }`,
        { ids: productIds.slice(i, i + 250) },
      );
      for (const n of r.nodes) if (n?.id) out.push({ id: n.id, vendor: n.vendor || '', tags: n.tags || [], minPriceCents: strToCents(n.priceRangeV2.minVariantPrice.amount) });
    }
    return out;
  }

  async listProductIdsByTag(tag: string) {
    type R = { products: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: { id: string }[] } };
    const ids: string[] = [];
    let after: string | null = null;
    do {
      const r: R = await this.client.query<R>(
        `query($q: String!, $after: String) { products(first: 250, query: $q, after: $after) { pageInfo { hasNextPage endCursor } nodes { id } } }`,
        { q: `tag:${JSON.stringify(tag)}`, after },
      );
      ids.push(...r.products.nodes.map((n) => n.id));
      after = r.products.pageInfo.hasNextPage ? r.products.pageInfo.endCursor : null;
    } while (after);
    return ids;
  }

  async updateProductTags(productId: string, add: string[], remove: string[]) {
    type RA = { tagsAdd: { userErrors: { field: string[]; message: string }[] } };
    type RR = { tagsRemove: { userErrors: { field: string[]; message: string }[] } };
    if (remove.length) {
      const r = await this.client.mutate<RR>(`mutation($id: ID!, $tags: [String!]!) { tagsRemove(id: $id, tags: $tags) { userErrors { field message } } }`, { id: productId, tags: remove });
      assertNoUserErrors(r.tagsRemove.userErrors);
    }
    if (add.length) {
      const r = await this.client.mutate<RA>(`mutation($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { field message } } }`, { id: productId, tags: add });
      assertNoUserErrors(r.tagsAdd.userErrors);
    }
  }

  async activateInventoryAtLocation(inventoryItemId: string, locationId: string) {
    type R = { inventoryActivate: { userErrors: { field: string[]; message: string }[] } };
    // API 2026-10 requires @idempotent on inventoryActivate (INVENTORY_ACTIVATE carries it).
    const r = await this.client.mutate<R>(INVENTORY_ACTIVATE, { idempotencyKey: randomUUID(), inventoryItemId, locationId });
    assertNoUserErrors(r.inventoryActivate.userErrors);
  }

  async bulkReadVariants(onRow: (v: StoreVariantRow) => void) {
    type Cur = { currentBulkOperation: { status: string; url: string | null; errorCode: string | null } | null };
    const cur = await this.client.query<Cur>(`{ currentBulkOperation(type: QUERY) { status url errorCode } }`);
    if (cur.currentBulkOperation && ['CREATED', 'RUNNING'].includes(cur.currentBulkOperation.status)) {
      throw new Error('Another Shopify bulk query is running; retry later');
    }
    type Run = { bulkOperationRunQuery: { userErrors: { field: string[]; message: string }[] } };
    const run = await this.client.mutate<Run>(
      `mutation { bulkOperationRunQuery(query: """
        { productVariants { edges { node { id barcode displayName price compareAtPrice inventoryQuantity inventoryItem { id } product { id } metafield(namespace: "workstand", key: "variant_uuid") { id } } } } }
      """) { bulkOperation { id } userErrors { field message } } }`,
      {},
    );
    assertNoUserErrors(run.bulkOperationRunQuery.userErrors);
    let url: string | null = null;
    for (let i = 0; i < 144; i++) { // up to ~12 min (stale-job recovery kicks in at 15)
      await new Promise((r) => setTimeout(r, 5000));
      const s = (await this.client.query<Cur>(`{ currentBulkOperation(type: QUERY) { status url errorCode } }`)).currentBulkOperation;
      if (s?.status === 'COMPLETED') { url = s.url; break; }
      if (s && ['FAILED', 'CANCELED', 'EXPIRED'].includes(s.status)) throw new Error(`Shopify bulk query ${s.status} ${s.errorCode ?? ''}`);
    }
    if (!url) return 0;
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`Bulk result download failed (${res.status})`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let n = 0;
    const emit = (line: string) => {
      if (!line.trim()) return;
      const o = JSON.parse(line) as { metafield?: { id: string } | null; id?: string; displayName?: string; barcode?: string | null; price?: string; compareAtPrice?: string | null; inventoryQuantity?: number; inventoryItem?: { id: string }; product?: { id: string } };
      if (!o.id?.includes('ProductVariant') || !o.product?.id) return;
      const p = strToCents(o.price ?? '0');
      const c = o.compareAtPrice ? strToCents(o.compareAtPrice) : null;
      onRow({ variantId: o.id, productId: o.product.id, inventoryItemId: o.inventoryItem?.id ?? null, barcode: o.barcode ?? null, title: o.displayName ?? '', fromWorkstand: !!o.metafield, priceCents: p, compareAtCents: c && c > p ? c : null });
      n++;
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) { emit(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
    }
    emit(buf);
    return n;
  }

  async getInventoryOnHand(inventoryItemIds: string[]) {
    type Lvl = { location: { id: string }; quantities: { name: string; quantity: number }[] };
    type R = { nodes: ({ id: string; inventoryLevels: { nodes: Lvl[] } } | null)[] };
    const out = new Map<string, Record<string, number>>();
    for (let i = 0; i < inventoryItemIds.length; i += 100) {
      const r = await this.client.query<R>(
        `query($ids: [ID!]!) { nodes(ids: $ids) { ... on InventoryItem { id inventoryLevels(first: 10) { nodes { location { id } quantities(names: ["on_hand"]) { name quantity } } } } } }`,
        { ids: inventoryItemIds.slice(i, i + 100) },
      );
      for (const n of r.nodes) {
        if (!n?.id) continue;
        const byLoc: Record<string, number> = {};
        for (const l of n.inventoryLevels.nodes) byLoc[l.location.id] = l.quantities.find((q) => q.name === 'on_hand')?.quantity ?? 0;
        out.set(n.id, byLoc);
      }
    }
    return out;
  }

  async getVariantPrices(variantIds: string[]) {
    type R = { nodes: ({ id: string; price: string; compareAtPrice: string | null } | null)[] };
    const out: { variantId: string; priceCents: number; compareAtCents: number | null }[] = [];
    for (let i = 0; i < variantIds.length; i += 250) {
      const r = await this.client.query<R>(
        `query($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id price compareAtPrice } } }`,
        { ids: variantIds.slice(i, i + 250) },
      );
      for (const n of r.nodes) {
        if (!n?.id) continue;
        const p = strToCents(n.price);
        const c = n.compareAtPrice ? strToCents(n.compareAtPrice) : null;
        out.push({ variantId: n.id, priceCents: p, compareAtCents: c && c > p ? c : null });
      }
    }
    return out;
  }

  async updateVariantPrices(productId: string, updates: { variantId: string; priceCents: number; compareAtCents: number | null }[]) {
    type R = { productVariantsBulkUpdate: { userErrors: { field: string[]; message: string }[] } };
    for (let i = 0; i < updates.length; i += 100) {
      const chunk = updates.slice(i, i + 100);
      const r = await this.client.mutate<R>(VARIANTS_BULK_UPDATE, {
        productId,
        variants: chunk.map((u) => ({
          id: u.variantId,
          price: centsToStr(u.priceCents),
          compareAtPrice: u.compareAtCents === null ? null : centsToStr(u.compareAtCents),
        })),
      });
      assertNoUserErrors(r.productVariantsBulkUpdate.userErrors);
    }
  }

  async createAutomaticDiscount(input: { title: string; percentOff?: number; amountOffCents?: number; productIds: string[]; variantIds?: string[]; startsAt: string; endsAt: string | null }) {
    type RCreate = { discountAutomaticBasicCreate: { automaticDiscountNode: { id: string } | null; userErrors: { field: string[]; message: string }[] } };
    type RUpdate = { discountAutomaticBasicUpdate: { automaticDiscountNode: { id: string } | null; userErrors: { field: string[]; message: string }[] } };
    const value = input.percentOff !== undefined
      ? { percentage: input.percentOff }
      : { discountAmount: { amount: centsToStr(input.amountOffCents ?? 0), appliesOnEachItem: true } };

    // Variant-level targeting (when given) so a product that groups several sizes/colors only discounts the chosen ones.
    const byVariant = Array.isArray(input.variantIds) && input.variantIds.length > 0;
    const ids = byVariant ? input.variantIds! : input.productIds;
    const itemsFor = (chunk: string[]) => ({ products: byVariant ? { productVariantsToAdd: chunk } : { productsToAdd: chunk } });
    // Shopify limits GIDs per mutation (~250); chunk safely by 200 for 30k–40k catalogs.
    const firstChunk = ids.slice(0, 200);
    const r = await this.client.mutate<RCreate>(DISCOUNT_AUTOMATIC_BASIC_CREATE, {
      automaticBasicDiscount: {
        title: input.title,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        customerGets: { value, items: itemsFor(firstChunk) },
      },
    });
    assertNoUserErrors(r.discountAutomaticBasicCreate.userErrors);
    const discountId = r.discountAutomaticBasicCreate.automaticDiscountNode!.id;

    for (let i = 200; i < ids.length; i += 200) {
      const nextChunk = ids.slice(i, i + 200);
      const u = await this.client.mutate<RUpdate>(DISCOUNT_AUTOMATIC_BASIC_UPDATE, {
        id: discountId,
        automaticBasicDiscount: {
          customerGets: { value, items: itemsFor(nextChunk) },
        },
      });
      assertNoUserErrors(u.discountAutomaticBasicUpdate.userErrors);
    }

    return discountId;
  }

  async deactivateAutomaticDiscount(id: string) {
    type R = { discountAutomaticDeactivate: { userErrors: { field: string[]; message: string }[] } };
    const r = await this.client.mutate<R>(DISCOUNT_AUTOMATIC_DEACTIVATE, { id });
    assertNoUserErrors(r.discountAutomaticDeactivate.userErrors);
  }

  async setProductsStatus(productIds: string[], status: 'ACTIVE' | 'DRAFT') {
    type R = { productUpdate: { userErrors: { field: string[]; message: string }[] } };
    for (const id of productIds) {
      const r = await this.client.mutate<R>(PRODUCT_UPDATE_STATUS, { product: { id, status } });
      assertNoUserErrors(r.productUpdate.userErrors);
    }
  }

  async setVariantFulfillmentMetafields(updates: VariantFulfillmentMetafieldUpdate[]) {
    type R = { metafieldsSet: { userErrors: { field: string[]; message: string }[] } };
    const metafields = updates.flatMap((u) => [
      { ownerId: u.variantId, namespace: 'ubc', key: 'availability', type: 'single_line_text_field', value: u.availability },
      ...(u.leadTimeDays !== null
        ? [{ ownerId: u.variantId, namespace: 'ubc', key: 'lead_time_days', type: 'number_integer', value: String(u.leadTimeDays) }]
        : []),
      {
        ownerId: u.variantId,
        namespace: 'ubc',
        key: 'click_and_collect_only',
        type: 'boolean',
        value: u.clickAndCollectOnly ? 'true' : 'false',
      },
    ]);
    for (let i = 0; i < metafields.length; i += 25) {
      const r = await this.client.mutate<R>(METAFIELDS_SET, { metafields: metafields.slice(i, i + 25) });
      assertNoUserErrors(r.metafieldsSet.userErrors);
    }
  }

  async setInventoryOnHand(locationId: string, quantities: { inventoryItemId: string; quantity: number }[]) {
    if (!quantities.length) return;
    type R = { inventorySetQuantities: { userErrors: { field: string[]; message: string }[] } };
    for (let i = 0; i < quantities.length; i += 100) {
      const chunk = quantities.slice(i, i + 100);
      const r = await this.client.mutate<R>(INVENTORY_SET_QUANTITIES, {
        idempotencyKey: randomUUID(),
        input: {
          name: 'on_hand',
          reason: 'correction',
          quantities: chunk.map((q) => ({
            inventoryItemId: q.inventoryItemId,
            locationId,
            quantity: Math.max(0, Math.floor(q.quantity)),
            changeFromQuantity: null,
          })),
        },
      });
      assertNoUserErrors(r.inventorySetQuantities.userErrors);
    }
  }

  async ensureUbcMetafieldDefinitions() {
    type R = { metafieldDefinitionCreate: { createdDefinition: { id: string; key: string } | null; userErrors: { code?: string; field?: string[]; message: string }[] } };
    const created: string[] = [];
    const existing: string[] = [];
    for (const def of UBC_METAFIELD_DEFINITIONS) {
      const r = await this.client.mutate<R>(METAFIELD_DEFINITION_CREATE, { definition: def });
      const errs = r.metafieldDefinitionCreate.userErrors ?? [];
      const taken = errs.some((e) => e.code === 'TAKEN' || /taken|already exists/i.test(e.message));
      if (taken) {
        existing.push(`ubc.${def.key}`);
      } else {
        assertNoUserErrors(errs);
        created.push(`ubc.${def.key}`);
      }
    }
    return { created, existing };
  }

  async ensureSmartCollections() {
    type QRes = { collectionByHandle: { id: string; handle: string } | null };
    type MRes = { collectionCreate: { collection: { id: string; handle: string } | null; userErrors: { field?: string[]; message: string }[] } };
    const created: string[] = [];
    const existing: string[] = [];
    for (const col of UBC_SMART_COLLECTIONS) {
      const found = await this.client.query<QRes>(COLLECTION_BY_HANDLE, { handle: col.handle });
      if (found.collectionByHandle?.id) {
        existing.push(col.handle);
        continue;
      }
      const res = await this.client.mutate<MRes>(SMART_COLLECTION_CREATE, {
        input: {
          title: col.title,
          handle: col.handle,
          ruleSet: {
            appliedDisjunctively: true,
            rules: col.rules,
          },
        },
      });
      const errs = res.collectionCreate.userErrors ?? [];
      if (errs.some((e) => /taken|already exists/i.test(e.message))) {
        existing.push(col.handle);
      } else {
        assertNoUserErrors(errs);
        created.push(col.handle);
      }
    }
    return { created, existing };
  }

  async listActiveStockCollectionCoverage() {
    type R = {
      products: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: {
          id: string;
          title: string;
          vendor: string;
          productType: string;
          totalInventory: number;
          featuredMedia: { id: string } | null;
          tags: string[];
          collections: { nodes: { handle: string; title: string }[] };
        }[];
      };
    };
    const out: {
      id: string;
      title: string;
      vendor: string;
      productType: string;
      totalInventory: number;
      hasPhoto: boolean;
      tags: string[];
      collections: { handle: string; title: string }[];
    }[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 40; page++) {
      const r: R = await this.client.query<R>(
        `query ActiveCoverage($cursor: String) {
          products(first: 100, after: $cursor, query: "status:active inventory_total:>0") {
            pageInfo { hasNextPage endCursor }
            nodes {
              id title vendor productType totalInventory tags
              featuredMedia { id }
              collections(first: 15) { nodes { handle title } }
            }
          }
        }`,
        { cursor },
      );
      for (const p of r.products.nodes) {
        out.push({
          id: p.id,
          title: p.title,
          vendor: p.vendor,
          productType: p.productType,
          totalInventory: p.totalInventory,
          hasPhoto: Boolean(p.featuredMedia && p.featuredMedia.id),
          tags: p.tags,
          collections: p.collections.nodes,
        });
      }
      if (!r.products.pageInfo.hasNextPage) break;
      cursor = r.products.pageInfo.endCursor;
    }
    return out;
  }
}

/** DEMO adapter: records calls in memory so tests and the demo can assert what would have been sent. */
export class MockShopifyAdmin implements ShopifyAdminPort {
  readonly calls: { op: string; args: unknown }[] = [];
  private discountSeq = 0;
  private productSeq = 0;
  async listLocations() {
    this.calls.push({ op: 'listLocations', args: null });
    return [{ id: 'gid://shopify/Location/demo-1', name: 'UBC Main Store (DEMO)', isActive: true }];
  }
  async listVariants() { this.calls.push({ op: 'listVariants', args: null }); return { variants: [], nextCursor: null }; }
  async upsertProduct(input: ShopifyUpsertProductInput): Promise<ShopifyUpsertedProductResult> {
    this.calls.push({ op: 'upsertProduct', args: input });
    const seq = ++this.productSeq;
    return {
      productId: input.existingProductId || `gid://shopify/Product/demo-${seq}`,
      variants: input.variants.map((v, idx) => ({
        sku: v.sku,
        variantId: `gid://shopify/ProductVariant/demo-${seq}-${idx + 1}`,
        inventoryItemId: `gid://shopify/InventoryItem/demo-${seq}-${idx + 1}`,
      })),
    };
  }
  async createDraftProductFromItems(input: ShopifyUpsertProductInput): Promise<ShopifyUpsertedProductResult> {
    return this.upsertProduct({ ...input, existingProductId: null, status: 'DRAFT' });
  }
  async updateVariantPrices(productId: string, updates: unknown) { this.calls.push({ op: 'updateVariantPrices', args: { productId, updates } }); }
  async getVariantPrices(variantIds: string[]) { this.calls.push({ op: 'getVariantPrices', args: { count: variantIds.length } }); return []; }
  async bulkReadVariants() { this.calls.push({ op: 'bulkReadVariants', args: null }); return 0; }
  async getProductsTagInfo(productIds: string[]) { this.calls.push({ op: 'getProductsTagInfo', args: { count: productIds.length } }); return []; }
  async listProductIdsByTag(tag: string) { this.calls.push({ op: 'listProductIdsByTag', args: tag }); return [] as string[]; }
  async updateProductTags(productId: string, add: string[], remove: string[]) { this.calls.push({ op: 'updateProductTags', args: { productId, add, remove } }); }
  async activateInventoryAtLocation(inventoryItemId: string, locationId: string) { this.calls.push({ op: 'activateInventoryAtLocation', args: { inventoryItemId, locationId } }); }
  async getInventoryOnHand(inventoryItemIds: string[]) { this.calls.push({ op: 'getInventoryOnHand', args: { count: inventoryItemIds.length } }); return new Map<string, Record<string, number>>(); }
  async createAutomaticDiscount(input: unknown) { this.calls.push({ op: 'createAutomaticDiscount', args: input }); return `gid://shopify/DiscountAutomaticNode/demo-${++this.discountSeq}`; }
  async deactivateAutomaticDiscount(id: string) { this.calls.push({ op: 'deactivateAutomaticDiscount', args: id }); }
  async setProductsStatus(productIds: string[], status: string) { this.calls.push({ op: 'setProductsStatus', args: { productIds, status } }); }
  async setVariantFulfillmentMetafields(updates: unknown) { this.calls.push({ op: 'setVariantFulfillmentMetafields', args: updates }); }
  async setInventoryOnHand(locationId: string, quantities: unknown) { this.calls.push({ op: 'setInventoryOnHand', args: { locationId, quantities } }); }
  async ensureUbcMetafieldDefinitions() { this.calls.push({ op: 'ensureUbcMetafieldDefinitions', args: null }); return { created: ['ubc.availability', 'ubc.lead_time_days', 'ubc.click_and_collect_only'], existing: [] }; }
  async ensureSmartCollections() { this.calls.push({ op: 'ensureSmartCollections', args: null }); return { created: ['electric-bikes', 'road-bikes', 'mountain-bikes', 'helmets', 'tires-tubes'], existing: [] }; }
  async listActiveStockCollectionCoverage() { this.calls.push({ op: 'listActiveStockCollectionCoverage', args: null }); return []; }
}
