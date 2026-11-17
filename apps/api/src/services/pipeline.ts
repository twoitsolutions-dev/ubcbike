import {
  DEFAULT_SYNC_CADENCES,
  type MapException,
  type SyncStream,
} from '@ubc/shared';
import {
  evaluateFeedWatchdog,
  isStreamDue,
  type ShopifyCleanVariantPayload,
} from '@ubc/business-rules';
import type { Pool, PoolClient } from '@ubc/database';
import { audit, logError } from './audit.js';
import type { AppContext } from './context.js';
import { enqueue } from './jobs.js';

type Q = Pool | PoolClient;

export async function activeMapExceptions(db: Q, companyId: string): Promise<MapException[]> {
  const r = await db.query<{ variant_id: string; approved_by: string; reference: string; valid_until: Date }>(
    `SELECT variant_id, approved_by, reference, valid_until
     FROM map_exceptions WHERE company_id = $1 AND valid_until > now()`,
    [companyId],
  );
  return r.rows.map((x) => ({
    itemId: x.variant_id,
    approvedBy: x.approved_by,
    reference: x.reference,
    validUntil: new Date(x.valid_until).toISOString(),
  }));
}

/**
 * Flushes validated (`ready_for_shopify`) items from the Processing Buffer
 * (`outbound_sync_staging`) to Shopify:
 *  - Automatically creates/updates NEW products & variants on Shopify via `upsertProduct` (`productSet`)
 *    when canonical items promoted from QBP, JBI, Specialized, or Lightspeed POS do not yet have a Shopify GID.
 *  - Pushes clean `ubc.*` metafields (`availability`, `lead_time_days`, `click_and_collect_only`) & `on_hand` stock.
 *  - Self-chains in 250-item checkpoints up to 60,000+ SKUs so massive catalog pushes never time out.
 */
