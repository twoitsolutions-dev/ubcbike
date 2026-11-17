import { z } from 'zod';
import type { CatalogItem, PublishStatus, SyncStream } from '@ubc/shared';
import {
  computeAvailability,
  evaluateStagingBuffer,
  findBestMatch,
  formatRetailBarcode,
  normalizeMpn,
  type PreviousOfferSnapshot,
} from '@ubc/business-rules';
import { mapFeed, normalizeCyclingCategory, type FeedMapping, type SupplierCatalogRecord } from '@ubc/integrations';
import { withTransaction } from '@ubc/database';
import { audit } from './audit.js';
import { getSettings, rowToItem } from './catalog.js';
import { notFound, type AppContext } from './context.js';
import { enqueue, setProgress } from './jobs.js';
import { activeMapExceptions } from './pipeline.js';

export const feedMappingSchema = z.object({
  supplierSku: z.string().optional(),
  brand: z.string().optional(),
  title: z.string().optional(),
  mpn: z.string().optional(),
  upc: z.string().optional(),
  category: z.string().optional(),
  cost: z.string().optional(),
  msrp: z.string().optional(),
  map: z.string().optional(),
  qty: z.string().optional(),
  dropShip: z.string().optional(),
  leadDays: z.string().optional(),
  description: z.string().optional(),
  imageUrl: z.string().optional(),
  size: z.string().optional(),
  color: z.string().optional(),
  matrixRef: z.string().optional(),
});

export const importSchema = z.object({
  csv: z.string().min(1).max(30_000_000),
  mapping: feedMappingSchema.optional(),
  contentLicensed: z.boolean().default(false),
  stream: z.enum(['availability', 'costs', 'content', 'full_catalog']).default('full_catalog'),
  autoPromoteNew: z.boolean().default(false),
});

export const importChunkSchema = z.object({
  csv: z.string().min(1).max(12_000_000),
  mapping: feedMappingSchema.optional(),
  contentLicensed: z.boolean().default(false),
  stream: z.enum(['availability', 'costs', 'content', 'full_catalog']).default('full_catalog'),
  chunkIndex: z.number().int().min(0).default(0),
  totalChunks: z.number().int().min(1).default(1),
  autoPromoteNew: z.boolean().default(false),
});

export const promoteOffersSchema = z.object({
  supplierCode: z.string().max(50).optional(),
  brand: z.string().max(100).optional(),
  category: z.string().max(100).optional(),
  onlyInStock: z.boolean().default(false),
  publishStatus: z.enum(['draft', 'published']).default('draft'),
  limit: z.number().int().min(1).max(50_000).default(50_000),
});

function cleanSlug(s: string, maxLen = 40): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, maxLen) || 'item';
}

interface CandidateVariantRow {
  id: string;
  brand: string;
  mpn: string | null;
  upc: string | null;
  title: string;
  k: string;
}

/**
 * High-throughput set-based Intermediary Engine ingest pipeline (40,000+ SKU scale):
 *  - Deduplicates repeated SKUs inside each 1,000-row batch so messy vendor CSVs never trigger
 *    PostgreSQL `ON CONFLICT DO UPDATE cannot affect row a second time`.
 *  - Resolves GTIN & MPN candidates in O(log N) batch queries using functional B-tree indexes
 *    (`variants_norm_upc_idx` & `variants_norm_mpn_idx`) instead of per-row scans.
 *  - Bulk-loads canonical `catalog_items` and bulk-writes `supplier_offer_history` +
 *    `outbound_sync_staging` via `jsonb_to_recordset`.
 */
