import { formatRetailBarcode, normalizeGtin } from '@ubc/business-rules';
import { audit, logError } from './audit.js';
import { HttpError, type AppContext } from './context.js';
import { enqueue } from './jobs.js';

/**
 * "Create Shopify product" (for products Workstand does not have, e.g. Jupiter): Carlos picks the
 * Lightspeed items that are the same product in different colors/sizes; the Hub creates ONE DRAFT
 * product in Shopify with one variant per item (barcode = Lightspeed UPC, SKU = System ID, Lightspeed
 * price / sale price), links them right away (Carlos's own decision) and pushes stock per store.
 * Carlos then adds photos/description in Shopify and publishes it.
 */
export async function createShopifyProductFromItems(
  ctx: AppContext,
  companyId: string,
  userId: string,
  input: { variantIds: string[]; title: string; vendor: string; productType: string; optionName: string; values: Record<string, string>; publishNow?: boolean },
) {
  if (ctx.config.env.SHOPIFY_SYNC_MODE !== 'update_only') throw new HttpError(409, 'NOT_AVAILABLE', 'Only available with the live Shopify store');
  const shop = shopOf(ctx);
  const rows = await ctx.pool.query<{
    id: string; title: string; sku: string; upc: string | null; price_cents: number; compare_at_cents: number | null; cost_cents: number | null; links: number;
  }>(
    `SELECT v.id, v.title, v.sku, v.upc, v.price_cents, v.compare_at_cents, v.cost_cents,
            (SELECT count(*)::int FROM shopify_variant_links l WHERE l.variant_id = v.id AND l.shop_domain = $3) AS links
     FROM variants v
     JOIN external_ids e ON e.company_id = v.company_id AND e.entity_type = 'variant' AND e.entity_id = v.id AND e.system = 'lightspeed_r'
     WHERE v.company_id = $1 AND v.id = ANY($2::uuid[])`,
    [companyId, input.variantIds, shop],
  );
  const problems: string[] = [];
  if (rows.rows.length !== input.variantIds.length) problems.push('Some selected items are not Lightspeed items');
  for (const r of rows.rows) {
    if (r.links > 0) problems.push(`${r.title}: already linked to a Shopify variant`);
    if (!(r.price_cents > 0)) problems.push(`${r.title}: no price in Lightspeed`);
    if (!String(input.values[r.id] ?? '').trim()) problems.push(`${r.title}: missing ${input.optionName} value`);
  }
  const vals = rows.rows.map((r) => String(input.values[r.id] ?? '').trim().toLowerCase());
  if (new Set(vals).size !== vals.length) problems.push(`Each item needs a different ${input.optionName} value`);
  if (problems.length) throw new HttpError(422, 'CANNOT_CREATE', 'Cannot create the product', { problems });

  const targetStatus = input.publishNow ? 'ACTIVE' : 'DRAFT';
  const created = await ctx.connectors.shopify.createDraftProductFromItems({
    title: input.title.trim(),
    vendor: input.vendor.trim() || 'UBC',
    productType: input.productType.trim() || 'Bikes',
    status: targetStatus,
    variants: rows.rows.map((r) => ({
      sku: r.sku,
      barcode: formatRetailBarcode(r.upc) ?? (r.upc?.trim() || r.sku || undefined),
      priceCents: r.price_cents,
      compareAtCents: r.compare_at_cents,
      costCents: r.cost_cents,
      optionValues: { [input.optionName.trim() || 'Color']: String(input.values[r.id]).trim() },
      availability: 'in_stock',
      onHandQty: 0,
    })) as never,
  });

  const bySku = new Map(rows.rows.map((r) => [r.sku, r]));
  const linked: { vid: string; svid: string; inv: string | null; p: number; c: number | null }[] = [];
  for (const v of created.variants) {
    const r = bySku.get(v.sku);
    if (r) linked.push({ vid: r.id, svid: v.variantId, inv: v.inventoryItemId, p: r.price_cents, c: r.compare_at_cents && r.compare_at_cents > r.price_cents ? r.compare_at_cents : null });
  }
  await ctx.pool.query(
    `INSERT INTO shopify_variant_links (company_id, shop_domain, variant_id, shopify_product_id, shopify_variant_id, shopify_inventory_item_id, match_method, last_price_cents, last_compare_at_cents)
     SELECT $1, $2, r.vid, $3, r.svid, r.inv, 'created_in_hub', r.p, r.c FROM jsonb_to_recordset($4::jsonb) AS r(vid uuid, svid text, inv text, p int, c int)
     ON CONFLICT (company_id, shop_domain, shopify_variant_id) DO NOTHING`,
    [companyId, shop, created.productId, JSON.stringify(linked)],
  );
  await ctx.pool.query(
    `INSERT INTO upc_link_proposals (company_id, shop_domain, kind, variant_id, shopify_variant_id, shopify_product_id, shopify_inventory_item_id,
                                     shopify_title, shopify_price_cents, shopify_compare_at_cents, status, note, decided_by, decided_at)
     SELECT $1, $2, 'add', r.vid, r.svid, $3, r.inv, $4, r.p, r.c, 'approved', 'Created in the Hub as a draft Shopify product', $5, now()
     FROM jsonb_to_recordset($6::jsonb) AS r(vid uuid, svid text, inv text, p int, c int)`,
    [companyId, shop, created.productId, input.title.trim(), userId, JSON.stringify(linked)],
  );
  // Push stock per store (activates the locations that have stock).
  await ctx.pool.query(
    `INSERT INTO outbound_sync_staging (company_id, variant_id, stream, decision, hold_reasons, shopify_payload, status, updated_at)
     SELECT $1, vid, 'availability', 'ready_for_shopify', '[]'::jsonb, '{"trigger":"created_in_hub"}'::jsonb, 'pending', now() FROM unnest($2::uuid[]) AS vid
     ON CONFLICT (company_id, variant_id, stream) DO UPDATE SET decision = 'ready_for_shopify', status = 'pending', last_error = NULL, updated_at = now()`,
    [companyId, linked.map((l) => l.vid)],
  );
  if (input.publishNow) {
    await ctx.pool.query(
      `UPDATE variants SET status = 'published', updated_at = now() WHERE company_id = $1 AND id = ANY($2::uuid[])`,
      [companyId, linked.map((l) => l.vid)],
    );
  }
  await enqueue(ctx.pool, { companyId, type: 'pipeline.flush_shopify', payload: { trigger: 'created_in_hub' } });
  await audit(ctx.pool, { companyId, userId, action: 'shopify.product_created_from_items', detail: { productId: created.productId, title: input.title, variants: linked.length } });
  const numericId = created.productId.split('/').pop();
  return { productId: created.productId, variants: linked.length, adminUrl: `https://${shop}/admin/products/${numericId}` };
}