export async function flushStagedToShopifyJob(
  ctx: AppContext,
  companyId: string,
  opts: { limit?: number; chainDepth?: number } = {},
) {
  const limit = opts.limit ?? 250;
  const chainDepth = opts.chainDepth ?? 0;

  if (ctx.config.env.SHOPIFY_SYNC_MODE === 'update_only') {
    return flushUpdateOnlyToShopify(ctx, companyId, { limit, chainDepth });
  }

  const rows = await ctx.pool.query<{
    id: number;
    variant_id: string;
    product_id: string;
    product_title: string;
    brand: string;
    category: string;
    description: string;
    images: string[];
    product_status: string;
    sku: string;
    shopify_payload: ShopifyCleanVariantPayload;
    shopify_product_id: string | null;
    shopify_variant_id: string | null;
    shopify_inventory_item_id: string | null;
    shopify_location_id: string | null;
  }>(
    `SELECT oss.id, oss.variant_id, v.product_id, p.title AS product_title, p.brand, p.category,
            p.description, p.images, p.status AS product_status, v.sku, oss.shopify_payload,
            (SELECT e.external_id FROM external_ids e WHERE e.company_id = oss.company_id AND e.entity_type = 'product' AND e.entity_id = v.product_id AND e.system = 'shopify') AS shopify_product_id,
            (SELECT e.external_id FROM external_ids e WHERE e.company_id = oss.company_id AND e.entity_type = 'variant' AND e.entity_id = oss.variant_id AND e.system = 'shopify') AS shopify_variant_id,
            (SELECT l.shopify_location_id FROM locations l WHERE l.company_id = oss.company_id AND l.kind = 'physical' ORDER BY l.name LIMIT 1) AS shopify_location_id,
            (SELECT e.external_id FROM external_ids e WHERE e.company_id = oss.company_id AND e.entity_type = 'variant' AND e.entity_id = oss.variant_id AND e.system = 'shopify_inventory_item') AS shopify_inventory_item_id
     FROM outbound_sync_staging oss
     JOIN variants v ON v.id = oss.variant_id
     JOIN products p ON p.id = v.product_id
     WHERE oss.company_id = $1 AND oss.status = 'pending' AND oss.decision = 'ready_for_shopify'
     ORDER BY oss.updated_at ASC
     LIMIT $2`,
    [companyId, limit],
  );

  if (!rows.rows.length) {
    return { pushed: 0, createdProducts: 0, skippedUnlinked: 0, deferredWritesDisabled: 0 };
  }

  if (ctx.config.mode === 'live' && !ctx.config.env.SHOPIFY_WRITES_ENABLED) {
    return { pushed: 0, createdProducts: 0, skippedUnlinked: 0, deferredWritesDisabled: rows.rows.length };
  }

  // 1. Auto-create/upsert any staged products that do not yet exist in Shopify!
  const unlinkedByProduct = new Map<string, typeof rows.rows>();
  for (const r of rows.rows) {
    if (!r.shopify_variant_id) {
      const list = unlinkedByProduct.get(r.product_id) ?? [];
      list.push(r);
      unlinkedByProduct.set(r.product_id, list);
    }
  }

  let createdProducts = 0;
  const failedStagingIds = new Set<number>();

  if (unlinkedByProduct.size > 0) {
    type SiblingRow = {
      id: string;
      product_id: string;
      sku: string;
      upc: string | null;
      price_cents: number;
      compare_at_cents: number | null;
      cost_cents: number | null;
      option_values: Record<string, string>;
      on_hand: number;
    };
    const allSiblings = await ctx.pool.query<SiblingRow>(
      `SELECT v.id, v.product_id, v.sku, v.upc, v.price_cents, v.compare_at_cents, v.cost_cents, v.option_values,
              COALESCE((SELECT sum(il.on_hand)::int FROM inventory_levels il WHERE il.variant_id = v.id), 0) AS on_hand
       FROM variants v
       WHERE v.company_id = $1 AND v.product_id = ANY($2::uuid[])
       ORDER BY v.created_at ASC`,
      [companyId, [...unlinkedByProduct.keys()]],
    );
    const siblingsByProd = new Map<string, SiblingRow[]>();
    for (const sv of allSiblings.rows) {
      const arr = siblingsByProd.get(sv.product_id) ?? [];
      arr.push(sv);
      siblingsByProd.set(sv.product_id, arr);
    }

    const extIdBatch: { et: string; eid: string; sys: string; ext: string }[] = [];

    for (const [productId, stagedGroup] of unlinkedByProduct) {
      const head = stagedGroup[0]!;
      const prodSiblings = siblingsByProd.get(productId) ?? [];
      try {
        const stagedByVarId = new Map(stagedGroup.map((g) => [g.variant_id, g.shopify_payload]));
        const upserted = await ctx.connectors.shopify.upsertProduct({
          existingProductId: head.shopify_product_id,
          title: head.product_title,
          vendor: head.brand,
          productType: head.category,
          descriptionHtml: head.description || undefined,
          status: head.product_status === 'published' ? 'ACTIVE' : 'DRAFT',
          tags: [head.brand, head.category].filter(Boolean),
          imageUrls: Array.isArray(head.images) ? head.images : [],
          locationId: head.shopify_location_id,
          variants: prodSiblings.map((sv) => {
            const sp = stagedByVarId.get(sv.id);
            return {
              sku: sv.sku,
              barcode: sv.upc,
              priceCents: sv.price_cents,
              compareAtCents: sv.compare_at_cents,
              costCents: sv.cost_cents,
              optionValues: sv.option_values ?? {},
              availability: sp?.availability ?? (sv.on_hand > 0 ? 'in_stock' : 'unavailable'),
              onHandQty: sp?.publishedQty ?? sv.on_hand,
            };
          }),
        });

        createdProducts++;
        extIdBatch.push({ et: 'product', eid: productId, sys: 'shopify', ext: upserted.productId });

        const varIdBySku = new Map(prodSiblings.map((sv) => [sv.sku, sv.id]));
        for (const uv of upserted.variants) {
          const canonicalVid = varIdBySku.get(uv.sku);
          if (!canonicalVid) continue;
          extIdBatch.push({ et: 'variant', eid: canonicalVid, sys: 'shopify', ext: uv.variantId });
          if (uv.inventoryItemId) {
            extIdBatch.push({ et: 'variant', eid: canonicalVid, sys: 'shopify_inventory_item', ext: uv.inventoryItemId });
          }
          for (const sg of stagedGroup) {
            if (sg.variant_id === canonicalVid) {
              sg.shopify_variant_id = uv.variantId;
              sg.shopify_inventory_item_id = uv.inventoryItemId;
            }
          }
        }
      } catch (err) {
        const msg = (err as Error).message;
        for (const sg of stagedGroup) failedStagingIds.add(sg.id);
        await ctx.pool.query(
          `UPDATE outbound_sync_staging SET last_error = $2, updated_at = now()
           WHERE company_id = $1 AND id = ANY($3::bigint[])`,
          [companyId, msg, stagedGroup.map((s) => s.id)],
        );
      }
    }

    if (extIdBatch.length > 0) {
      await ctx.pool.query(
        `INSERT INTO external_ids (company_id, entity_type, entity_id, system, external_id)
         SELECT $1, r.et, r.eid, r.sys, r.ext
         FROM jsonb_to_recordset($2::jsonb) AS r(et text, eid uuid, sys text, ext text)
         ON CONFLICT (company_id, system, entity_type, entity_id) DO UPDATE SET external_id = EXCLUDED.external_id`,
        [companyId, JSON.stringify(extIdBatch)],
      );
    }
  }

  // 2. Push fulfillment metafields & physical on-hand stock for all linked variants.
  const linked = rows.rows.filter((r) => r.shopify_variant_id && !failedStagingIds.has(r.id));
  for (let i = 0; i < linked.length; i += 25) {
    const chunk = linked.slice(i, i + 25);
    await ctx.connectors.shopify.setVariantFulfillmentMetafields(
      chunk.map((r) => ({
        variantId: r.shopify_variant_id!,
        availability: r.shopify_payload.availability,
        leadTimeDays: r.shopify_payload.leadTimeDays,
        clickAndCollectOnly: r.shopify_payload.clickAndCollectOnly,
      })),
    );
  }

  const withInv = linked.filter((r) => r.shopify_inventory_item_id && r.shopify_location_id);
  const byLocation = new Map<string, { inventoryItemId: string; quantity: number }[]>();
  for (const r of withInv) {
    const arr = byLocation.get(r.shopify_location_id!) ?? [];
    arr.push({ inventoryItemId: r.shopify_inventory_item_id!, quantity: r.shopify_payload.publishedQty });
    byLocation.set(r.shopify_location_id!, arr);
  }
  for (const [locId, quantities] of byLocation) {
    await ctx.connectors.shopify.setInventoryOnHand(locId, quantities);
  }

  const pushedIds = rows.rows.filter((r) => !failedStagingIds.has(r.id)).map((r) => r.id);
  if (pushedIds.length > 0) {
    await ctx.pool.query(
      `UPDATE outbound_sync_staging SET status = 'pushed', pushed_at = now(), updated_at = now(), last_error = NULL
       WHERE company_id = $1 AND id = ANY($2::bigint[])`,
      [companyId, pushedIds],
    );
  }

  // 3. Self-chain next 250-item batch when flushing 10k–40k+ SKUs!
  let chainedNext = false;
  if (rows.rows.length === limit && chainDepth < 250 && pushedIds.length > 0) {
    const more = await ctx.pool.query(
      `SELECT 1 FROM outbound_sync_staging
       WHERE company_id = $1 AND status = 'pending' AND decision = 'ready_for_shopify' LIMIT 1`,
      [companyId],
    );
    if (more.rowCount) {
      await enqueue(ctx.pool, {
        companyId,
        type: 'pipeline.flush_shopify',
        payload: { chainDepth: chainDepth + 1, limit },
      });
      chainedNext = true;
    }
  }

  await audit(ctx.pool, {
    companyId,
    action: 'pipeline.flushed_to_shopify',
    detail: {
      totalStaged: rows.rows.length,
      pushedToShopify: linked.length,
      createdProducts,
      failedCount: failedStagingIds.size,
      chainedNext,
    },
  });

  return {
    pushed: linked.length,
    createdProducts,
    skippedUnlinked: rows.rows.length - linked.length,
    chainedNext,
  };
}