export async function importSupplierRecords(
  ctx: AppContext,
  companyId: string,
  supplierCode: string,
  rawRecords: SupplierCatalogRecord[],
  stream: SyncStream = 'full_catalog',
  opts: { jobId?: number; skipEnqueueFlush?: boolean } = {},
) {
  const sup = await ctx.pool.query<{ id: string }>(
    `SELECT id FROM suppliers WHERE company_id = $1 AND code = $2`,
    [companyId, supplierCode],
  );
  if (!sup.rows[0]) throw notFound('Supplier');
  const supplierId = sup.rows[0].id;

  // Deduplicate incoming records by supplierSku (last occurrence wins) to protect batch upserts.
  const dedupedMap = new Map<string, SupplierCatalogRecord>();
  for (const r of rawRecords) {
    if (r.supplierSku) dedupedMap.set(r.supplierSku, r);
  }
  const records = [...dedupedMap.values()];

  const runRow = await ctx.pool.query<{ id: number }>(
    `INSERT INTO supplier_sync_runs (company_id, supplier_id, stream, status, records_seen)
     VALUES ($1, $2, $3, 'running', $4) RETURNING id`,
    [companyId, supplierId, stream, records.length],
  );
  const runId = runRow.rows[0]!.id;

  const [settings, mapEx, storeRow] = await Promise.all([
    getSettings(ctx.pool, companyId),
    activeMapExceptions(ctx.pool, companyId),
    ctx.pool.query<{ id: string }>(`SELECT id FROM stores WHERE company_id = $1 ORDER BY created_at LIMIT 1`, [companyId]),
  ]);
  const defaultStoreId = storeRow.rows[0]?.id ?? null;

  const stats = {
    upserted: 0,
    autoMatched: 0,
    review: 0,
    unmatched: 0,
    alreadyLinked: 0,
    versionedChanges: 0,
    stagedReady: 0,
    stagedHeld: 0,
  };

  const CHUNK_SIZE = 1000;

  try {
    for (let i = 0; i < records.length; i += CHUNK_SIZE) {
      const chunk = records.slice(i, i + CHUNK_SIZE);
      const recBySku = new Map<string, SupplierCatalogRecord>(chunk.map((r) => [r.supplierSku, r]));

      await withTransaction(ctx.pool, async (c) => {
        // 1. Snapshot previous offer values BEFORE upserting so we version exact deltas.
        const prevRows = await c.query<{
          supplier_sku: string;
          cost_cents: number | null;
          map_cents: number | null;
          msrp_cents: number | null;
          qty_available: number;
        }>(
          `SELECT supplier_sku, cost_cents, map_cents, msrp_cents, qty_available
           FROM supplier_offers
           WHERE company_id = $1 AND supplier_id = $2 AND supplier_sku = ANY($3::text[])`,
          [companyId, supplierId, chunk.map((r) => r.supplierSku)],
        );
        const prevBySku = new Map<string, PreviousOfferSnapshot>(
          prevRows.rows.map((p) => [
            p.supplier_sku,
            { costCents: p.cost_cents, mapCents: p.map_cents, msrpCents: p.msrp_cents, qtyAvailable: p.qty_available },
          ]),
        );

        // 2. Bulk upsert supplier_offers including rich universal metadata.
        const up = await c.query<{ id: string; variant_id: string | null; supplier_sku: string }>(
          `INSERT INTO supplier_offers (
             company_id, supplier_id, supplier_sku, brand, title, upc, mpn, category,
             cost_cents, msrp_cents, map_cents, qty_available, drop_ship, lead_days,
             content_licensed, description, images, option_values, matrix_ref, reported_at
           )
           SELECT
             $1, $2, r.sku, r.brand, r.title, r.upc, r.mpn, r.cat,
             r.cost, r.msrp, r.map, r.qty, r.drop, r.lead,
             r.lic, COALESCE(r.descr, ''), COALESCE(r.imgs, '[]'::jsonb), COALESCE(r.opts, '{}'::jsonb), r.mref, now()
           FROM jsonb_to_recordset($3::jsonb) AS r(
             sku text, brand text, title text, upc text, mpn text, cat text,
             cost int, msrp int, map int, qty int, drop boolean, lead int,
             lic boolean, descr text, imgs jsonb, opts jsonb, mref text
           )
           ON CONFLICT (company_id, supplier_id, supplier_sku) DO UPDATE SET
             cost_cents = EXCLUDED.cost_cents,
             msrp_cents = EXCLUDED.msrp_cents,
             map_cents = EXCLUDED.map_cents,
             qty_available = EXCLUDED.qty_available,
             drop_ship = EXCLUDED.drop_ship,
             lead_days = EXCLUDED.lead_days,
             title = EXCLUDED.title,
             brand = EXCLUDED.brand,
             upc = EXCLUDED.upc,
             mpn = EXCLUDED.mpn,
             category = COALESCE(EXCLUDED.category, supplier_offers.category),
             content_licensed = EXCLUDED.content_licensed,
             description = CASE WHEN EXCLUDED.description <> '' THEN EXCLUDED.description ELSE supplier_offers.description END,
             images = CASE WHEN jsonb_array_length(EXCLUDED.images) > 0 THEN EXCLUDED.images ELSE supplier_offers.images END,
             option_values = CASE WHEN EXCLUDED.option_values <> '{}'::jsonb THEN EXCLUDED.option_values ELSE supplier_offers.option_values END,
             matrix_ref = COALESCE(EXCLUDED.matrix_ref, supplier_offers.matrix_ref),
             reported_at = now(),
             updated_at = now()
           RETURNING id, variant_id, supplier_sku`,
          [
            companyId,
            supplierId,
            JSON.stringify(
              chunk.map((r) => ({
                sku: r.supplierSku,
                brand: r.brand,
                title: r.title,
                upc: r.upc,
                mpn: r.mpn,
                cat: r.category,
                cost: r.costCents,
                msrp: r.msrpCents && r.msrpCents > 0 ? r.msrpCents : null,
                map: r.mapCents && r.mapCents > 0 ? r.mapCents : null,
                qty: r.qtyAvailable,
                drop: r.dropShip,
                lead: r.leadDays,
                lic: r.contentLicensed,
                descr: r.description ?? '',
                imgs: r.images ?? [],
                opts: r.optionValues ?? {},
                mref: r.matrixRef ?? null,
              })),
            ),
          ],
        );
        stats.upserted += up.rowCount ?? 0;

        // 3. Batch candidate lookup for all unlinked offers in this chunk (2 indexed queries max!).
        const unlinkedRows = up.rows.filter((row) => !row.variant_id);
        const upcKeys = new Set<string>();
        const mpnKeys = new Set<string>();
        for (const row of unlinkedRows) {
          const rec = recBySku.get(row.supplier_sku);
          if (!rec) continue;
          const u = (rec.upc ?? '').replace(/^0+/, '');
          if (u.length >= 6) upcKeys.add(u);
          const m = normalizeMpn(rec.mpn);
          if (m) mpnKeys.add(m);
        }

        const candsByUpc = new Map<string, CandidateVariantRow[]>();
        const candsByMpn = new Map<string, CandidateVariantRow[]>();

        if (upcKeys.size > 0) {
          const rUpc = await c.query<CandidateVariantRow>(
            `SELECT v.id, p.brand, v.mpn, v.upc, v.title, ltrim(v.upc, '0') AS k
             FROM variants v JOIN products p ON p.id = v.product_id
             WHERE v.company_id = $1 AND v.upc IS NOT NULL AND v.upc <> '' AND ltrim(v.upc, '0') = ANY($2::text[])`,
            [companyId, [...upcKeys]],
          );
          for (const cand of rUpc.rows) {
            const arr = candsByUpc.get(cand.k) ?? [];
            arr.push(cand);
            candsByUpc.set(cand.k, arr);
          }
        }

        if (mpnKeys.size > 0) {
          const rMpn = await c.query<CandidateVariantRow>(
            `SELECT v.id, p.brand, v.mpn, v.upc, v.title, upper(regexp_replace(v.mpn, '[^A-Za-z0-9]', '', 'g')) AS k
             FROM variants v JOIN products p ON p.id = v.product_id
             WHERE v.company_id = $1 AND v.mpn IS NOT NULL AND v.mpn <> ''
               AND upper(regexp_replace(v.mpn, '[^A-Za-z0-9]', '', 'g')) = ANY($2::text[])`,
            [companyId, [...mpnKeys]],
          );
          for (const cand of rMpn.rows) {
            const arr = candsByMpn.get(cand.k) ?? [];
            arr.push(cand);
            candsByMpn.set(cand.k, arr);
          }
        }

        const resolvedVariantByOfferId = new Map<string, string>();
        const autoMatchUpdates: { oid: string; vid: string }[] = [];
        const reviewInserts: { oid: string; vid: string; sc: string; rs: string[] }[] = [];

        for (const row of up.rows) {
          if (row.variant_id) {
            stats.alreadyLinked++;
            resolvedVariantByOfferId.set(row.id, row.variant_id);
            continue;
          }
          const rec = recBySku.get(row.supplier_sku)!;
          const u = (rec.upc ?? '').replace(/^0+/, '');
          const m = normalizeMpn(rec.mpn);
          const mergedMap = new Map<string, CandidateVariantRow>();
          for (const cand of candsByUpc.get(u) ?? []) mergedMap.set(cand.id, cand);
          if (m) {
            for (const cand of candsByMpn.get(m) ?? []) mergedMap.set(cand.id, cand);
          }
          const cands = [...mergedMap.values()];
          const best = cands.length
            ? findBestMatch({ brand: rec.brand, mpn: rec.mpn, upc: rec.upc, title: rec.title }, cands)
            : null;

          if (best?.decision === 'auto_match') {
            autoMatchUpdates.push({ oid: row.id, vid: best.item.id });
            resolvedVariantByOfferId.set(row.id, best.item.id);
            stats.autoMatched++;
          } else if (best?.decision === 'review') {
            reviewInserts.push({
              oid: row.id,
              vid: best.item.id,
              sc: best.score.toFixed(3),
              rs: best.reasons,
            });
            stats.review++;
          } else {
            stats.unmatched++;
          }
        }

        if (autoMatchUpdates.length > 0) {
          await c.query(
            `UPDATE supplier_offers so
             SET variant_id = r.vid
             FROM jsonb_to_recordset($1::jsonb) AS r(oid uuid, vid uuid)
             WHERE so.id = r.oid`,
            [JSON.stringify(autoMatchUpdates)],
          );
        }

        if (reviewInserts.length > 0) {
          await c.query(
            `INSERT INTO match_reviews (company_id, offer_id, candidate_variant_id, score, reasons)
             SELECT $1, r.oid, r.vid, r.sc::numeric(4,3), r.rs
             FROM jsonb_to_recordset($2::jsonb) AS r(oid uuid, vid uuid, sc text, rs jsonb)
             ON CONFLICT DO NOTHING`,
            [companyId, JSON.stringify(reviewInserts)],
          );
        }

        // 4. Bulk load canonical catalog_items for all linked variants in 1 query!
        const uniqueVariantIds = [...new Set(resolvedVariantByOfferId.values())];
        const itemsById = new Map<string, CatalogItem>();
        if (uniqueVariantIds.length > 0) {
          const itemRows = await c.query(
            `SELECT * FROM catalog_items WHERE company_id = $1 AND id = ANY($2::uuid[])`,
            [companyId, uniqueVariantIds],
          );
          for (const ir of itemRows.rows) {
            const mapped = rowToItem(ir as never);
            itemsById.set(mapped.id, mapped);
          }
        }

        // 5. Evaluate Versioning + Processing Buffer in memory and bulk insert deltas & staging.
        const historyBatch: unknown[] = [];
        const stagingByVariant = new Map<string, {
          vid: string;
          dec: string;
          reasons: string[];
          payload: unknown;
          st: string;
        }>();

        for (const row of up.rows) {
          const rec = recBySku.get(row.supplier_sku)!;
          const linkedVariantId = resolvedVariantByOfferId.get(row.id) ?? null;
          const canonicalItem = linkedVariantId ? (itemsById.get(linkedVariantId) ?? null) : null;
          const prevOffer = prevBySku.get(rec.supplierSku) ?? null;

          const staging = evaluateStagingBuffer({
            item: canonicalItem,
            previousOffer: prevOffer,
            incoming: {
              supplierCode,
              supplierSku: rec.supplierSku,
              brand: rec.brand,
              title: rec.title,
              mpn: rec.mpn,
              upc: rec.upc,
              costCents: rec.costCents,
              mapCents: rec.mapCents && rec.mapCents > 0 ? rec.mapCents : null,
              msrpCents: rec.msrpCents && rec.msrpCents > 0 ? rec.msrpCents : null,
              qtyAvailable: rec.qtyAvailable,
              dropShip: rec.dropShip,
              leadDays: rec.leadDays,
              description: rec.description ?? null,
              images: rec.images ?? [],
              contentLicensed: rec.contentLicensed,
            },
            stream,
            campaignRules: settings.campaignRules,
            availabilitySettings: settings.availability,
            mapExceptions: mapEx,
          });

          if (staging.versionDelta.changed) {
            const marginBps = staging.versionDelta.resultingMarginPct !== null
              ? Math.round(staging.versionDelta.resultingMarginPct * 10_000)
              : null;
            historyBatch.push({
              oid: row.id,
              vid: linkedVariantId,
              sku: rec.supplierSku,
              ct: staging.versionDelta.changeTypes,
              oc: staging.versionDelta.oldCostCents,
              nc: staging.versionDelta.newCostCents,
              om: staging.versionDelta.oldMapCents,
              nm: staging.versionDelta.newMapCents,
              oms: staging.versionDelta.oldMsrpCents,
              nms: staging.versionDelta.newMsrpCents,
              oq: staging.versionDelta.oldQty,
              nq: staging.versionDelta.newQty,
              sp: staging.versionDelta.shopifyPublishedPriceCents,
              mbps: marginBps,
            });
            stats.versionedChanges++;
          }

          if (linkedVariantId && staging.shopifyPayload && staging.decision !== 'unchanged') {
            const stStatus = staging.decision === 'ready_for_shopify' ? 'pending' : 'held';
            stagingByVariant.set(linkedVariantId, {
              vid: linkedVariantId,
              dec: staging.decision,
              reasons: staging.holdReasons,
              payload: staging.shopifyPayload,
              st: stStatus,
            });
            if (staging.decision === 'ready_for_shopify') stats.stagedReady++;
            else stats.stagedHeld++;
          }
        }

        if (historyBatch.length > 0) {
          await c.query(
            `INSERT INTO supplier_offer_history (
               company_id, supplier_id, offer_id, variant_id, supplier_sku, change_types,
               old_cost_cents, new_cost_cents, old_map_cents, new_map_cents, old_msrp_cents, new_msrp_cents,
               old_qty, new_qty, shopify_published_price_cents, resulting_margin_bps
             )
             SELECT
               $1, $2, r.oid, r.vid, r.sku, r.ct,
               r.oc, r.nc, r.om, r.nm, r.oms, r.nms,
               r.oq, r.nq, r.sp, r.mbps
             FROM jsonb_to_recordset($3::jsonb) AS r(
               oid uuid, vid uuid, sku text, ct jsonb,
               oc int, nc int, om int, nm int, oms int, nms int,
               oq int, nq int, sp int, mbps int
             )`,
            [companyId, supplierId, JSON.stringify(historyBatch)],
          );
        }

        const stagingArr = [...stagingByVariant.values()];
        if (stagingArr.length > 0) {
          await c.query(
            `INSERT INTO outbound_sync_staging (
               company_id, store_id, variant_id, stream, decision, hold_reasons, shopify_payload, status, updated_at
             )
             SELECT $1, $2, r.vid, $3, r.dec, r.reasons, r.payload, r.st, now()
             FROM jsonb_to_recordset($4::jsonb) AS r(
               vid uuid, dec text, reasons jsonb, payload jsonb, st text
             )
             ON CONFLICT (company_id, variant_id, stream) DO UPDATE SET
               decision = EXCLUDED.decision,
               hold_reasons = EXCLUDED.hold_reasons,
               shopify_payload = EXCLUDED.shopify_payload,
               status = EXCLUDED.status,
               updated_at = now()`,
            [companyId, defaultStoreId, stream, JSON.stringify(stagingArr)],
          );
        }
      });

      if (opts.jobId) {
        await setProgress(ctx.pool, opts.jobId, {
          done: Math.min(i + CHUNK_SIZE, records.length),
          total: records.length,
          upserted: stats.upserted,
          autoMatched: stats.autoMatched,
          stagedReady: stats.stagedReady,
        });
      }
    }

    await ctx.pool.query(
      `UPDATE supplier_sync_runs
       SET status = 'succeeded', records_changed = $2, staged_ready = $3, staged_held = $4, finished_at = now()
       WHERE id = $1`,
      [runId, stats.versionedChanges, stats.stagedReady, stats.stagedHeld],
    );
    await ctx.pool.query(
      `UPDATE supplier_sync_schedules
       SET last_run_at = now(), last_success_at = now(), last_status = 'succeeded', updated_at = now()
       WHERE company_id = $1 AND supplier_id = $2 AND stream IN ($3, 'full_catalog')`,
      [companyId, supplierId, stream],
    );
    if (stats.stagedReady > 0 && !opts.skipEnqueueFlush) {
      await enqueue(ctx.pool, {
        companyId,
        type: 'pipeline.flush_shopify',
        payload: { supplierCode, stream },
        idempotencyKey: `flush:${companyId}:${supplierCode}:${runId}`,
      });
    }
    await audit(ctx.pool, {
      companyId,
      action: 'supplier.imported',
      entityType: 'supplier',
      entityId: supplierCode,
      detail: { ...stats, stream },
    });
    return stats;
  } catch (err) {
    await ctx.pool.query(
      `UPDATE supplier_sync_runs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`,
      [runId, (err as Error).message],
    ).catch(() => {});
    await ctx.pool.query(
      `UPDATE supplier_sync_schedules SET last_run_at = now(), last_status = 'failed', updated_at = now()
       WHERE company_id = $1 AND supplier_id = $2 AND stream = $3`,
      [companyId, supplierId, stream],
    ).catch(() => {});
    throw err;
  }
}