/**
 * Nightly (update_only): compare Lightspeed items with the variants of the Workstand-owned Shopify
 * store by UPC (normalized GTIN-14: Workstand "00" prefixes, Excel-dropped zeros and EAN-only items all
 * match) and PROPOSE changes in `upc_link_proposals`. Nothing changes in the links or in Shopify until
 * someone approves the proposal in the Hub ("UPC Matches" section).
 *  - add:     new Lightspeed item ↔ Shopify variant with the same UPC
 *  - repoint: an existing link whose UPC now belongs to another Lightspeed item
 *  - remove:  an existing link whose UPC no longer matches / Shopify variant gone
 *             (not proposed at all when more than 20% of the links would go: alert instead)
 * Pairs Carlos already rejected are not proposed again. Repeated UPCs in Lightspeed are only matched
 * without doubt (the only one in stock, else the only single unit vs. packs).
 */
export async function linkStoreByUpcJob(ctx: AppContext, companyId: string) {
  if (ctx.config.env.SHOPIFY_SYNC_MODE !== 'update_only') return { skipped: 'not update_only' };
  const shop = shopOf(ctx);

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

  const existing = await ctx.pool.query<{ id: number; variant_id: string; shopify_variant_id: string; shopify_product_id: string; shopify_inventory_item_id: string | null; match_method: string }>(
    `SELECT id, variant_id, shopify_variant_id, shopify_product_id, shopify_inventory_item_id, match_method
     FROM shopify_variant_links WHERE company_id = $1 AND shop_domain = $2`,
    [companyId, shop],
  );
  const bySvid = new Map(existing.rows.map((l) => [l.shopify_variant_id, l]));
  const rejected = await ctx.pool.query<{ kind: string; shopify_variant_id: string; variant_id: string | null }>(
    `SELECT kind, shopify_variant_id, variant_id FROM upc_link_proposals WHERE company_id = $1 AND shop_domain = $2 AND status = 'rejected'`,
    [companyId, shop],
  );
  const rejectedKey = new Set(rejected.rows.map((r) => `${r.kind}|${r.shopify_variant_id}|${r.variant_id ?? ''}`));
  const stillInStore = new Set<string>();

  type P = {
    kind: 'add' | 'repoint' | 'remove'; vid: string | null; old: string | null; link: number | null;
    svid: string; pid: string | null; inv: string | null; title: string | null; barcode: string | null; p: number | null; c: number | null;
    manual?: boolean;
  };
  const proposals: P[] = [];
  const unmatched = new Map<number, P>();

  const total = await ctx.connectors.shopify.bulkReadVariants((row) => {
    const g = normalizeGtin(row.barcode);
    const vid = g ? hubByGtin.get(g) : undefined;
    const ex = bySvid.get(row.variantId);
    if (ex) stillInStore.add(row.variantId);
    const base = { svid: row.variantId, pid: row.productId, inv: row.inventoryItemId, title: row.title, barcode: row.barcode, p: row.priceCents, c: row.compareAtCents };
    if (!vid) {
      if (ex && ex.match_method !== 'created_in_hub') unmatched.set(ex.id, { ...base, kind: 'remove', vid: ex.variant_id, old: null, link: ex.id });
      return;
    }
    // manual = product created by hand in Shopify (no workstand.variant_uuid), e.g. Carlos's Jupiter bikes.
    if (!ex) proposals.push({ ...base, kind: 'add', vid, old: null, link: null, manual: !row.fromWorkstand });
    else if (ex.variant_id !== vid) proposals.push({ ...base, kind: 'repoint', vid, old: ex.variant_id, link: ex.id });
    else if (ex.shopify_product_id !== row.productId || ex.shopify_inventory_item_id !== row.inventoryItemId) {
      // Same item, Shopify moved the variant to another product / inventory item: safe bookkeeping, no decision needed.
      void ctx.pool.query(`UPDATE shopify_variant_links SET shopify_product_id = $2, shopify_inventory_item_id = $3, updated_at = now() WHERE id = $1`, [ex.id, row.productId, row.inventoryItemId]);
    }
  });

  if (total === 0) {
    await logError(ctx.pool, { companyId, source: 'job:shopify.link_store', message: 'Shopify bulk read returned 0 variants — nothing proposed' }).catch(() => {});
    return { shop, storeVariants: 0, skipped: 'empty store read' };
  }

  const removals: P[] = [...unmatched.values()];
  for (const l of existing.rows) {
    if (!stillInStore.has(l.shopify_variant_id)) {
      removals.push({ kind: 'remove', vid: l.variant_id, old: null, link: l.id, svid: l.shopify_variant_id, pid: l.shopify_product_id, inv: l.shopify_inventory_item_id, title: '(variant no longer in Shopify)', barcode: null, p: null, c: null });
    }
  }
  let removalsSuppressed = false;
  if (existing.rows.length > 0 && removals.length > existing.rows.length * 0.2) {
    removalsSuppressed = true;
    await logError(ctx.pool, {
      companyId, source: 'job:shopify.link_store',
      message: `${removals.length} of ${existing.rows.length} UPC links no longer match (>20%) — not proposed for removal, please check Shopify/Workstand`,
    }).catch(() => {});
  } else {
    proposals.push(...removals);
  }

  const fresh = proposals.filter((p) => !rejectedKey.has(`${p.kind}|${p.svid}|${p.vid ?? ''}`));
  // Upsert this run's proposals (ids stay stable while Carlos has the list open), then drop open
  // proposals that were not found again (no longer valid).
  const runStart = (await ctx.pool.query<{ t: Date }>(`SELECT now() AS t`)).rows[0]!.t;
  for (let i = 0; i < fresh.length; i += 1000) {
    await ctx.pool.query(
      `INSERT INTO upc_link_proposals (company_id, shop_domain, kind, variant_id, old_variant_id, link_id, shopify_variant_id, shopify_product_id,
                                       shopify_inventory_item_id, shopify_title, shopify_barcode, shopify_price_cents, shopify_compare_at_cents)
       SELECT $1, $2, r.kind, r.vid, r.old, r.link, r.svid, r.pid, r.inv, r.title, r.barcode, r.p, r.c
       FROM jsonb_to_recordset($3::jsonb) AS r(kind text, vid uuid, old uuid, link bigint, svid text, pid text, inv text, title text, barcode text, p int, c int)
       ON CONFLICT (company_id, shop_domain, shopify_variant_id) WHERE status = 'pending' DO UPDATE SET
         kind = EXCLUDED.kind, variant_id = EXCLUDED.variant_id, old_variant_id = EXCLUDED.old_variant_id, link_id = EXCLUDED.link_id,
         shopify_product_id = EXCLUDED.shopify_product_id, shopify_inventory_item_id = EXCLUDED.shopify_inventory_item_id,
         shopify_title = EXCLUDED.shopify_title, shopify_barcode = EXCLUDED.shopify_barcode,
         shopify_price_cents = EXCLUDED.shopify_price_cents, shopify_compare_at_cents = EXCLUDED.shopify_compare_at_cents, updated_at = now()`,
      [companyId, shop, JSON.stringify(fresh.slice(i, i + 1000))],
    );
  }
  await ctx.pool.query(
    `DELETE FROM upc_link_proposals WHERE company_id = $1 AND shop_domain = $2 AND status = 'pending' AND updated_at < $3`,
    [companyId, shop, runStart],
  );

  // Auto-approve ALL new & repointed UPC matches so Lightspeed ↔ Shopify links never get stuck waiting in "pending".
  const autoIds = (await ctx.pool.query<{ id: number }>(
    `SELECT id FROM upc_link_proposals WHERE company_id = $1 AND shop_domain = $2 AND status = 'pending' AND kind IN ('add', 'repoint')`,
    [companyId, shop],
  )).rows.map((r) => Number(r.id));
  let autoApproved = 0;
  if (autoIds.length) {
    autoApproved = (await decideUpcProposals(ctx, companyId, null, autoIds, 'approve')).updated;
    await ctx.pool.query(
      `UPDATE upc_link_proposals SET note = 'Auto-approved: UPC matched between Lightspeed and Shopify' WHERE id = ANY($1::bigint[])`,
      [autoIds],
    );
  }

  const count = (k: string) => fresh.filter((p) => p.kind === k).length;
  const summary = {
    shop, storeVariants: total, links: existing.rows.length, proposedAdd: count('add'), proposedRepoint: count('repoint'),
    proposedRemove: count('remove'), autoApprovedManual: autoApproved, removalsSuppressed, previouslyRejected: proposals.length - fresh.length, duplicateUpcsSkipped: dupSkipped,
  };
  await audit(ctx.pool, { companyId, action: 'shopify.upc_links_proposed', detail: summary });
  return summary;
}

