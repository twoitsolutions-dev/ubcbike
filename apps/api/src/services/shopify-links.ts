import { normalizeGtin } from '@ubc/business-rules';
import { audit, logError } from './audit.js';
import type { AppContext } from './context.js';
import { enqueue } from './jobs.js';

/**
 * Nightly (update_only): match Lightspeed items to the variants that exist in the Workstand-owned
 * Shopify store, by UPC (normalized GTIN-14: Workstand "00" prefixes, Excel-dropped zeros and EAN-only
 * items all match). Incremental and safe:
 *  - adds links for new matches (new Lightspeed items, or new Workstand catalog products),
 *  - re-points links whose UPC now belongs to another item, removes links whose UPC no longer matches,
 *  - never deletes in bulk: if more than 20% of the links would disappear, removals are skipped and alerted,
 *  - queues new/changed links so the next flush pushes the Lightspeed price, sale price and stock.
 * Repeated UPCs in Lightspeed are resolved only without doubt (the only one in stock, else the only single
 * unit vs. packs); otherwise left out for review.
 */
export async function linkStoreByUpcJob(ctx: AppContext, companyId: string) {
  if (ctx.config.env.SHOPIFY_SYNC_MODE !== 'update_only') return { skipped: 'not update_only' };
  const shop = String(ctx.config.env.SHOPIFY_SHOP_DOMAIN ?? '').toLowerCase();

  const hub = await ctx.pool.query<{ id: string; upc: string | null; title: string; on_hand: number }>(
    `SELECT v.id, v.upc, v.title,
            COALESCE((SELECT sum(il.on_hand)::int FROM inventory_levels il WHERE il.variant_id = v.id), 0) AS on_hand
     FROM variants v
     JOIN external_ids e ON e.company_id = v.company_id AND e.entity_type = 'variant' AND e.entity_id = v.id AND e.system = 'lightspeed_r'
     WHERE v.company_id = $1`,
    [companyId],
  );
  const groups = new Map<string, typeof hub.rows>();
  for (const v of hub.rows) {
    const g = normalizeGtin(v.upc);
    if (g) groups.set(g, [...(groups.get(g) ?? []), v]);
  }
  const isPack = (t: string) => /\b(\d+\s*(pcs?|pk|pack|box|ct|bx|bag)|bulk|case|\d{2,}p)\b/i.test(t ?? '');
  const hubByGtin = new Map<string, string>();
  let dupSkipped = 0;
  for (const [g, vs] of groups) {
    if (vs.length === 1) { hubByGtin.set(g, vs[0]!.id); continue; }
    const stocked = vs.filter((v) => v.on_hand > 0);
    const singles = vs.filter((v) => !isPack(v.title));
    const pick = stocked.length === 1 ? stocked[0] : stocked.length === 0 && singles.length === 1 ? singles[0] : null;
    if (pick) hubByGtin.set(g, pick.id); else dupSkipped++;
  }

  const existing = await ctx.pool.query<{ id: number; variant_id: string; shopify_variant_id: string; shopify_product_id: string; shopify_inventory_item_id: string | null }>(
    `SELECT id, variant_id, shopify_variant_id, shopify_product_id, shopify_inventory_item_id
     FROM shopify_variant_links WHERE company_id = $1 AND shop_domain = $2`,
    [companyId, shop],
  );
  const bySvid = new Map(existing.rows.map((l) => [l.shopify_variant_id, l]));
  const stillInStore = new Set<string>();

  type NewLink = { vid: string; pid: string; svid: string; inv: string | null; p: number; c: number | null };
  const added: NewLink[] = [];
  const repointed: (NewLink & { id: number })[] = [];
  const unmatched: number[] = [];

  const total = await ctx.connectors.shopify.bulkReadVariants((row) => {
    const g = normalizeGtin(row.barcode);
    const vid = g ? hubByGtin.get(g) : undefined;
    const ex = bySvid.get(row.variantId);
    if (ex) stillInStore.add(row.variantId);
    if (!vid) { if (ex) unmatched.push(ex.id); return; }
    const link = { vid, pid: row.productId, svid: row.variantId, inv: row.inventoryItemId, p: row.priceCents, c: row.compareAtCents };
    if (!ex) added.push(link);
    else if (ex.variant_id !== vid || ex.shopify_product_id !== row.productId || ex.shopify_inventory_item_id !== row.inventoryItemId) repointed.push({ ...link, id: ex.id });
  });

  if (total === 0) {
    await logError(ctx.pool, { companyId, source: 'job:shopify.link_store', message: 'Shopify bulk read returned 0 variants — nothing changed' }).catch(() => {});
    return { shop, storeVariants: 0, skipped: 'empty store read' };
  }

  const gone = existing.rows.filter((l) => !stillInStore.has(l.shopify_variant_id)).map((l) => l.id);
  const toRemove = [...unmatched, ...gone];
  let removalsSkipped = false;
  if (existing.rows.length > 0 && toRemove.length > existing.rows.length * 0.2) {
    removalsSkipped = true;
    await logError(ctx.pool, {
      companyId, source: 'job:shopify.link_store',
      message: `Would remove ${toRemove.length} of ${existing.rows.length} UPC links (>20%) — removals skipped, please review`,
    }).catch(() => {});
  }

  for (let i = 0; i < added.length; i += 2000) {
    await ctx.pool.query(
      `INSERT INTO shopify_variant_links (company_id, shop_domain, variant_id, shopify_product_id, shopify_variant_id, shopify_inventory_item_id,
                                          match_method, last_price_cents, last_compare_at_cents)
       SELECT $1, $2, r.vid, r.pid, r.svid, r.inv, 'barcode', r.p, r.c
       FROM jsonb_to_recordset($3::jsonb) AS r(vid uuid, pid text, svid text, inv text, p int, c int)
       ON CONFLICT (company_id, shop_domain, shopify_variant_id) DO NOTHING`,
      [companyId, shop, JSON.stringify(added.slice(i, i + 2000))],
    );
  }
  if (repointed.length) {
    await ctx.pool.query(
      `UPDATE shopify_variant_links l
       SET variant_id = r.vid, shopify_product_id = r.pid, shopify_inventory_item_id = r.inv,
           last_price_cents = r.p, last_compare_at_cents = r.c, last_qty_by_location = '{}'::jsonb, updated_at = now()
       FROM jsonb_to_recordset($1::jsonb) AS r(id bigint, vid uuid, pid text, inv text, p int, c int) WHERE l.id = r.id`,
      [JSON.stringify(repointed)],
    );
  }
  if (!removalsSkipped && toRemove.length) {
    await ctx.pool.query(`DELETE FROM shopify_variant_links WHERE company_id = $1 AND id = ANY($2::bigint[])`, [companyId, toRemove]);
  }

  const toPush = [...new Set([...added, ...repointed].map((l) => l.vid))];
  if (toPush.length) {
    await ctx.pool.query(
      `INSERT INTO outbound_sync_staging (company_id, variant_id, stream, decision, hold_reasons, shopify_payload, status, updated_at)
       SELECT $1, vid, 'availability', 'ready_for_shopify', '[]'::jsonb, '{"trigger":"upc_link"}'::jsonb, 'pending', now()
       FROM unnest($2::uuid[]) AS vid
       ON CONFLICT (company_id, variant_id, stream) DO UPDATE SET decision = 'ready_for_shopify', hold_reasons = '[]'::jsonb, status = 'pending', last_error = NULL, updated_at = now()`,
      [companyId, toPush],
    );
    await enqueue(ctx.pool, { companyId, type: 'pipeline.flush_shopify', payload: { trigger: 'upc_link' } });
  }

  const summary = {
    shop, storeVariants: total, linksBefore: existing.rows.length, added: added.length, repointed: repointed.length,
    removed: removalsSkipped ? 0 : toRemove.length, removalsSkipped, duplicateUpcsSkipped: dupSkipped,
  };
  await audit(ctx.pool, { companyId, action: 'shopify.upc_links_refreshed', detail: summary });
  return summary;
}