export async function importFeedJob(
  ctx: AppContext,
  companyId: string,
  payload: z.infer<typeof importSchema> & { supplierCode: string },
  jobId?: number,
) {
  const defaultBrand = payload.supplierCode.toUpperCase() === 'SPECIALIZED' ? 'Specialized' : undefined;
  const { records, errors, inferredMapping } = mapFeed(payload.csv, payload.mapping as Partial<FeedMapping> | undefined, {
    contentLicensed: payload.contentLicensed,
    defaultLeadDays: 5,
    defaultBrand,
  });
  const stats = await importSupplierRecords(ctx, companyId, payload.supplierCode, records, payload.stream ?? 'full_catalog', { jobId });
  let promoted: { productsUpserted: number; variantsPromoted: number; stagedForShopify: number } | null = null;
  if (payload.autoPromoteNew && stats.unmatched > 0) {
    promoted = await promoteUnmatchedOffersJob(ctx, companyId, {
      supplierCode: payload.supplierCode,
      onlyInStock: false,
      publishStatus: 'draft',
      limit: 50_000,
    }, jobId);
  }
  return {
    ...stats,
    promoted,
    inferredMapping,
    rowErrors: errors.slice(0, 200),
    rowErrorCount: errors.length,
  };
}

/**
 * Synchronous chunked CSV/TSV ingest endpoint handler (`POST /api/suppliers/:code/import-chunk`)
 * so the browser can stream 30,000–50,000+ rows in 2,500-row batches without large HTTP bodies or memory spikes.
 */