/**
 * Observability watchdog + tiered cadence check across all tenants (`companies`).
 *  - Detects silent supplier feeds (e.g. JBI silent > 48h) and logs one open
 *    alert per supplier/day in `error_log` without spamming duplicates.
 *  - Enqueues due live connector syncs when connectors are configured & connected.
 */
export async function runPipelineWatchdogAndSchedules(ctx: AppContext, now: Date = new Date()) {
  const companies = await ctx.pool.query<{ id: string }>(`SELECT id FROM companies`);
  let alertsRaised = 0;
  let jobsScheduled = 0;

  for (const comp of companies.rows) {
    const supRows = await ctx.pool.query<{
      id: string;
      code: string;
      name: string;
      is_active: boolean;
      last_report: Date | null;
      max_silence_hours: number | null;
    }>(
      `SELECT s.id, s.code, s.name, s.is_active,
              GREATEST(max(so.reported_at), max(sss.last_success_at)) AS last_report,
              max(sss.max_silence_hours) FILTER (WHERE sss.stream = 'full_catalog') AS max_silence_hours
       FROM suppliers s
       LEFT JOIN supplier_offers so ON so.supplier_id = s.id
       LEFT JOIN supplier_sync_schedules sss ON sss.supplier_id = s.id
       WHERE s.company_id = $1
       GROUP BY s.id`,
      [comp.id],
    );

    const reports = evaluateFeedWatchdog(
      supRows.rows.map((r) => ({
        supplierCode: r.code,
        supplierName: r.name,
        isActive: r.is_active,
        lastReportAt: r.last_report,
        maxSilenceHours: r.max_silence_hours ?? DEFAULT_SYNC_CADENCES.full_catalog.maxSilenceHours,
      })),
      now,
    );

    for (const rep of reports) {
      if (rep.status !== 'stalled') continue;
      const sup = supRows.rows.find((s) => s.code === rep.supplierCode);
      if (sup) {
        await ctx.pool.query(
          `UPDATE supplier_sync_schedules SET last_status = 'stalled', updated_at = now()
           WHERE company_id = $1 AND supplier_id = $2 AND stream = 'full_catalog'`,
          [comp.id, sup.id],
        );
      }
      // Deduplicate open watchdog alerts per supplier alertKey.
      const existing = await ctx.pool.query<{ id: number }>(
        `SELECT id FROM error_log
         WHERE company_id = $1 AND source = 'watchdog:supplier_feed' AND resolved_at IS NULL
           AND context->>'alertKey' = $2 LIMIT 1`,
        [comp.id, rep.alertKey],
      );
      if (!existing.rowCount) {
        await logError(ctx.pool, {
          companyId: comp.id,
          source: 'watchdog:supplier_feed',
          message: rep.message,
          context: { supplierCode: rep.supplierCode, hoursSilent: rep.hoursSilent, maxSilenceHours: rep.maxSilenceHours, alertKey: rep.alertKey },
        });
        alertsRaised++;
      }
    }

    // Check scheduled sync streams (15–30m availability, 6–12h costs, 24h content) in LIVE mode.
    if (ctx.config.mode === 'live') {
      const scheds = await ctx.pool.query<{
        id: string;
        supplier_id: string;
        code: string;
        stream: SyncStream;
        interval_minutes: number | null;
        last_success_at: Date | null;
      }>(
        `SELECT sss.id, sss.supplier_id, s.code, sss.stream, sss.interval_minutes, sss.last_success_at
         FROM supplier_sync_schedules sss JOIN suppliers s ON s.id = sss.supplier_id
         WHERE sss.company_id = $1 AND sss.enabled = true AND s.is_active = true AND sss.interval_minutes IS NOT NULL`,
        [comp.id],
      );
      for (const sc of scheds.rows) {
        if (!isStreamDue(sc.stream, sc.last_success_at, now, sc.interval_minutes)) continue;
        const connector = ctx.connectors.suppliers.get(sc.code);
        const health = await connector?.health();
        if (health?.status !== 'connected') continue;
        const bucket = Math.floor(now.getTime() / ((sc.interval_minutes ?? 20) * 60_000));
        const job = await enqueue(ctx.pool, {
          companyId: comp.id,
          type: 'pipeline.flush_shopify',
          payload: { trigger: `${sc.code}:${sc.stream}` },
          idempotencyKey: `sched:${sc.code}:${sc.stream}:${bucket}`,
        });
        if (job.created) jobsScheduled++;
      }

      // Automatic 5-minute incremental Lightspeed R-Series POS stock & special-order sync once OAuth is connected.
      if (ctx.connectors.lightspeed) await ctx.connectors.lightspeed.ensureConfigured();
      if (ctx.connectors.lightspeed && ctx.connectors.lightspeed.missing().length === 0) {
        const lsBucket = Math.floor(now.getTime() / (5 * 60_000));
        const j1 = await enqueue(ctx.pool, {
          companyId: comp.id,
          type: 'lightspeed.sync_catalog',
          payload: { full: false },
          idempotencyKey: `sched:lightspeed:catalog:${lsBucket}`,
        });
        if (j1.created) jobsScheduled++;
      }

      // update_only store: re-check every 30 min that nobody (e.g. Workstand) overwrote the Lightspeed prices.
      if (ctx.config.env.SHOPIFY_SYNC_MODE === 'update_only' && ctx.config.env.SHOPIFY_WRITES_ENABLED) {
        const rcBucket = Math.floor(now.getTime() / (30 * 60_000));
        const j2 = await enqueue(ctx.pool, {
          companyId: comp.id,
          type: 'shopify.reconcile_links',
          payload: {},
          idempotencyKey: `sched:shopify:reconcile:${rcBucket}`,
        });
        if (j2.created) jobsScheduled++;
        // Nightly at 07:00 UTC (2–3 AM in Tampa): refresh the UPC links so new Lightspeed items and new
        // Workstand catalog products start syncing on their own.
        if (now.getUTCHours() === 7) {
          const j3 = await enqueue(ctx.pool, {
            companyId: comp.id,
            type: 'shopify.link_store',
            payload: {},
            idempotencyKey: `sched:shopify:link_store:${now.toISOString().slice(0, 10)}`,
          });
          if (j3.created) jobsScheduled++;
        }
      }
    }
  }

  return { alertsRaised, jobsScheduled };
}