function shopOf(ctx: AppContext) {
  return String(ctx.config.env.SHOPIFY_SHOP_DOMAIN ?? '').toLowerCase();
}

/** Proposals (with the Lightspeed item side) for the review screen. */
export async function listUpcProposals(ctx: AppContext, companyId: string, status: string, kind?: string) {
  const r = await ctx.pool.query(
    `SELECT p.id, p.kind, p.status, p.created_at, p.decided_at, p.note, u.name AS decided_by,
            p.shopify_variant_id, p.shopify_title, p.shopify_barcode, p.shopify_price_cents, p.shopify_compare_at_cents,
            v.id AS variant_id, v.title AS ls_title, v.upc AS ls_upc, v.sku AS ls_sku, v.price_cents AS ls_price_cents, v.compare_at_cents AS ls_compare_at_cents,
            COALESCE((SELECT sum(il.on_hand)::int FROM inventory_levels il WHERE il.variant_id = v.id), 0) AS ls_qty,
            (SELECT e.external_id FROM external_ids e WHERE e.entity_type = 'variant' AND e.entity_id = v.id AND e.system = 'lightspeed_r') AS ls_item_id,
            ov.title AS old_ls_title, ov.upc AS old_ls_upc
     FROM upc_link_proposals p
     LEFT JOIN variants v ON v.id = p.variant_id
     LEFT JOIN variants ov ON ov.id = p.old_variant_id
     LEFT JOIN users u ON u.id = p.decided_by
     WHERE p.company_id = $1 AND p.shop_domain = $2 AND p.status = $3 AND ($4::text IS NULL OR p.kind = $4)
     ORDER BY CASE p.kind WHEN 'repoint' THEN 0 WHEN 'remove' THEN 1 ELSE 2 END, ls_qty DESC NULLS LAST, p.id
     LIMIT 1000`,
    [companyId, shopOf(ctx), status, kind ?? null],
  );
  const counts = await ctx.pool.query<{ status: string; kind: string; n: number }>(
    `SELECT status, kind, count(*)::int n FROM upc_link_proposals WHERE company_id = $1 AND shop_domain = $2 GROUP BY 1, 2`,
    [companyId, shopOf(ctx)],
  );
  return { proposals: r.rows, counts: counts.rows, shop: shopOf(ctx), mode: ctx.config.env.SHOPIFY_SYNC_MODE };
}