export async function importSupplierChunk(
  ctx: AppContext,
  companyId: string,
  supplierCode: string,
  input: z.infer<typeof importChunkSchema>,
) {
  const defaultBrand = supplierCode.toUpperCase() === 'SPECIALIZED' ? 'Specialized' : undefined;
  const { records, errors, inferredMapping } = mapFeed(input.csv, input.mapping as Partial<FeedMapping> | undefined, {
    contentLicensed: input.contentLicensed,
    defaultLeadDays: 5,
    defaultBrand,
  });
  const isLastChunk = input.chunkIndex >= input.totalChunks - 1;
  const stats = await importSupplierRecords(ctx, companyId, supplierCode, records, input.stream ?? 'full_catalog', {
    skipEnqueueFlush: !isLastChunk,
  });
  let promoted: { productsUpserted: number; variantsPromoted: number; stagedForShopify: number } | null = null;
  if (isLastChunk && input.autoPromoteNew) {
    promoted = await promoteUnmatchedOffersJob(ctx, companyId, {
      supplierCode,
      onlyInStock: false,
      publishStatus: 'draft',
      limit: 50_000,
    });
  }
  return {
    ...stats,
    promoted,
    inferredMapping,
    chunkIndex: input.chunkIndex,
    totalChunks: input.totalChunks,
    rowErrors: errors.slice(0, 50),
    rowErrorCount: errors.length,
  };
}