export async function getPipelineStatus(ctx: AppContext, companyId: string) {
  const [schedules, recentRuns, stagingCounts, supHeartbeats] = await Promise.all([
    ctx.pool.query(
      `SELECT sss.id, s.code AS supplier_code, s.name AS supplier_name, sss.stream, sss.interval_minutes,
              sss.max_silence_hours, sss.enabled, sss.last_run_at, sss.last_success_at, sss.last_status
       FROM supplier_sync_schedules sss JOIN suppliers s ON s.id = sss.supplier_id
       WHERE sss.company_id = $1 ORDER BY s.code, sss.stream`,
      [companyId],
    ),
    ctx.pool.query(
      `SELECT r.id, s.code AS supplier_code, r.stream, r.status, r.records_seen, r.records_changed,
              r.staged_ready, r.staged_held, r.error, r.started_at, r.finished_at
       FROM supplier_sync_runs r JOIN suppliers s ON s.id = r.supplier_id
       WHERE r.company_id = $1 ORDER BY r.started_at DESC LIMIT 30`,
      [companyId],
    ),
    ctx.pool.query<{ status: string; decision: string; n: number }>(
      `SELECT status, decision, count(*)::int AS n
       FROM outbound_sync_staging WHERE company_id = $1 GROUP BY status, decision`,
      [companyId],
    ),
    ctx.pool.query<{ code: string; name: string; is_active: boolean; last_report: Date | null; max_silence_hours: number | null }>(
      `SELECT s.code, s.name, s.is_active,
              GREATEST(max(so.reported_at), max(sss.last_success_at)) AS last_report,
              max(sss.max_silence_hours) FILTER (WHERE sss.stream = 'full_catalog') AS max_silence_hours
       FROM suppliers s
       LEFT JOIN supplier_offers so ON so.supplier_id = s.id
       LEFT JOIN supplier_sync_schedules sss ON sss.supplier_id = s.id
       WHERE s.company_id = $1 GROUP BY s.id ORDER BY s.code`,
      [companyId],
    ),
  ]);

  const watchdog = evaluateFeedWatchdog(
    supHeartbeats.rows.map((r) => ({
      supplierCode: r.code,
      supplierName: r.name,
      isActive: r.is_active,
      lastReportAt: r.last_report,
      maxSilenceHours: r.max_silence_hours ?? DEFAULT_SYNC_CADENCES.full_catalog.maxSilenceHours,
    })),
  );

  return {
    cadences: DEFAULT_SYNC_CADENCES,
    schedules: schedules.rows,
    watchdog,
    stagingSummary: stagingCounts.rows,
    recentRuns: recentRuns.rows,
  };
}

