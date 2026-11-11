/**
 * Shopify Admin GraphQL operations used by the Integration Engine.
 * Field names follow the Admin GraphQL schema; re-validate against the
 * pinned API version with Shopify's schema/AI Toolkit before enabling LIVE.
 */
import type { ShopifyAdminClient } from './client.js';

export interface ShopifyAdminPort {
  listVariants(cursor: string | null): Promise<{ variants: ShopifyVariantRecord[]; nextCursor: string | null }>;
  updateVariantPrices(productId: string, updates: { variantId: string; priceCents: number; compareAtCents: number | null }[]): Promise<void>;
  createAutomaticDiscount(input: { title: string; percentOff?: number; amountOffCents?: number; productIds: string[]; startsAt: string; endsAt: string | null }): Promise<string>;
  deactivateAutomaticDiscount(discountId: string): Promise<void>;
  setProductsStatus(productIds: string[], status: 'ACTIVE' | 'DRAFT'): Promise<void>;
}

export interface ShopifyVariantRecord {
  variantId: string;
  productId: string;
  sku: string | null;
  barcode: string | null;
  priceCents: number;
  title: string;
  vendor: string;
  productType: string;
}

const centsToStr = (c: number) => (c / 100).toFixed(2);
const strToCents = (s: string) => Math.round(Number(s) * 100);

export const LIST_VARIANTS = /* GraphQL */ `
  query ListVariants($cursor: String) {
    productVariants(first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id sku barcode price displayName
        product { id vendor productType }
      }
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

export const DISCOUNT_AUTOMATIC_DEACTIVATE = /* GraphQL */ `
  mutation Deactivate($id: ID!) {
    discountAutomaticDeactivate(id: $id) { userErrors { field message } }
  }`;

export const PRODUCT_UPDATE_STATUS = /* GraphQL */ `
  mutation SetStatus($product: ProductUpdateInput!) {
    productUpdate(product: $product) { userErrors { field message } }
  }`;

function assertNoUserErrors(errs: { field?: string[] | null; message: string }[] | undefined) {
  if (errs && errs.length) throw new Error(`Shopify userErrors: ${errs.map((e) => e.message).join('; ')}`);
}

export class ShopifyAdminApi implements ShopifyAdminPort {
  constructor(private readonly client: ShopifyAdminClient) {}

  async listVariants(cursor: string | null) {
    type R = { productVariants: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: { id: string; sku: string | null; barcode: string | null; price: string; displayName: string; product: { id: string; vendor: string; productType: string } }[] } };
    const r = await this.client.query<R>(LIST_VARIANTS, { cursor });
    return {
      variants: r.productVariants.nodes.map((n) => ({
        variantId: n.id, productId: n.product.id, sku: n.sku, barcode: n.barcode, priceCents: strToCents(n.price),
        title: n.displayName, vendor: n.product.vendor, productType: n.product.productType,
      })),
      nextCursor: r.productVariants.pageInfo.hasNextPage ? r.productVariants.pageInfo.endCursor : null,
    };
  }

  async updateVariantPrices(productId: string, updates: { variantId: string; priceCents: number; compareAtCents: number | null }[]) {
    type R = { productVariantsBulkUpdate: { userErrors: { field: string[]; message: string }[] } };
    const r = await this.client.mutate<R>(VARIANTS_BULK_UPDATE, {
      productId,
      variants: updates.map((u) => ({ id: u.variantId, price: centsToStr(u.priceCents), compareAtPrice: u.compareAtCents === null ? null : centsToStr(u.compareAtCents) })),
    });
    assertNoUserErrors(r.productVariantsBulkUpdate.userErrors);
  }

  async createAutomaticDiscount(input: { title: string; percentOff?: number; amountOffCents?: number; productIds: string[]; startsAt: string; endsAt: string | null }) {
    type R = { discountAutomaticBasicCreate: { automaticDiscountNode: { id: string } | null; userErrors: { field: string[]; message: string }[] } };
    const value = input.percentOff !== undefined
      ? { percentage: input.percentOff }
      : { discountAmount: { amount: centsToStr(input.amountOffCents ?? 0), appliesOnEachItem: true } };
    const r = await this.client.mutate<R>(DISCOUNT_AUTOMATIC_BASIC_CREATE, {
      automaticBasicDiscount: {
        title: input.title,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        customerGets: { value, items: { products: { productsToAdd: input.productIds } } },
      },
    });
    assertNoUserErrors(r.discountAutomaticBasicCreate.userErrors);
    return r.discountAutomaticBasicCreate.automaticDiscountNode!.id;
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
}

/** DEMO adapter: records calls in memory so tests and the demo can assert what would have been sent. */
export class MockShopifyAdmin implements ShopifyAdminPort {
  readonly calls: { op: string; args: unknown }[] = [];
  private discountSeq = 0;
  async listVariants() { this.calls.push({ op: 'listVariants', args: null }); return { variants: [], nextCursor: null }; }
  async updateVariantPrices(productId: string, updates: unknown) { this.calls.push({ op: 'updateVariantPrices', args: { productId, updates } }); }
  async createAutomaticDiscount(input: unknown) { this.calls.push({ op: 'createAutomaticDiscount', args: input }); return `gid://shopify/DiscountAutomaticNode/demo-${++this.discountSeq}`; }
  async deactivateAutomaticDiscount(id: string) { this.calls.push({ op: 'deactivateAutomaticDiscount', args: id }); }
  async setProductsStatus(productIds: string[], status: string) { this.calls.push({ op: 'setProductsStatus', args: { productIds, status } }); }
}
