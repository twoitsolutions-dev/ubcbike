import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify a Shopify webhook. Shopify signs the *raw* request body with the
 * app's client secret (HMAC-SHA256, base64) in `X-Shopify-Hmac-Sha256`.
 * The body must not be re-serialised before verification.
 */
export function verifyShopifyWebhook(rawBody: Buffer | string, hmacHeader: string | undefined, secret: string): boolean {
  if (!hmacHeader || !secret) return false;
  const digest = createHmac('sha256', secret).update(rawBody).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(hmacHeader, 'base64');
  } catch {
    return false;
  }
  if (provided.length !== digest.length) return false;
  return timingSafeEqual(provided, digest);
}

export function signShopifyWebhook(rawBody: Buffer | string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('base64');
}

/** Minimal shape of the `orders/create` payload fields we rely on. */
export interface ShopifyOrderWebhook {
  id: number | string;
  admin_graphql_api_id?: string;
  name: string;
  created_at: string;
  financial_status?: string;
  fulfillment_status?: string | null;
  total_price?: string;
  customer?: { first_name?: string; last_name?: string } | null;
  shipping_lines?: { code?: string; title?: string }[];
  line_items: {
    id: number | string;
    variant_id: number | string | null;
    sku: string | null;
    title: string;
    quantity: number;
    price: string;
  }[];
}

export function priceToCents(price: string | undefined | null): number {
  if (!price) return 0;
  const [whole, frac = ''] = price.split('.');
  return Number(whole) * 100 + Number((frac + '00').slice(0, 2)) * (price.startsWith('-') ? -1 : 1);
}