/**
 * Crossed-out price shown in Shopify: during an active price-update promo it is the regular price
 * before the promo (or Lightspeed's Default if higher); otherwise Lightspeed's Default while on SALE PRICE.
 */
const EFFECTIVE_COMPARE_AT = `COALESCE((
  SELECT GREATEST(cl.old_price_cents, COALESCE(v.compare_at_cents, 0))
  FROM campaign_lines cl JOIN campaigns cp ON cp.id = cl.campaign_id
  WHERE cl.variant_id = v.id AND cp.status = 'active' AND cp.strategy = 'variant_price_update'
    AND cl.applied_at IS NOT NULL AND cl.restored_at IS NULL
  ORDER BY cl.applied_at DESC LIMIT 1), v.compare_at_cents)`;

/**
 * update_only: every 2 h read the CURRENT price of every linked variant in the store. If something
 * else (e.g. the Workstand app) changed it away from the Lightspeed price, re-queue it so the next
 * flush puts the Lightspeed price back. Read-only against Shopify; logs how many drifted.
 */
export async function reconcileShopifyLinksJob(ctx: AppContext, companyId: string) {
  if (ctx.config.env.SHOPIFY_SYNC_MODE !== 'update_only') return { skipped: 'not update_only' };
  const shop = String(ctx.config.env.SHOPIFY_SHOP_DOMAIN ?? '').toLowerCase();
  const links = await ctx.pool.query<{
    id: number; variant_id: string; shopify_variant_id: string; shopify_inventory_item_id: string | null;
    price_cents: number; compare_at_cents: number | null; map_cents: number | null;
  }>(
    `SELECT l.id, l.variant_id, l.shopify_variant_id, l.shopify_inventory_item_id, v.price_cents, ${EFFECTIVE_COMPARE_AT} AS compare_at_cents, v.map_cents
     FROM shopify_variant_links l JOIN variants v ON v.id = l.variant_id
     WHERE l.company_id = $1 AND l.shop_domain = $2`,
    [companyId, shop],
  );
  const locMap = parseLocationMap(ctx.config.env.SHOPIFY_LOCATION_MAP);
  const checkStock = ctx.config.env.SHOPIFY_PUSH_STOCK !== false && locMap.size > 0;
  let checked = 0;
  let drifted = 0;
  let stockDrifted = 0;
  let missing = 0;
  const requeue = new Set<string>();
  for (let i = 0; i < links.rows.length; i += 250) {
    const chunk = links.rows.slice(i, i + 250);
    if (checkStock) {
      // Stock per physical store: compare Shopify on-hand with Lightspeed for each mapped location.
      const withInv = chunk.filter((l) => l.shopify_inventory_item_id);
      const [inv, hubQty] = await Promise.all([
        ctx.connectors.shopify.getInventoryOnHand(withInv.map((l) => l.shopify_inventory_item_id!)),
        qtyByShop(ctx, companyId, withInv.map((l) => l.variant_id)),
      ]);
      const seen: { id: number; q: Record<string, number> }[] = [];
      for (const l of withInv) {
        const cur = inv.get(l.shopify_inventory_item_id!);
        if (!cur) continue;
        const actual: Record<string, number> = {};
        let differs = false;
        for (const [lsShop, gid] of locMap) {
          const have = cur[gid] ?? -1; // -1 = not stocked at that location yet
          const want = (hubQty.get(l.variant_id) ?? {})[lsShop] ?? 0;
          actual[gid] = have;
          if (have === -1 ? want > 0 : have !== want) differs = true;
        }
        seen.push({ id: l.id, q: actual });
        if (differs) { stockDrifted++; requeue.add(l.variant_id); }
      }
      if (seen.length) {
        await ctx.pool.query(
          `UPDATE shopify_variant_links l SET last_qty_by_location = r.q, updated_at = now()
           FROM jsonb_to_recordset($1::jsonb) AS r(id bigint, q jsonb) WHERE l.id = r.id`,
          [JSON.stringify(seen)],
        );
      }
    }
    const current = await ctx.connectors.shopify.getVariantPrices(chunk.map((l) => l.shopify_variant_id));
    const byId = new Map(current.map((c) => [c.variantId, c]));
    const updates: { id: number; p: number; c: number | null }[] = [];
    for (const l of chunk) {
      const cur = byId.get(l.shopify_variant_id);
      if (!cur) { missing++; continue; }
      checked++;
      updates.push({ id: l.id, p: cur.priceCents, c: cur.compareAtCents });
      const want = l.price_cents;
      const wantC = l.compare_at_cents && l.compare_at_cents > want ? l.compare_at_cents : null;
      if (want > 0 && !(l.map_cents && want < l.map_cents) && (cur.priceCents !== want || cur.compareAtCents !== wantC)) {
        drifted++;
        requeue.add(l.variant_id);
      }
    }
    // Remember what the store really has, so the flush re-sends exactly the drifted ones.
    if (updates.length) {
      await ctx.pool.query(
        `UPDATE shopify_variant_links l SET last_price_cents = r.p, last_compare_at_cents = r.c, updated_at = now()
         FROM jsonb_to_recordset($1::jsonb) AS r(id bigint, p int, c int) WHERE l.id = r.id`,
        [JSON.stringify(updates)],
      );
    }
  }
  if (requeue.size) {
    await ctx.pool.query(
      `INSERT INTO outbound_sync_staging (company_id, variant_id, stream, decision, hold_reasons, shopify_payload, status, updated_at)
       SELECT $1, vid, 'availability', 'ready_for_shopify', '[]'::jsonb, '{"trigger":"reconcile"}'::jsonb, 'pending', now()
       FROM unnest($2::uuid[]) AS vid
       ON CONFLICT (company_id, variant_id, stream) DO UPDATE SET decision = 'ready_for_shopify', hold_reasons = '[]'::jsonb, status = 'pending', last_error = NULL, updated_at = now()`,
      [companyId, [...requeue]],
    );
    await enqueue(ctx.pool, { companyId, type: 'pipeline.flush_shopify', payload: { trigger: 'reconcile' } });
  }
  const summary = { shop, linked: links.rows.length, checked, drifted, stockDrifted, missing };
  await audit(ctx.pool, { companyId, action: 'pipeline.shopify_prices_reconciled', detail: summary });
  return summary;
}

