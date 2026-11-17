import type { ItemFilter, PublishStatus } from '@ubc/shared';
import { withTransaction } from '@ubc/database';
import type { ShopifyOrderWebhook } from '@ubc/integrations';
import { audit } from '../services/audit.js';
import { applyCampaignJob, restoreCampaignJob } from '../services/campaigns.js';
import { buildWhere, getSettings } from '../services/catalog.js';
import type { AppContext } from '../services/context.js';
import { setProgress, type JobRow } from '../services/jobs.js';
import { syncFromLightspeedJob, syncLightspeedSpecialOrdersJob } from '../services/lightspeed-sync.js';
import { cancelShopifyOrderFromWebhook, ingestShopifyOrder, onPoSubmitDead, reviewOrderJob, submitPoJob } from '../services/orders.js';
import { flushStagedToShopifyJob, reconcileShopifyLinksJob, runPipelineWatchdogAndSchedules } from '../services/pipeline.js';
import { linkStoreByUpcJob } from '../services/shopify-links.js';
import { syncFromShopifyJob } from '../services/shopify-sync.js';
import { importFeedJob, promoteUnmatchedOffersJob } from '../services/suppliers.js';

type Handler = (ctx: AppContext, job: JobRow) => Promise<unknown>;

export const handlers: Record<string, Handler> = {
  'campaign.apply': (ctx, j) => applyCampaignJob(ctx, j.company_id, String(j.payload.campaignId), j.id),
  'campaign.restore': (ctx, j) => restoreCampaignJob(ctx, j.company_id, String(j.payload.campaignId)),
  'order.review': (ctx, j) => reviewOrderJob(ctx, j.company_id, String(j.payload.orderId)),
  'po.submit': (ctx, j) => submitPoJob(ctx, j.company_id, String(j.payload.purchaseOrderId)),
  'supplier.import_feed': (ctx, j) => importFeedJob(ctx, j.company_id, j.payload as never, j.id),
  'supplier.promote_catalog': (ctx, j) => promoteUnmatchedOffersJob(ctx, j.company_id, j.payload as never, j.id),
  'shopify.sync_catalog': async (ctx, j) => (ctx.config.env.SHOPIFY_SYNC_MODE === 'update_only'
    ? { skipped: 'Workstand-owned store: catalog import disabled (use UPC Matches)' }
    : syncFromShopifyJob(ctx, j.company_id, j.id)),
  'shopify.ensure_collections': (ctx) => ctx.connectors.shopify.ensureSmartCollections(),
  'lightspeed.sync_catalog': (ctx, j) => syncFromLightspeedJob(ctx, j.company_id, j.payload as never, j.id),
  'lightspeed.sync_special_orders': (ctx, j) => syncLightspeedSpecialOrdersJob(ctx, j.company_id),
  'pipeline.flush_shopify': (ctx, j) => flushStagedToShopifyJob(ctx, j.company_id, {
    limit: Number(j.payload?.limit) || 250,
    chainDepth: Number(j.payload?.chainDepth) || 0,
  }),
  'pipeline.watchdog': (ctx) => runPipelineWatchdogAndSchedules(ctx),
  'shopify.reconcile_links': (ctx, j) => reconcileShopifyLinksJob(ctx, j.company_id),
  'shopify.link_store': (ctx, j) => linkStoreByUpcJob(ctx, j.company_id),

  'shopify.order_created': async (ctx, j) => {
    const ev = await ctx.pool.query<{ payload: ShopifyOrderWebhook }>(`SELECT payload FROM sync_events WHERE id = $1 AND company_id = $2`, [j.payload.syncEventId, j.company_id]);
    if (!ev.rows[0]) throw Object.assign(new Error('sync event missing'), { code: 'VALIDATION' });
    const res = await ingestShopifyOrder(ctx, j.company_id, String(j.payload.storeId), ev.rows[0].payload);
    await ctx.pool.query(`UPDATE sync_events SET status = 'processed', processed_at = now() WHERE id = $1`, [j.payload.syncEventId]);
    return res;
  },

  'shopify.order_cancelled': async (ctx, j) => {
    const ev = await ctx.pool.query<{ payload: ShopifyOrderWebhook }>(`SELECT payload FROM sync_events WHERE id = $1 AND company_id = $2`, [j.payload.syncEventId, j.company_id]);
    if (!ev.rows[0]) throw Object.assign(new Error('sync event missing'), { code: 'VALIDATION' });
    const res = await cancelShopifyOrderFromWebhook(ctx, j.company_id, String(j.payload.storeId), ev.rows[0].payload);
    await ctx.pool.query(`UPDATE sync_events SET status = 'processed', processed_at = now() WHERE id = $1`, [j.payload.syncEventId]);
    return res;
  },

  'items.bulk_status': async (ctx, j) => {
    const { filter, status } = j.payload as { filter: ItemFilter; status: PublishStatus };
    const { availability } = await getSettings(ctx.pool, j.company_id);
    const { sql, params } = buildWhere(j.company_id, filter, availability);
    const products = await ctx.pool.query<{ product_id: string }>(`SELECT DISTINCT product_id FROM catalog_items WHERE ${sql}`, params);
    const ids = products.rows.map((r) => r.product_id);
    let done = 0;
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      await withTransaction(ctx.pool, async (c) => {
        await c.query(`UPDATE products SET status = $2, updated_at = now() WHERE company_id = $1 AND id = ANY($3::uuid[])`, [j.company_id, status, chunk]);
        await c.query(`UPDATE variants SET status = $2, version = version + 1, updated_at = now() WHERE company_id = $1 AND product_id = ANY($3::uuid[])`, [j.company_id, status, chunk]);
      });
      // Workstand-owned store: the Shopify products are the ones holding the UPC-linked variants.
      const shopifyIds = ctx.config.env.SHOPIFY_SYNC_MODE === 'update_only'
        ? await ctx.pool.query<{ external_id: string }>(
          `SELECT DISTINCT l.shopify_product_id AS external_id FROM shopify_variant_links l JOIN variants v ON v.id = l.variant_id
           WHERE l.company_id = $1 AND l.shop_domain = $3 AND v.product_id = ANY($2::uuid[])`,
          [j.company_id, chunk, String(ctx.config.env.SHOPIFY_SHOP_DOMAIN ?? '').toLowerCase()])
        : await ctx.pool.query<{ external_id: string }>(
          `SELECT external_id FROM external_ids WHERE company_id = $1 AND system = 'shopify' AND entity_type = 'product' AND entity_id = ANY($2::uuid[])`, [j.company_id, chunk]);
      const gids = shopifyIds.rows.map((r) => r.external_id);
      const targetShopifyStatus = status === 'published' ? 'ACTIVE' : 'DRAFT';
      for (let k = 0; k < gids.length; k += 4) {
        await ctx.connectors.shopify.setProductsStatus(gids.slice(k, k + 4), targetShopifyStatus);
      }
      done += chunk.length;
      await setProgress(ctx.pool, j.id, { done, total: ids.length });
    }
    await audit(ctx.pool, { companyId: j.company_id, userId: j.created_by, action: 'items.bulk_status_applied', detail: { products: ids.length, status } });
    return { products: ids.length, status };
  },
};

/** Side effects when a job exhausts retries. */
export const onDead: Record<string, (ctx: AppContext, job: JobRow, message: string) => Promise<void>> = {
  'po.submit': (ctx, j, m) => onPoSubmitDead(ctx, j.company_id, String(j.payload.purchaseOrderId), m),
  'campaign.apply': async (ctx, j) => { await ctx.pool.query(`UPDATE campaigns SET status = 'failed', updated_at = now() WHERE id = $1 AND status = 'applying'`, [j.payload.campaignId]); },
};
