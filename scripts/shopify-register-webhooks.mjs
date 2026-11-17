// Registers idempotent Shopify order webhooks (`ORDERS_CREATE`, `ORDERS_UPDATED`)
// pointing to HUB_PUBLIC_URL (default: https://ubc-hub.twoitsolutions.com).
import { ShopifyAdminClient } from '../packages/integrations/dist/index.js';

const hubUrl = (process.env.HUB_PUBLIC_URL?.trim() || 'https://ubc-hub.twoitsolutions.com').replace(/\/+$/, '');
const callbackUri = `${hubUrl}/webhooks/shopify`;

const client = new ShopifyAdminClient({
  shopDomain: process.env.SHOPIFY_SHOP_DOMAIN?.trim(),
  clientId: process.env.SHOPIFY_CLIENT_ID?.trim(),
  clientSecret: process.env.SHOPIFY_CLIENT_SECRET?.trim(),
  accessToken: process.env.SHOPIFY_ADMIN_ACCESS_TOKEN?.trim(),
  apiVersion: process.env.SHOPIFY_API_VERSION?.trim() || '2026-10',
  plan: process.env.SHOPIFY_PLAN?.trim() || 'basic',
  writesEnabled: true,
});

const existing = await client.query(`{
  webhookSubscriptions(first: 50) {
    nodes {
      id
      topic
      uri
    }
  }
}`);

const have = new Set(
  (existing.webhookSubscriptions?.nodes ?? [])
    .filter((n) => n.uri === callbackUri)
    .map((n) => n.topic),
);

const CREATE_MUTATION = `
  mutation RegisterHubWebhook($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
      webhookSubscription {
        id
        topic
        uri
      }
      userErrors {
        field
        message
      }
    }
  }
`;

for (const topic of ['ORDERS_CREATE', 'ORDERS_UPDATED', 'ORDERS_CANCELLED']) {
  if (have.has(topic)) {
    console.log(`[skip] ${topic} already registered -> ${callbackUri}`);
    continue;
  }
  const res = await client.mutate(CREATE_MUTATION, {
    topic,
    webhookSubscription: {
      uri: callbackUri,
      format: 'JSON',
    },
  });
  const errs = res.webhookSubscriptionCreate?.userErrors ?? [];
  if (errs.length > 0) {
    console.error(`[error] ${topic}:`, JSON.stringify(errs));
    process.exitCode = 1;
  } else {
    console.log(`[ok] Registered ${topic} ->`, res.webhookSubscriptionCreate?.webhookSubscription);
  }
}