/**
 * Promotes unmatched distributor offers (`supplier_offers.variant_id IS NULL`) into UBC's canonical
 * `products` + `variants` catalog and stages them in `outbound_sync_staging` (`ready_for_shopify`).
 *  - Groups multi-size/color variants cleanly via `matrix_ref` when provided by QBP/JBI/Specialized.
 *  - Computes safe retail prices (`>= MAP`, `>= minMarginPct`, strictly `> 0`).
 *  - Only copies vendor descriptions/images when `content_licensed = true`.
 */
export async function promoteUnmatchedOffersJob(
  ctx: AppContext,
  companyId: string,
  input: z.infer<typeof promoteOffersSchema>,
  jobId?: number,
) {
  const [settings, storeRow] = await Promise.all([
    getSettings(ctx.pool, companyId),
    ctx.pool.query<{ id: string }>(`SELECT id FROM stores WHERE company_id = $1 ORDER BY created_at LIMIT 1`, [companyId]),
  ]);
  const defaultStoreId = storeRow.rows[0]?.id ?? null;
  const targetMargin = Math.min(0.65, Math.max(0.28, settings.campaignRules.minMarginPct + 0.08));
  const publishStatus: PublishStatus = input.publishStatus ?? 'draft';

  const offersRes = await ctx.pool.query<{
    id: string;
    supplier_code: string;
    supplier_sku: string;
    brand: string;
    title: string;
    upc: string | null;
    mpn: string | null;
    category: string | null;
    cost_cents: number | null;
    msrp_cents: number | null;
    map_cents: number | null;
    qty_available: number;
    drop_ship: boolean;
    lead_days: number;
    content_licensed: boolean;
    description: string;
    images: string[];
    option_values: Record<string, string>;
    matrix_ref: string | null;
    reported_at: Date;
  }>(
    `SELECT so.id, s.code AS supplier_code, so.supplier_sku, so.brand, so.title, so.upc, so.mpn,
            so.category, so.cost_cents, so.msrp_cents, so.map_cents, so.qty_available, so.drop_ship,
            so.lead_days, so.content_licensed, so.description, so.images, so.option_values,
            so.matrix_ref, so.reported_at
     FROM supplier_offers so
     JOIN suppliers s ON s.id = so.supplier_id
     WHERE so.company_id = $1
       AND so.variant_id IS NULL
       AND ($2::text IS NULL OR s.code = $2)
       AND ($3::text IS NULL OR lower(so.brand) = lower($3))
       AND ($4::text IS NULL OR lower(COALESCE(so.category, '')) = lower($4))
       AND ($5::boolean = false OR so.qty_available > 0)
     ORDER BY s.code, so.brand, so.matrix_ref NULLS LAST, so.supplier_sku
     LIMIT $6`,
    [
      companyId,
      input.supplierCode ?? null,
      input.brand ?? null,
      input.category ?? null,
      input.onlyInStock,
      input.limit,
    ],
  );

  const allOffers = offersRes.rows;
  if (!allOffers.length) {
    return { productsUpserted: 0, variantsPromoted: 0, stagedForShopify: 0 };
  }

  let productsUpserted = 0;
  let variantsPromoted = 0;
  let stagedForShopify = 0;
  const CHUNK_SIZE = 1000;

  for (let i = 0; i < allOffers.length; i += CHUNK_SIZE) {
    const chunk = allOffers.slice(i, i + CHUNK_SIZE);

    await withTransaction(ctx.pool, async (c) => {
      const prodMap = new Map<string, {
        ref: string;
        brand: string;
        model: string;
        category: string;
        title: string;
        descr: string;
        imgs: string[];
        status: PublishStatus;
        mapPolicy: 'none' | 'map';
      }>();

      const varRows: {
        offerId: string;
        prodRef: string;
        varRef: string;
        sku: string;
        title: string;
        upc: string | null;
        mpn: string | null;
        opts: Record<string, string>;
        priceCents: number;
        compareAtCents: number | null;
        costCents: number | null;
        mapCents: number | null;
        status: PublishStatus;
        brand: string;
        category: string;
        supplierCode: string;
        supplierSku: string;
        qtyAvailable: number;
        dropShip: boolean;
        leadDays: number;
        reportedAt: string;
      }[] = [];

      const seenVarSku = new Set<string>();

      for (const o of chunk) {
        const brand = o.brand.trim() || 'Generic';
        const category = normalizeCyclingCategory(o.category, o.title);
        const groupId = o.matrix_ref?.trim()
          ? `${o.supplier_code.toLowerCase()}-m-${cleanSlug(o.matrix_ref, 48)}`
          : `${o.supplier_code.toLowerCase()}-s-${cleanSlug(o.supplier_sku, 48)}`;
        const prodRef = `vp-${groupId}`;

        const safeMap = o.map_cents && o.map_cents > 0 ? o.map_cents : null;
        const safeMsrp = o.msrp_cents && o.msrp_cents > 0 ? o.msrp_cents : null;
        const safeCost = o.cost_cents !== null && o.cost_cents >= 0 ? o.cost_cents : null;
        const marginFloorPrice = safeCost && safeCost > 0
          ? Math.ceil(safeCost / (1 - targetMargin))
          : 1999;
        // Catalog price is kept exactly as the catalog (Workstand) sends it — never rounded here.
        // Real retail/.99 pricing comes from Lightspeed (Carlos's POS) for items that sync with it.
        const priceCents = Math.max(100, safeMsrp ?? marginFloorPrice, safeMap ?? 0);

        const baseTitle = o.matrix_ref?.trim()
          ? o.title.replace(/\s+[-–—/]\s*(XS|S|M|L|XL|XXL|S\d|\d{2}(?:\.\d)?(?:\s*cm|\s*in|c)?)\s*$/i, '').trim() || o.title
          : o.title;

        const existingProd = prodMap.get(prodRef);
        if (!existingProd) {
          prodMap.set(prodRef, {
            ref: prodRef,
            brand,
            model: baseTitle.slice(0, 120),
            category,
            title: baseTitle,
            descr: o.content_licensed ? (o.description || '') : '',
            imgs: o.content_licensed && Array.isArray(o.images) ? o.images : [],
            status: publishStatus,
            mapPolicy: safeMap ? 'map' : 'none',
          });
        } else {
          if (safeMap) existingProd.mapPolicy = 'map';
          if (o.content_licensed && Array.isArray(o.images)) {
            for (const img of o.images) {
              if (!existingProd.imgs.includes(img) && existingProd.imgs.length < 6) existingProd.imgs.push(img);
            }
          }
        }

        const canonicalSku = `${o.supplier_code.toUpperCase()}-${o.supplier_sku.trim()}`;
        if (seenVarSku.has(canonicalSku)) continue;
        seenVarSku.add(canonicalSku);

        const validUpc = formatRetailBarcode(o.upc);
        varRows.push({
          offerId: o.id,
          prodRef,
          varRef: `vv-${o.supplier_code.toLowerCase()}-${cleanSlug(o.supplier_sku, 52)}-${o.id.slice(0, 6)}`,
          sku: canonicalSku,
          title: o.title.trim() || canonicalSku,
          upc: validUpc,
          mpn: o.mpn?.trim() || null,
          opts: o.option_values ?? {},
          priceCents,
          compareAtCents: safeMsrp && safeMsrp > priceCents ? safeMsrp : null,
          costCents: safeCost,
          mapCents: safeMap,
          status: publishStatus,
          brand,
          category,
          supplierCode: o.supplier_code,
          supplierSku: o.supplier_sku,
          qtyAvailable: o.qty_available,
          dropShip: o.drop_ship,
          leadDays: o.lead_days,
          reportedAt: new Date(o.reported_at).toISOString(),
        });
      }

      const prodArr = [...prodMap.values()];
      const insProds = await c.query<{ id: string; ref: string }>(
        `INSERT INTO products (company_id, ref, brand, model, category, title, description, images, status, map_policy)
         SELECT $1, r.ref, r.brand, r.model, r.category, r.title, r.descr, r.imgs, r.status, r.map_policy
         FROM jsonb_to_recordset($2::jsonb) AS r(
           ref text, brand text, model text, category text, title text,
           descr text, imgs jsonb, status text, map_policy text
         )
         ON CONFLICT (company_id, ref) DO UPDATE SET
           brand = EXCLUDED.brand,
           category = EXCLUDED.category,
           map_policy = CASE WHEN EXCLUDED.map_policy = 'map' THEN 'map' ELSE products.map_policy END,
           description = CASE WHEN products.description = '' THEN EXCLUDED.description ELSE products.description END,
           images = CASE WHEN jsonb_array_length(products.images) = 0 THEN EXCLUDED.images ELSE products.images END,
           updated_at = now()
         RETURNING id, ref`,
        [companyId, JSON.stringify(prodArr.map((p) => ({
          ref: p.ref,
          brand: p.brand,
          model: p.model,
          category: p.category,
          title: p.title,
          descr: p.descr,
          imgs: p.imgs,
          status: p.status,
          map_policy: p.mapPolicy,
        })))],
      );
      productsUpserted += insProds.rowCount ?? 0;
      const prodIdByRef = new Map(insProds.rows.map((r) => [r.ref, r.id]));

      const insVars = await c.query<{ id: string; sku: string }>(
        `INSERT INTO variants (
           company_id, product_id, ref, title, sku, upc, mpn, option_values,
           price_cents, compare_at_cents, cost_cents, map_cents, status
         )
         SELECT
           $1, r.pid, r.vref, r.title, r.sku, r.upc, r.mpn, r.opts,
           r.price, r.comp, r.cost, r.map, r.status
         FROM jsonb_to_recordset($2::jsonb) AS r(
           pid uuid, vref text, title text, sku text, upc text, mpn text, opts jsonb,
           price int, comp int, cost int, map int, status text
         )
         ON CONFLICT (company_id, sku) DO UPDATE SET
           cost_cents = COALESCE(EXCLUDED.cost_cents, variants.cost_cents),
           map_cents = COALESCE(EXCLUDED.map_cents, variants.map_cents),
           upc = COALESCE(variants.upc, EXCLUDED.upc),
           mpn = COALESCE(variants.mpn, EXCLUDED.mpn),
           updated_at = now()
         RETURNING id, sku`,
        [
          companyId,
          JSON.stringify(
            varRows.map((v) => ({
              pid: prodIdByRef.get(v.prodRef)!,
              vref: v.varRef,
              title: v.title,
              sku: v.sku,
              upc: v.upc,
              mpn: v.mpn,
              opts: v.opts,
              price: v.priceCents,
              comp: v.compareAtCents,
              cost: v.costCents,
              map: v.mapCents,
              status: v.status,
            })),
          ),
        ],
      );
      variantsPromoted += insVars.rowCount ?? 0;
      const varIdBySku = new Map(insVars.rows.map((r) => [r.sku, r.id]));

      // Link supplier_offers -> variant_id in 1 batch update.
      const linkPairs = varRows
        .map((v) => ({ oid: v.offerId, vid: varIdBySku.get(v.sku) }))
        .filter((x): x is { oid: string; vid: string } => Boolean(x.vid));

      if (linkPairs.length > 0) {
        await c.query(
          `UPDATE supplier_offers so
           SET variant_id = r.vid, updated_at = now()
           FROM jsonb_to_recordset($1::jsonb) AS r(oid uuid, vid uuid)
           WHERE so.id = r.oid`,
          [JSON.stringify(linkPairs)],
        );
      }

      // Stage newly promoted variants into outbound_sync_staging for Shopify creation/sync!
      const stagingBatch = varRows
        .map((v) => {
          const vid = varIdBySku.get(v.sku);
          if (!vid) return null;
          const av = computeAvailability(
            {
              physicalQty: 0,
              reservedQty: 0,
              offers: [
                {
                  supplierCode: v.supplierCode,
                  supplierSku: v.supplierSku,
                  costCents: v.costCents ?? 0,
                  qtyAvailable: v.qtyAvailable,
                  reportedAt: v.reportedAt,
                  dropShip: v.dropShip,
                  leadDays: v.leadDays,
                },
              ],
            },
            settings.availability,
          );
          const clickAndCollectOnly = v.brand.toLowerCase() === 'specialized' && v.category.toLowerCase().includes('bike');
          return {
            vid,
            payload: {
              publishedQty: av.shopify.publishedQty,
              inventoryPolicy: av.shopify.inventoryPolicy,
              availability: av.status,
              leadTimeDays: av.shopify.leadTimeDays,
              clickAndCollectOnly,
            },
          };
        })
        .filter((x): x is NonNullable<typeof x> => Boolean(x));

      if (stagingBatch.length > 0) {
        await c.query(
          `INSERT INTO outbound_sync_staging (
             company_id, store_id, variant_id, stream, decision, hold_reasons, shopify_payload, status, updated_at
           )
           SELECT $1, $2, r.vid, 'full_catalog', 'ready_for_shopify', '[]'::jsonb, r.payload, 'pending', now()
           FROM jsonb_to_recordset($3::jsonb) AS r(vid uuid, payload jsonb)
           ON CONFLICT (company_id, variant_id, stream) DO UPDATE SET
             decision = 'ready_for_shopify',
             hold_reasons = '[]'::jsonb,
             shopify_payload = EXCLUDED.shopify_payload,
             status = 'pending',
             updated_at = now()`,
          [companyId, defaultStoreId, JSON.stringify(stagingBatch)],
        );
        stagedForShopify += stagingBatch.length;
      }
    });

    if (jobId) {
      await setProgress(ctx.pool, jobId, {
        done: Math.min(i + CHUNK_SIZE, allOffers.length),
        total: allOffers.length,
        productsUpserted,
        variantsPromoted,
        stagedForShopify,
      });
    }
  }

  if (stagedForShopify > 0) {
    await enqueue(ctx.pool, {
      companyId,
      type: 'pipeline.flush_shopify',
      payload: { trigger: 'promote_unmatched_offers', stagedForShopify },
    });
  }

  await audit(ctx.pool, {
    companyId,
    action: 'supplier.offers_promoted',
    detail: { ...input, productsUpserted, variantsPromoted, stagedForShopify },
  });

  return { productsUpserted, variantsPromoted, stagedForShopify };
}

export async function resolveReview(ctx: AppContext, companyId: string, userId: string, reviewId: string, decision: 'approved' | 'rejected') {
  return withTransaction(ctx.pool, async (c) => {
    const r = await c.query<{ offer_id: string; candidate_variant_id: string }>(
      `UPDATE match_reviews SET status = $3, resolved_by = $4, resolved_at = now()
       WHERE company_id = $1 AND id = $2 AND status = 'pending'
       RETURNING offer_id, candidate_variant_id`,
      [companyId, reviewId, decision, userId],
    );
    if (!r.rows[0]) throw notFound('Pending review');
    if (decision === 'approved') {
      await c.query(`UPDATE supplier_offers SET variant_id = $2 WHERE id = $1`, [r.rows[0].offer_id, r.rows[0].candidate_variant_id]);
    }
    await audit(c, { companyId, userId, action: `match.${decision}`, entityType: 'match_review', entityId: reviewId });
    return { status: decision };
  });
}
