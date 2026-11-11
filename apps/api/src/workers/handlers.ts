import type { ItemFilter, PublishStatus } from '@ubc/shared';
import { withTransaction } from '@ubc/database';
import type { ShopifyOrderWebhook } from '@ubc/integrations';
import { audit } from '../services/audit.js';
import { applyCampaignJob, restoreCampaignJob } from '../services/campaigns.js';
import { buildWhere, getSettings } from '../services/catalog.js';
import type { AppContext } from '../services/context.js';
import { setProgress, type JobRow } from '../services/jobs.js';
import { ingestShopifyOrder, onPoSubmitDead, reviewOrderJob, submitPoJob } from '../services/orders.js';
import { importFeedJob } from '../services/suppliers.js';

type Handler = (ctx: AppContext, job: JobRow) => Promise<unknown>;

export const handlers: Record<string, Handler> = {
  'campaign.apply': (ctx, j) => applyCampaignJob(ctx, j.company_id, String(j.payload.campaignId), j.id),
  'campaign.restore': (ctx, j) => restoreCampaignJob(ctx, j.company_id, String(j.payload.campaignId)),
  'order.review': (ctx, j) => reviewOrderJob(ctx, j.company_id, String(j.payload.orderId)),
  'po.submit': (ctx, j) => submitPoJob(ctx, j.company_id, String(j.payload.purchaseOrderId)),
  'supplier.import_feed': (ctx, j) => importFeedJob(ctx, j.company_id, j.payload as never),

  'shopify.order_created': async (ctx, j) => {
    const ev = await ctx.pool.query<{ payload: ShopifyOrderWebhook }>(`SELECT payload FROM sync_events WHERE id = $1 AND company_id = $2`, [j.payload.syncEventId, j.company_id]);
    if (!ev.rows[0]) throw Object.assign(new Error('sync event missing'), { code: 'VALIDATION' });
    const res = await ingestShopifyOrder(ctx, j.company_id, String(j.payload.storeId), ev.rows[0].payload);
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
      const shopifyIds = await ctx.pool.query<{ external_id: string }>(
        `SELECT external_id FROM external_ids WHERE company_id = $1 AND system = 'shopify' AND entity_type = 'product' AND entity_id = ANY($2::uuid[])`, [j.company_id, chunk]);
      await ctx.connectors.shopify.setProductsStatus(shopifyIds.rows.map((r) => r.external_id), status === 'published' ? 'ACTIVE' : 'DRAFT');
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