type UpdateOnlyLink = {
  id: number; variant_id: string; shopify_product_id: string; shopify_variant_id: string; shopify_inventory_item_id: string | null;
  last_price_cents: number | null; last_compare_at_cents: number | null; last_qty: number | null;
  last_qty_by_location: Record<string, number>;
};

/** "1=gid://shopify/Location/111,2=gid://shopify/Location/222" → Map(lightspeedShopId → Shopify location GID). */
export function parseLocationMap(raw: string | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const part of String(raw ?? '').split(',')) {
    const [shop, gid] = part.split('=').map((s) => s?.trim());
    if (shop && gid?.startsWith('gid://shopify/Location/')) m.set(shop, gid);
  }
  return m;
}

/** Physical on-hand per Lightspeed shop for each variant: variantId → { shopId → qty }. */
async function qtyByShop(ctx: AppContext, companyId: string, variantIds: string[]) {
  const r = await ctx.pool.query<{ variant_id: string; shop: string; qty: number }>(
    `SELECT il.variant_id, l.lightspeed_shop_id AS shop, sum(il.on_hand)::int AS qty
     FROM inventory_levels il JOIN locations l ON l.id = il.location_id
     WHERE il.company_id = $1 AND il.variant_id = ANY($2::uuid[]) AND l.kind = 'physical' AND l.lightspeed_shop_id IS NOT NULL
     GROUP BY il.variant_id, l.lightspeed_shop_id`,
    [companyId, variantIds],
  );
  const out = new Map<string, Record<string, number>>();
  for (const x of r.rows) out.set(x.variant_id, { ...(out.get(x.variant_id) ?? {}), [x.shop]: Math.max(0, x.qty) });
  return out;
}

/**
 * SHOPIFY_SYNC_MODE=update_only (UBC's real store, catalog owned by the Workstand app).
 * For every staged Lightspeed change, update ONLY price / sale price (compare-at) and physical stock
 * of the Shopify variants linked by barcode in `shopify_variant_links`. Never creates products.
 *  - Price = Lightspeed SALE PRICE when active, else Default; compare-at = Default while on sale.
 *  - Never pushes a price below MAP (the row is held for review instead).
 *  - Only sends what changed vs. the last value written/seen, and logs every price it replaces.
 */