/**
 * Carlos's decision. approve → the link is created / re-pointed / removed and the item is queued so
 * Shopify gets the Lightspeed price, sale price and stock within seconds. reject → never proposed again.
 * unlink (on an approved add) → removes the link; Shopify keeps its current price until Workstand changes it.
 */
export async function decideUpcProposals(ctx: AppContext, companyId: string, userId: string | null, ids: number[], decision: 'approve' | 'reject' | 'unlink') {
  const shop = shopOf(ctx);
  const wanted = decision === 'unlink' ? 'approved' : 'pending';
  const rows = await ctx.pool.query<{
    id: number; kind: string; variant_id: string | null; link_id: number | null; shopify_variant_id: string; shopify_product_id: string | null;
    shopify_inventory_item_id: string | null; shopify_price_cents: number | null; shopify_compare_at_cents: number | null;
  }>(
    `SELECT id, kind, variant_id, link_id, shopify_variant_id, shopify_product_id, shopify_inventory_item_id, shopify_price_cents, shopify_compare_at_cents
     FROM upc_link_proposals WHERE company_id = $1 AND shop_domain = $2 AND status = $3 AND id = ANY($4::bigint[])`,
    [companyId, shop, wanted, ids],
  );
  if (!rows.rows.length) return { updated: 0 };

  if (decision === 'reject') {
    await ctx.pool.query(`UPDATE upc_link_proposals SET status = 'rejected', decided_by = $2, decided_at = now(), updated_at = now() WHERE id = ANY($1::bigint[])`, [rows.rows.map((r) => r.id), userId]);
  } else if (decision === 'unlink') {
    const adds = rows.rows.filter((r) => r.kind === 'add' || r.kind === 'repoint');
    await ctx.pool.query(`DELETE FROM shopify_variant_links WHERE company_id = $1 AND shop_domain = $2 AND shopify_variant_id = ANY($3::text[])`, [companyId, shop, adds.map((r) => r.shopify_variant_id)]);
    await ctx.pool.query(`UPDATE upc_link_proposals SET status = 'unlinked', decided_by = $2, decided_at = now(), updated_at = now() WHERE id = ANY($1::bigint[])`, [adds.map((r) => r.id), userId]);
  } else {
    const push = new Set<string>();
    for (const r of rows.rows) {
      if (r.kind === 'add' && r.variant_id && r.shopify_product_id) {
        await ctx.pool.query(
          `INSERT INTO shopify_variant_links (company_id, shop_domain, variant_id, shopify_product_id, shopify_variant_id, shopify_inventory_item_id, match_method, last_price_cents, last_compare_at_cents)
           VALUES ($1, $2, $3, $4, $5, $6, 'barcode', $7, $8) ON CONFLICT (company_id, shop_domain, shopify_variant_id) DO NOTHING`,
          [companyId, shop, r.variant_id, r.shopify_product_id, r.shopify_variant_id, r.shopify_inventory_item_id, r.shopify_price_cents, r.shopify_compare_at_cents],
        );
        push.add(r.variant_id);
      } else if (r.kind === 'repoint' && r.variant_id) {
        await ctx.pool.query(
          `UPDATE shopify_variant_links SET variant_id = $3, last_price_cents = $4, last_compare_at_cents = $5, last_qty_by_location = '{}'::jsonb, updated_at = now()
           WHERE company_id = $1 AND shop_domain = $2 AND shopify_variant_id = $6`,
          [companyId, shop, r.variant_id, r.shopify_price_cents, r.shopify_compare_at_cents, r.shopify_variant_id],
        );
        push.add(r.variant_id);
      } else if (r.kind === 'remove') {
        await ctx.pool.query(`DELETE FROM shopify_variant_links WHERE company_id = $1 AND shop_domain = $2 AND shopify_variant_id = $3`, [companyId, shop, r.shopify_variant_id]);
      }
    }
    await ctx.pool.query(`UPDATE upc_link_proposals SET status = 'approved', decided_by = $2, decided_at = now(), updated_at = now() WHERE id = ANY($1::bigint[])`, [rows.rows.map((r) => r.id), userId]);
    if (push.size) {
      await ctx.pool.query(
        `INSERT INTO outbound_sync_staging (company_id, variant_id, stream, decision, hold_reasons, shopify_payload, status, updated_at)
         SELECT $1, vid, 'availability', 'ready_for_shopify', '[]'::jsonb, '{"trigger":"upc_link_approved"}'::jsonb, 'pending', now()
         FROM unnest($2::uuid[]) AS vid
         ON CONFLICT (company_id, variant_id, stream) DO UPDATE SET decision = 'ready_for_shopify', hold_reasons = '[]'::jsonb, status = 'pending', last_error = NULL, updated_at = now()`,
        [companyId, [...push]],
      );
      await enqueue(ctx.pool, { companyId, type: 'pipeline.flush_shopify', payload: { trigger: 'upc_link_approved' } });
    }
  }
  await audit(ctx.pool, { companyId, userId, action: `shopify.upc_links_${decision}`, detail: { count: rows.rows.length, ids: rows.rows.map((r) => r.id).slice(0, 200) } });
  return { updated: rows.rows.length };
}