export async function flushUpdateOnlyToShopify(
  ctx: AppContext,
  companyId: string,
  opts: { limit: number; chainDepth: number },
) {
  const shop = String(ctx.config.env.SHOPIFY_SHOP_DOMAIN ?? '').toLowerCase();
  // Stock goes per physical store: Lightspeed shop → its Shopify location (other locations untouched).
  const locMap = parseLocationMap(ctx.config.env.SHOPIFY_LOCATION_MAP);
  const pushStock = ctx.config.env.SHOPIFY_PUSH_STOCK !== false && locMap.size > 0;

  const rows = await ctx.pool.query<{
    id: number; variant_id: string; price_cents: number | null; compare_at_cents: number | null; map_cents: number | null; on_hand: number;
  }>(
    `SELECT oss.id, oss.variant_id, v.price_cents, ${EFFECTIVE_COMPARE_AT} AS compare_at_cents, v.map_cents,
            COALESCE((SELECT sum(il.on_hand)::int FROM inventory_levels il WHERE il.variant_id = v.id), 0) AS on_hand
     FROM outbound_sync_staging oss JOIN variants v ON v.id = oss.variant_id
     WHERE oss.company_id = $1 AND oss.status = 'pending' AND oss.decision = 'ready_for_shopify'
     ORDER BY oss.updated_at ASC LIMIT $2`,
    [companyId, opts.limit],
  );
  if (!rows.rows.length) return { mode: 'update_only', pushed: 0, pricesChanged: 0, stockChanged: 0, notInStore: 0, heldMap: 0 };
  if (ctx.config.mode === 'live' && !ctx.config.env.SHOPIFY_WRITES_ENABLED) {
    return { mode: 'update_only', pushed: 0, deferredWritesDisabled: rows.rows.length };
  }

  const links = await ctx.pool.query<UpdateOnlyLink>(
    `SELECT id, variant_id, shopify_product_id, shopify_variant_id, shopify_inventory_item_id, last_price_cents, last_compare_at_cents, last_qty, last_qty_by_location
     FROM shopify_variant_links WHERE company_id = $1 AND shop_domain = $2 AND variant_id = ANY($3::uuid[])`,
    [companyId, shop, rows.rows.map((r) => r.variant_id)],
  );
  const shopQty = pushStock ? await qtyByShop(ctx, companyId, rows.rows.map((r) => r.variant_id)) : new Map<string, Record<string, number>>();
  const linksByVariant = new Map<string, UpdateOnlyLink[]>();
  for (const l of links.rows) {
    const arr = linksByVariant.get(l.variant_id) ?? [];
    arr.push(l);
    linksByVariant.set(l.variant_id, arr);
  }

  const notInStore: number[] = [];
  const heldMap: number[] = [];
  const okRows = new Set<number>();
  const priceByProduct = new Map<string, { link: UpdateOnlyLink; price: number; compareAt: number | null }[]>();
  const stockByLocation = new Map<string, { link: UpdateOnlyLink; qty: number }[]>();

  for (const r of rows.rows) {
    const ls = linksByVariant.get(r.variant_id);
    if (!ls?.length) { notInStore.push(r.id); continue; }
    const price = r.price_cents ?? 0;
    const belowMap = price > 0 && !!r.map_cents && price < r.map_cents;
    if (belowMap) heldMap.push(r.id); // price held for review; stock still syncs
    const compareAt = r.compare_at_cents && r.compare_at_cents > price ? r.compare_at_cents : null;
    for (const link of ls) {
      if (!belowMap && price > 0 && (price !== link.last_price_cents || compareAt !== (link.last_compare_at_cents ?? null))) {
        const arr = priceByProduct.get(link.shopify_product_id) ?? [];
        arr.push({ link, price, compareAt });
        priceByProduct.set(link.shopify_product_id, arr);
      }
      if (pushStock && link.shopify_inventory_item_id) {
        const byShop = shopQty.get(r.variant_id) ?? {};
        for (const [lsShop, gid] of locMap) {
          const want = byShop[lsShop] ?? 0;
          const last = (link.last_qty_by_location ?? {})[gid];
          // Unknown (-1 / never read) location with 0 wanted: nothing to do — never activate a location just to write 0.
          if (want === 0 && (last === undefined || last === -1)) continue;
          if (want !== last) {
            const arr = stockByLocation.get(gid) ?? [];
            arr.push({ link, qty: want });
            stockByLocation.set(gid, arr);
          }
        }
      }
    }
    if (!belowMap) okRows.add(r.id);
  }

  const failedVariantIds = new Set<string>();
  let pricesChanged = 0;
  for (const [productId, ups] of priceByProduct) {
    try {
      await ctx.connectors.shopify.updateVariantPrices(productId, ups.map((u) => ({ variantId: u.link.shopify_variant_id, priceCents: u.price, compareAtCents: u.compareAt })));
      await ctx.pool.query(
        `INSERT INTO shopify_price_log (company_id, shop_domain, variant_id, shopify_variant_id, old_price_cents, old_compare_at_cents, new_price_cents, new_compare_at_cents, source)
         SELECT $1, $2, r.vid, r.svid, r.old_p, r.old_c, r.new_p, r.new_c, 'lightspeed'
         FROM jsonb_to_recordset($3::jsonb) AS r(vid uuid, svid text, old_p int, old_c int, new_p int, new_c int)`,
        [companyId, shop, JSON.stringify(ups.map((u) => ({
          vid: u.link.variant_id, svid: u.link.shopify_variant_id, old_p: u.link.last_price_cents, old_c: u.link.last_compare_at_cents, new_p: u.price, new_c: u.compareAt,
        })))],
      );
      await ctx.pool.query(
        `UPDATE shopify_variant_links l SET last_price_cents = r.p, last_compare_at_cents = r.c, last_pushed_at = now(), updated_at = now()
         FROM jsonb_to_recordset($1::jsonb) AS r(id bigint, p int, c int) WHERE l.id = r.id`,
        [JSON.stringify(ups.map((u) => ({ id: u.link.id, p: u.price, c: u.compareAt })))],
      );
      pricesChanged += ups.length;
    } catch (err) {
      for (const u of ups) failedVariantIds.add(u.link.variant_id);
      await logError(ctx.pool, { companyId, source: 'pipeline:update_only_price', message: (err as Error).message, context: { productId } }).catch(() => {});
    }
  }

  let stockChanged = 0;
  const saveQty = async (gid: string, done: { link: UpdateOnlyLink; qty: number }[]) => {
    if (!done.length) return;
    await ctx.pool.query(
      `UPDATE shopify_variant_links l
       SET last_qty_by_location = l.last_qty_by_location || jsonb_build_object($1::text, r.q), last_pushed_at = now(), updated_at = now()
       FROM jsonb_to_recordset($2::jsonb) AS r(id bigint, q int) WHERE l.id = r.id`,
      [gid, JSON.stringify(done.map((s) => ({ id: s.link.id, q: s.qty })))],
    );
    stockChanged += done.length;
  };
  for (const [gid, items] of stockByLocation) {
    for (let i = 0; i < items.length; i += 100) {
      const chunk = items.slice(i, i + 100);
      try {
        await ctx.connectors.shopify.setInventoryOnHand(gid, chunk.map((s) => ({ inventoryItemId: s.link.shopify_inventory_item_id!, quantity: s.qty })));
        await saveQty(gid, chunk);
      } catch {
        // One bad item (e.g. not stocked at this location) rejects the whole call: retry one by one.
        const ok: typeof chunk = [];
        for (const s of chunk) {
          try {
            const one = [{ inventoryItemId: s.link.shopify_inventory_item_id!, quantity: s.qty }];
            try {
              await ctx.connectors.shopify.setInventoryOnHand(gid, one);
            } catch (e) {
              // Not stocked at this store yet: start stocking it there, but only when Lightspeed has real stock.
              if (s.qty <= 0) throw e;
              await ctx.connectors.shopify.activateInventoryAtLocation(s.link.shopify_inventory_item_id!, gid);
              await ctx.connectors.shopify.setInventoryOnHand(gid, one);
            }
            ok.push(s);
          } catch (err) {
            failedVariantIds.add(s.link.variant_id);
            await logError(ctx.pool, { companyId, source: 'pipeline:update_only_stock', message: (err as Error).message, context: { location: gid, variant: s.link.shopify_variant_id } }).catch(() => {});
          }
        }
        await saveQty(gid, ok);
      }
    }
  }

  const pushedIds = rows.rows.filter((r) => okRows.has(r.id) && !failedVariantIds.has(r.variant_id)).map((r) => r.id);
  const failedIds = rows.rows.filter((r) => okRows.has(r.id) && failedVariantIds.has(r.variant_id)).map((r) => r.id);
  if (pushedIds.length) {
    await ctx.pool.query(
      `UPDATE outbound_sync_staging SET status = 'pushed', pushed_at = now(), updated_at = now(), last_error = NULL WHERE company_id = $1 AND id = ANY($2::bigint[])`,
      [companyId, pushedIds],
    );
  }
  if (failedIds.length) {
    // Stay pending (retried on the next flush) but move to the back of the queue.
    await ctx.pool.query(
      `UPDATE outbound_sync_staging SET last_error = 'Shopify update failed — see error log', updated_at = now() WHERE company_id = $1 AND id = ANY($2::bigint[])`,
      [companyId, failedIds],
    );
  }
  if (notInStore.length) {
    await ctx.pool.query(
      `UPDATE outbound_sync_staging SET status = 'dismissed', last_error = 'Not in this Shopify store (no barcode match)', updated_at = now() WHERE company_id = $1 AND id = ANY($2::bigint[])`,
      [companyId, notInStore],
    );
  }
  if (heldMap.length) {
    await ctx.pool.query(
      `UPDATE outbound_sync_staging SET status = 'held', decision = 'held_for_review', hold_reasons = '["below_map"]'::jsonb, updated_at = now() WHERE company_id = $1 AND id = ANY($2::bigint[])`,
      [companyId, heldMap],
    );
  }

  let chainedNext = false;
  if (rows.rows.length === opts.limit && opts.chainDepth < 500 && pushedIds.length + notInStore.length + heldMap.length > 0) {
    await enqueue(ctx.pool, { companyId, type: 'pipeline.flush_shopify', payload: { chainDepth: opts.chainDepth + 1, limit: opts.limit } });
    chainedNext = true;
  }

  const summary = {
    mode: 'update_only', shop, staged: rows.rows.length, pushed: pushedIds.length, pricesChanged, stockChanged,
    notInStore: notInStore.length, heldMap: heldMap.length, failed: failedIds.length, chainedNext,
  };
  await audit(ctx.pool, { companyId, action: 'pipeline.flushed_to_shopify', detail: summary });
  return summary;
}
