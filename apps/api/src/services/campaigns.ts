import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  applicableLines, chooseExecutionStrategy, evaluateCampaign, planRestore, type CampaignLine, type CampaignSummary,
} from '@ubc/business-rules';
import type { CampaignRules, ItemFilter, MapException, PosSyncEventType, PriceAdjustment } from '@ubc/shared';
import { withTransaction, type Pool, type PoolClient } from '@ubc/database';
import { getSettings, itemFilterSchema, loadAllMatching } from './catalog.js';
import { audit } from './audit.js';
import { conflict, HttpError, notFound, type AppContext } from './context.js';
import { enqueue, setProgress } from './jobs.js';

export const adjustmentSchema = z.object({
  type: z.enum(['percent_off', 'amount_off', 'percent_increase', 'amount_increase', 'set_price']),
  value: z.number().nonnegative(),
  rounding: z.enum(['none', 'charm_99', 'whole_dollar']).default('none'),
}).superRefine((a, ctx) => {
  if (a.type === 'percent_off' && a.value >= 1) ctx.addIssue({ code: 'custom', message: 'percent_off must be < 1 (fraction)' });
  if (a.type === 'percent_increase' && a.value > 5) ctx.addIssue({ code: 'custom', message: 'percent_increase looks wrong (fraction expected)' });
  if (a.type !== 'percent_off' && a.type !== 'percent_increase' && !Number.isInteger(a.value)) ctx.addIssue({ code: 'custom', message: 'amounts are integer cents' });
});

export const rulesSchema = z.object({
  minMarginPct: z.number().min(0).max(0.95),
  warnMarginPct: z.number().min(0).max(0.95),
  clampToMinMargin: z.boolean(),
  excludeWithoutCost: z.boolean(),
}).partial();

export const posSyncEventSchema = z.enum([
  'black_friday',
  'christmas',
  'holiday_sale',
  'annual_clearance',
  'special_event',
]);

export const campaignInputSchema = z.object({
  name: z.string().min(3).max(120),
  /** Default is 'online'; 'online_and_pos' is used only for major events (Black Friday, Navidad, etc.). */
  channel: z.enum(['online', 'online_and_pos']).default('online'),
  posEventType: posSyncEventSchema.optional(),
  selection: itemFilterSchema,
  adjustment: adjustmentSchema,
  rules: rulesSchema.optional(),
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
}).refine((c) => !c.startsAt || !c.endsAt || new Date(c.endsAt) > new Date(c.startsAt), { message: 'endsAt must be after startsAt' });

export type CampaignInput = z.infer<typeof campaignInputSchema>;

type Q = Pool | PoolClient;

async function mapExceptions(db: Q, companyId: string): Promise<MapException[]> {
  const r = await db.query<{ variant_id: string; approved_by: string; reference: string; valid_until: Date }>(
    `SELECT variant_id, approved_by, reference, valid_until FROM map_exceptions WHERE company_id = $1 AND valid_until > now()`, [companyId]);
  return r.rows.map((x) => ({ itemId: x.variant_id, approvedBy: x.approved_by, reference: x.reference, validUntil: new Date(x.valid_until).toISOString() }));
}

export function previewToken(lines: readonly CampaignLine[]): string {
  const h = createHash('sha256');
  for (const l of lines) h.update(`${l.itemId}:${l.oldPriceCents}:${l.newPriceCents}:${l.status}|`);
  return h.digest('hex').slice(0, 32);
}

export async function evaluate(db: Q, companyId: string, selection: ItemFilter, adj: PriceAdjustment, rules: Partial<CampaignRules> | undefined, channel: 'online' | 'online_and_pos') {
  const settings = await getSettings(db, companyId);
  const effective: CampaignRules = {
    ...settings.campaignRules,
    ...rules,
    excludeWithoutCost: rules?.excludeWithoutCost ?? settings.campaignRules.excludeWithoutCost,
  };
  const items = await loadAllMatching(db, companyId, selection, settings.availability);
  const { lines, summary } = evaluateCampaign(items, adj, { rules: effective, mapExceptions: await mapExceptions(db, companyId) });
  return { lines, summary, rules: effective, strategy: chooseExecutionStrategy(adj, channel, summary), token: previewToken(lines) };
}

async function storeLines(c: PoolClient, campaignId: string, lines: CampaignLine[]) {
  await c.query(`DELETE FROM campaign_lines WHERE campaign_id = $1`, [campaignId]);
  for (let i = 0; i < lines.length; i += 2000) {
    const chunk = lines.slice(i, i + 2000);
    await c.query(
      `INSERT INTO campaign_lines (campaign_id, variant_id, old_price_cents, new_price_cents, cost_cents, map_cents, status, reasons)
       SELECT $1, r.id, r.o, r.n, r.c, r.m, r.s, r.r FROM jsonb_to_recordset($2::jsonb) AS r(id uuid, o int, n int, c int, m int, s text, r jsonb)`,
      [campaignId, JSON.stringify(chunk.map((l) => ({ id: l.itemId, o: l.oldPriceCents, n: l.newPriceCents, c: l.costCents, m: l.mapCents, s: l.status, r: l.reasons })))],
    );
  }
}

function inferPosEventType(name: string, explicit?: PosSyncEventType): PosSyncEventType {
  if (explicit) return explicit;
  const n = name.toLowerCase();
  if (n.includes('black friday') || n.includes('cyber')) return 'black_friday';
  if (n.includes('navidad') || n.includes('christmas') || n.includes('xmas')) return 'christmas';
  if (n.includes('liquidaci') || n.includes('clearance')) return 'annual_clearance';
  return 'special_event';
}

export async function createCampaign(ctx: AppContext, companyId: string, userId: string, input: CampaignInput) {
  const ev = await evaluate(ctx.pool, companyId, input.selection, input.adjustment, input.rules, input.channel);
  const posEventType = input.channel === 'online_and_pos' ? inferPosEventType(input.name, input.posEventType) : null;
  return withTransaction(ctx.pool, async (c) => {
    const id = (await c.query<{ id: string }>(
      `INSERT INTO campaigns (company_id, name, channel, selection, adjustment, rules, strategy, starts_at, ends_at, summary, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [companyId, input.name, input.channel, JSON.stringify(input.selection), JSON.stringify(input.adjustment), JSON.stringify(ev.rules),
        ev.strategy, input.startsAt ?? null, input.endsAt ?? null, JSON.stringify({ ...ev.summary, previewToken: ev.token, posEventType }), userId],
    )).rows[0]!.id;
    await storeLines(c, id, ev.lines);
    await audit(c, { companyId, userId, action: 'campaign.created', entityType: 'campaign', entityId: id, detail: { summary: ev.summary, strategy: ev.strategy, channel: input.channel, posEventType } });
    return { id, summary: ev.summary, strategy: ev.strategy, previewToken: ev.token, posEventType };
  });
}

export async function updateCampaign(ctx: AppContext, companyId: string, userId: string, id: string, input: CampaignInput) {
  const existing = await getCampaign(ctx.pool, companyId, id);
  if (existing.status !== 'draft' && existing.status !== 'failed') {
    throw conflict('CAMPAIGN_NOT_EDITABLE', `Cannot edit a campaign in status ${existing.status}`);
  }
  const ev = await evaluate(ctx.pool, companyId, input.selection, input.adjustment, input.rules, input.channel);
  const posEventType = input.channel === 'online_and_pos' ? inferPosEventType(input.name, input.posEventType) : null;
  return withTransaction(ctx.pool, async (c) => {
    await c.query(
      `UPDATE campaigns
       SET name = $2, status = 'draft', channel = $3, selection = $4, adjustment = $5, rules = $6,
           strategy = $7, starts_at = $8, ends_at = $9, summary = $10, updated_at = now()
       WHERE id = $1 AND company_id = $11`,
      [id, input.name, input.channel, JSON.stringify(input.selection), JSON.stringify(input.adjustment),
        JSON.stringify(ev.rules), ev.strategy, input.startsAt ?? null, input.endsAt ?? null,
        JSON.stringify({ ...ev.summary, previewToken: ev.token, posEventType }), companyId],
    );
    await storeLines(c, id, ev.lines);
    await audit(c, { companyId, userId, action: 'campaign.updated', entityType: 'campaign', entityId: id, detail: { summary: ev.summary, strategy: ev.strategy, channel: input.channel, posEventType } });
    return { id, summary: ev.summary, strategy: ev.strategy, previewToken: ev.token, posEventType };
  });
}

interface CampaignRow {
  id: string; company_id: string; name: string; status: string; channel: 'online' | 'online_and_pos';
  selection: ItemFilter; adjustment: PriceAdjustment; rules: CampaignRules; strategy: string;
  starts_at: Date | null; ends_at: Date | null; summary: (CampaignSummary & { previewToken: string; posEventType?: PosSyncEventType | null }) | null;
  shopify_discount_id: string | null; updated_at: Date;
}

export async function getCampaign(db: Q, companyId: string, id: string): Promise<CampaignRow> {
  const r = await db.query<CampaignRow>(`SELECT * FROM campaigns WHERE company_id = $1 AND id = $2`, [companyId, id]);
  if (!r.rows[0]) throw notFound('Campaign');
  return r.rows[0];
}

/** Re-run the preview against current data. Used before scheduling and by the "refresh preview" button. */
export async function refreshPreview(ctx: AppContext, companyId: string, userId: string, id: string) {
  const camp = await getCampaign(ctx.pool, companyId, id);
  if (camp.status !== 'draft') throw conflict('CAMPAIGN_NOT_DRAFT', 'Only draft campaigns can be re-previewed');
  const ev = await evaluate(ctx.pool, companyId, camp.selection, camp.adjustment, camp.rules, camp.channel);
  const posEventType = camp.summary?.posEventType ?? (camp.channel === 'online_and_pos' ? inferPosEventType(camp.name) : null);
  await withTransaction(ctx.pool, async (c) => {
    await storeLines(c, id, ev.lines);
    await c.query(`UPDATE campaigns SET summary = $2, strategy = $3, updated_at = now() WHERE id = $1`, [id, JSON.stringify({ ...ev.summary, previewToken: ev.token, posEventType }), ev.strategy]);
    await audit(c, { companyId, userId, action: 'campaign.previewed', entityType: 'campaign', entityId: id });
  });
  return { summary: ev.summary, strategy: ev.strategy, previewToken: ev.token };
}

/**
 * Approve + schedule. Requires the preview token the approver saw: if prices,
 * costs or MAP changed since then, the token no longer matches and the
 * approver has to look at the new preview (409 PREVIEW_STALE).
 */
export async function approveCampaign(ctx: AppContext, companyId: string, userId: string, id: string, token: string) {
  const camp = await getCampaign(ctx.pool, companyId, id);
  if (camp.status !== 'draft') throw conflict('CAMPAIGN_NOT_DRAFT', `Campaign is ${camp.status}`);
  const ev = await evaluate(ctx.pool, companyId, camp.selection, camp.adjustment, camp.rules, camp.channel);
  if (ev.token !== token) {
    throw conflict('PREVIEW_STALE', 'Catalog data changed since this preview. Review the refreshed preview before approving.', { previewToken: ev.token, summary: ev.summary });
  }
  if (ev.summary.ok + ev.summary.warning === 0) throw new HttpError(422, 'NOTHING_TO_APPLY', 'No line passes the commercial rules');
  const now = Date.now();
  const startNow = !camp.starts_at || new Date(camp.starts_at).getTime() <= now;
  if (camp.ends_at && new Date(camp.ends_at).getTime() <= now) throw new HttpError(422, 'ENDS_IN_PAST', 'Campaign end date is in the past');
  return withTransaction(ctx.pool, async (c) => {
    await c.query(`UPDATE campaigns SET status = 'scheduled', approved_by = $2, approved_at = now(), updated_at = now() WHERE id = $1`, [id, userId]);
    await audit(c, { companyId, userId, action: 'campaign.approved', entityType: 'campaign', entityId: id, detail: { summary: ev.summary, startNow, channel: camp.channel, posEventType: camp.summary?.posEventType ?? null } });
    let jobId: number | null = null;
    if (startNow) jobId = (await enqueue(c, { companyId, type: 'campaign.apply', payload: { campaignId: id }, idempotencyKey: `campaign:apply:${id}`, createdBy: userId })).id;
    return { status: 'scheduled', jobId, startNow };
  });
}

export async function requestRestore(ctx: AppContext, companyId: string, userId: string | null, id: string) {
  const camp = await getCampaign(ctx.pool, companyId, id);
  if (camp.status !== 'active') throw conflict('CAMPAIGN_NOT_ACTIVE', `Campaign is ${camp.status}`);
  const job = await enqueue(ctx.pool, { companyId, type: 'campaign.restore', payload: { campaignId: id }, idempotencyKey: `campaign:restore:${id}`, createdBy: userId });
  await audit(ctx.pool, { companyId, userId, action: 'campaign.restore_requested', entityType: 'campaign', entityId: id });
  return { jobId: job.id };
}

export async function cancelCampaign(ctx: AppContext, companyId: string, userId: string, id: string) {
  const r = await ctx.pool.query(`UPDATE campaigns SET status = 'cancelled', updated_at = now() WHERE company_id = $1 AND id = $2 AND status IN ('draft','scheduled')`, [companyId, id]);
  if (!r.rowCount) throw conflict('CANNOT_CANCEL', 'Only draft or scheduled campaigns can be cancelled (restore an active one instead)');
  await audit(ctx.pool, { companyId, userId, action: 'campaign.cancelled', entityType: 'campaign', entityId: id });
}

interface LineRow { variant_id: string; old_price_cents: number; new_price_cents: number; compare_at_cents: number | null; status: string; applied_at: Date | null; product_id: string; shopify_variant_id: string | null; shopify_product_id: string | null; lightspeed_item_id: string | null }

/** Job handler: apply an approved campaign in chunks with optimistic guards. */
export async function applyCampaignJob(ctx: AppContext, companyId: string, campaignId: string, jobId: number) {
  const camp = await getCampaign(ctx.pool, companyId, campaignId);
  if (camp.status === 'active') return { alreadyActive: true };
  if (camp.status !== 'scheduled' && camp.status !== 'applying') throw Object.assign(new Error(`Campaign is ${camp.status}`), { code: 'INVALID_TRANSITION' });
  await ctx.pool.query(`UPDATE campaigns SET status = 'applying', updated_at = now() WHERE id = $1`, [campaignId]);

  // Re-evaluate at execution time: rules are checked against the data as it is *now*.
  const ev = await evaluate(ctx.pool, companyId, camp.selection, camp.adjustment, camp.rules, camp.channel);
  await withTransaction(ctx.pool, (c) => storeLines(c, campaignId, ev.lines));
  const todo = applicableLines(ev.lines);
  const strategy = camp.strategy as 'shopify_automatic_discount' | 'variant_price_update';
  let applied = 0;
  let skippedChanged = 0;

  if (strategy === 'shopify_automatic_discount') {
    // Prices in our catalog stay untouched; Shopify computes the discount at checkout.
    const updateOnly = ctx.config.env.SHOPIFY_SYNC_MODE === 'update_only';
    const products = updateOnly
      ? { rows: [] as { external_id: string }[] }
      : await ctx.pool.query<{ external_id: string }>(
        `SELECT DISTINCT e.external_id FROM campaign_lines cl JOIN variants v ON v.id = cl.variant_id
         JOIN external_ids e ON e.entity_type = 'product' AND e.entity_id = v.product_id AND e.system = 'shopify'
         WHERE cl.campaign_id = $1 AND cl.status IN ('ok','warning')`, [campaignId]);
    // Workstand-owned store: one Shopify product groups several sizes/colors, so target the exact
    // variants matched by UPC (never the whole product: other variants may be excluded or under MAP).
    const variants = updateOnly
      ? await ctx.pool.query<{ shopify_variant_id: string }>(
        `SELECT DISTINCT l.shopify_variant_id FROM campaign_lines cl
         JOIN shopify_variant_links l ON l.variant_id = cl.variant_id AND l.company_id = $2 AND l.shop_domain = $3
         WHERE cl.campaign_id = $1 AND cl.status IN ('ok','warning')`,
        [campaignId, companyId, String(ctx.config.env.SHOPIFY_SHOP_DOMAIN ?? '').toLowerCase()])
      : { rows: [] as { shopify_variant_id: string }[] };
    if (updateOnly && !variants.rows.length) {
      throw Object.assign(new Error('None of the campaign items exist in the Shopify store (no UPC match)'), { code: 'NO_SHOPIFY_TARGETS' });
    }
    const discountId = await ctx.connectors.shopify.createAutomaticDiscount({
      title: camp.name,
      percentOff: camp.adjustment.type === 'percent_off' ? camp.adjustment.value : undefined,
      amountOffCents: camp.adjustment.type === 'amount_off' ? camp.adjustment.value : undefined,
      productIds: products.rows.map((r) => r.external_id),
      variantIds: updateOnly ? variants.rows.map((r) => r.shopify_variant_id) : undefined,
      startsAt: new Date().toISOString(),
      endsAt: camp.ends_at ? new Date(camp.ends_at).toISOString() : null,
    });
    await ctx.pool.query(`UPDATE campaigns SET shopify_discount_id = $2 WHERE id = $1`, [campaignId, discountId]);
    await ctx.pool.query(`UPDATE campaign_lines SET applied_at = now() WHERE campaign_id = $1 AND status IN ('ok','warning')`, [campaignId]);
    applied = todo.length;
  } else {
    for (let i = 0; i < todo.length; i += 250) {
      const chunk = todo.slice(i, i + 250);
      const changed = await withTransaction(ctx.pool, async (c) => {
        // Guard: only update when the price is still the one we evaluated.
        const upd = await c.query<{ id: string }>(
          `UPDATE variants v SET price_cents = r.n, version = v.version + 1, updated_at = now()
           FROM jsonb_to_recordset($2::jsonb) AS r(id uuid, o int, n int)
           WHERE v.company_id = $1 AND v.id = r.id AND v.price_cents = r.o RETURNING v.id`,
          [companyId, JSON.stringify(chunk.map((l) => ({ id: l.itemId, o: l.oldPriceCents, n: l.newPriceCents })))],
        );
        const ok = new Set(upd.rows.map((r) => r.id));
        const okLines = chunk.filter((l) => ok.has(l.itemId));
        if (okLines.length) {
          await c.query(
            `INSERT INTO price_history (company_id, variant_id, old_price_cents, new_price_cents, source, campaign_id, actor_user_id)
             SELECT $1, r.id, r.o, r.n, 'campaign', $2, NULL FROM jsonb_to_recordset($3::jsonb) AS r(id uuid, o int, n int)`,
            [companyId, campaignId, JSON.stringify(okLines.map((l) => ({ id: l.itemId, o: l.oldPriceCents, n: l.newPriceCents })))],
          );
          await c.query(`UPDATE campaign_lines SET applied_at = now() WHERE campaign_id = $1 AND variant_id = ANY($2::uuid[])`, [campaignId, okLines.map((l) => l.itemId)]);
        }
        return chunk.length - okLines.length;
      });
      skippedChanged += changed;
      applied += chunk.length - changed;
      await setProgress(ctx.pool, jobId, { done: Math.min(i + 250, todo.length), total: todo.length, applied, skippedChanged });
    }
    await pushPrices(ctx, campaignId, camp.channel, 'new', jobId);
  }

  const posEventType = camp.summary?.posEventType ?? null;
  await withTransaction(ctx.pool, async (c) => {
    await c.query(`UPDATE campaigns SET status = 'active', summary = $2, updated_at = now() WHERE id = $1`,
      [campaignId, JSON.stringify({ ...ev.summary, previewToken: ev.token, posEventType, applied, skippedChanged })]);
    await audit(c, { companyId, action: 'campaign.applied', entityType: 'campaign', entityId: campaignId, detail: { applied, skippedChanged, strategy, channel: camp.channel, posEventType } });
  });
  return { applied, skippedChanged, strategy };
}

/**
 * Push applied (or restored) prices to Shopify Plus, and to Lightspeed POS
 * ONLY for authorised omnichannel event campaigns (`channel === 'online_and_pos'`,
 * e.g. Black Friday, Navidad).
 */
async function pushPrices(ctx: AppContext, campaignId: string, channel: string, which: 'new' | 'old', jobId?: number) {
  const buildPosUpdate = (l: { lightspeed_item_id: string; old_price_cents: number; new_price_cents: number; compare_at_cents: number | null }) => {
    if (which === 'new') {
      const regular = Math.max(l.old_price_cents, l.compare_at_cents ?? 0);
      return {
        lightspeedItemId: l.lightspeed_item_id,
        priceCents: l.new_price_cents,
        regularPriceCents: regular > l.new_price_cents ? regular : null,
      };
    }
    const preRegular = l.compare_at_cents && l.compare_at_cents > l.old_price_cents ? l.compare_at_cents : null;
    return {
      lightspeedItemId: l.lightspeed_item_id,
      priceCents: l.old_price_cents,
      regularPriceCents: preRegular,
    };
  };

  if (ctx.config.env.SHOPIFY_SYNC_MODE === 'update_only') {
    await pushPricesUpdateOnly(ctx, campaignId, which, jobId);
    if (channel === 'online_and_pos') {
      const pl = await ctx.pool.query<{ lightspeed_item_id: string | null; old_price_cents: number; new_price_cents: number; compare_at_cents: number | null }>(
        `SELECT cl.old_price_cents, cl.new_price_cents, v.compare_at_cents,
                (SELECT external_id FROM external_ids e WHERE e.entity_type='variant' AND e.entity_id=cl.variant_id AND e.system='lightspeed_r') AS lightspeed_item_id
         FROM campaign_lines cl
         JOIN variants v ON v.id = cl.variant_id
         WHERE cl.campaign_id = $1 AND cl.applied_at IS NOT NULL AND ${which === 'old' ? `cl.restore_result = 'restored'` : 'cl.restored_at IS NULL'}`,
        [campaignId]);
      const pos = pl.rows
        .filter((l): l is typeof l & { lightspeed_item_id: string } => Boolean(l.lightspeed_item_id))
        .map(buildPosUpdate);
      if (pos.length) await ctx.connectors.pos.updatePrices(pos);
    }
    return;
  }
  const lines = await ctx.pool.query<LineRow>(
    `SELECT cl.variant_id, cl.old_price_cents, cl.new_price_cents, v.compare_at_cents, cl.status, cl.applied_at, v.product_id,
            (SELECT external_id FROM external_ids e WHERE e.entity_type='variant' AND e.entity_id=v.id AND e.system='shopify') AS shopify_variant_id,
            (SELECT external_id FROM external_ids e WHERE e.entity_type='product' AND e.entity_id=v.product_id AND e.system='shopify') AS shopify_product_id,
            (SELECT external_id FROM external_ids e WHERE e.entity_type='variant' AND e.entity_id=v.id AND e.system='lightspeed_r') AS lightspeed_item_id
     FROM campaign_lines cl JOIN variants v ON v.id = cl.variant_id
     WHERE cl.campaign_id = $1 AND cl.applied_at IS NOT NULL AND ${which === 'old' ? `cl.restore_result = 'restored'` : 'cl.restored_at IS NULL'}`,
    [campaignId]);
  const byProduct = new Map<string, { variantId: string; priceCents: number; compareAtCents: number | null }[]>();
  for (const l of lines.rows) {
    if (!l.shopify_product_id || !l.shopify_variant_id) continue;
    const arr = byProduct.get(l.shopify_product_id) ?? [];
    arr.push({ variantId: l.shopify_variant_id, priceCents: which === 'new' ? l.new_price_cents : l.old_price_cents, compareAtCents: which === 'new' ? l.old_price_cents : null });
    byProduct.set(l.shopify_product_id, arr);
  }

  // Bounded 4-way concurrency across products; ShopifyAdminClient enforces leaky-bucket cost pacing automatically.
  const entries = [...byProduct.entries()];
  const CONCURRENCY = 4;
  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    const wave = entries.slice(i, i + CONCURRENCY);
    await Promise.all(wave.map(([pid, updates]) => ctx.connectors.shopify.updateVariantPrices(pid, updates)));
    if (jobId && (i + CONCURRENCY) % 40 === 0) {
      await setProgress(ctx.pool, jobId, {
        phase: 'shopify_price_push',
        pushedProducts: Math.min(i + CONCURRENCY, entries.length),
        totalProducts: entries.length,
      });
    }
  }

  if (channel === 'online_and_pos') {
    const pos = lines.rows
      .filter((l): l is LineRow & { lightspeed_item_id: string } => Boolean(l.lightspeed_item_id))
      .map(buildPosUpdate);
    if (pos.length) await ctx.connectors.pos.updatePrices(pos);
  }
}

/**
 * Workstand-owned store (SHOPIFY_SYNC_MODE=update_only): push to the variants matched by UPC in
 * `shopify_variant_links`. Promo price with the regular price crossed out (the higher of the
 * pre-promo price and Lightspeed's Default when the item already had a SALE PRICE); on restore,
 * back to the current Lightspeed price. Every write is logged in `shopify_price_log`.
 */
async function pushPricesUpdateOnly(ctx: AppContext, campaignId: string, which: 'new' | 'old', jobId?: number) {
  const shop = String(ctx.config.env.SHOPIFY_SHOP_DOMAIN ?? '').toLowerCase();
  type Row = {
    link_id: number; variant_id: string; company_id: string; shopify_product_id: string; shopify_variant_id: string;
    last_price_cents: number | null; last_compare_at_cents: number | null;
    old_price_cents: number; new_price_cents: number; compare_at_cents: number | null; price_cents: number;
  };
  const rows = await ctx.pool.query<Row>(
    `SELECT l.id AS link_id, l.variant_id, l.company_id, l.shopify_product_id, l.shopify_variant_id, l.last_price_cents, l.last_compare_at_cents,
            cl.old_price_cents, cl.new_price_cents, v.compare_at_cents, v.price_cents
     FROM campaign_lines cl
     JOIN variants v ON v.id = cl.variant_id
     JOIN shopify_variant_links l ON l.variant_id = cl.variant_id AND l.shop_domain = $2 AND l.company_id = v.company_id
     WHERE cl.campaign_id = $1 AND cl.applied_at IS NOT NULL AND ${which === 'old' ? `cl.restore_result = 'restored'` : 'cl.restored_at IS NULL'}`,
    [campaignId, shop]);
  const byProduct = new Map<string, Row[]>();
  for (const r of rows.rows) byProduct.set(r.shopify_product_id, [...(byProduct.get(r.shopify_product_id) ?? []), r]);
  const target = (r: Row) => {
    if (which === 'new') {
      const regular = Math.max(r.old_price_cents, r.compare_at_cents ?? 0);
      return { p: r.new_price_cents, c: regular > r.new_price_cents ? regular : null };
    }
    const p = r.price_cents;
    return { p, c: r.compare_at_cents && r.compare_at_cents > p ? r.compare_at_cents : null };
  };
  const entries = [...byProduct.entries()];
  let done = 0;
  for (let i = 0; i < entries.length; i += 4) {
    const wave = entries.slice(i, i + 4);
    await Promise.all(wave.map(async ([pid, rs]) => {
      const ups = rs.map((r) => ({ r, ...target(r) }));
      await ctx.connectors.shopify.updateVariantPrices(pid, ups.map((u) => ({ variantId: u.r.shopify_variant_id, priceCents: u.p, compareAtCents: u.c })));
      await ctx.pool.query(
        `INSERT INTO shopify_price_log (company_id, shop_domain, variant_id, shopify_variant_id, old_price_cents, old_compare_at_cents, new_price_cents, new_compare_at_cents, source)
         SELECT r.co, $1, r.vid, r.svid, r.op, r.oc, r.np, r.nc, $2
         FROM jsonb_to_recordset($3::jsonb) AS r(co uuid, vid uuid, svid text, op int, oc int, np int, nc int)`,
        [shop, which === 'new' ? `campaign:${campaignId}` : `campaign_restore:${campaignId}`, JSON.stringify(ups.map((u) => ({
          co: u.r.company_id, vid: u.r.variant_id, svid: u.r.shopify_variant_id, op: u.r.last_price_cents, oc: u.r.last_compare_at_cents, np: u.p, nc: u.c,
        })))],
      );
      await ctx.pool.query(
        `UPDATE shopify_variant_links l SET last_price_cents = r.p, last_compare_at_cents = r.c, last_pushed_at = now(), updated_at = now()
         FROM jsonb_to_recordset($1::jsonb) AS r(id bigint, p int, c int) WHERE l.id = r.id`,
        [JSON.stringify(ups.map((u) => ({ id: u.r.link_id, p: u.p, c: u.c })))],
      );
    }));
    done += wave.length;
    if (jobId && done % 40 < 4) await setProgress(ctx.pool, jobId, { phase: 'shopify_price_push', pushedProducts: done, totalProducts: entries.length });
  }
}

export async function restoreCampaignJob(ctx: AppContext, companyId: string, campaignId: string) {
  const camp = await getCampaign(ctx.pool, companyId, campaignId);
  if (camp.status === 'restored') return { alreadyRestored: true };
  await ctx.pool.query(`UPDATE campaigns SET status = 'restoring', updated_at = now() WHERE id = $1`, [campaignId]);
  if (camp.strategy === 'shopify_automatic_discount') {
    if (camp.shopify_discount_id) await ctx.connectors.shopify.deactivateAutomaticDiscount(camp.shopify_discount_id);
    await ctx.pool.query(`UPDATE campaign_lines SET restore_result = 'restored', restored_at = now() WHERE campaign_id = $1 AND applied_at IS NOT NULL`, [campaignId]);
  } else {
    const lines = await ctx.pool.query<{ variant_id: string; old_price_cents: number; new_price_cents: number; applied_at: Date | null; price_cents: number }>(
      `SELECT cl.variant_id, cl.old_price_cents, cl.new_price_cents, cl.applied_at, v.price_cents
       FROM campaign_lines cl JOIN variants v ON v.id = cl.variant_id WHERE cl.campaign_id = $1 AND cl.status IN ('ok','warning')`, [campaignId]);
    const current = new Map(lines.rows.map((l) => [l.variant_id, l.price_cents]));
    const plan = planRestore(lines.rows.map((l) => ({ itemId: l.variant_id, oldPriceCents: l.old_price_cents, newPriceCents: l.new_price_cents, applied: !!l.applied_at })), (id) => current.get(id));
    for (let i = 0; i < plan.length; i += 500) {
      const chunk = plan.slice(i, i + 500);
      await withTransaction(ctx.pool, async (c) => {
        const restore = chunk.filter((p) => p.action === 'restore');
        const upd = await c.query<{ id: string }>(
          `UPDATE variants v SET price_cents = r.t, version = v.version + 1, updated_at = now()
           FROM jsonb_to_recordset($2::jsonb) AS r(id uuid, f int, t int)
           WHERE v.company_id = $1 AND v.id = r.id AND v.price_cents = r.f RETURNING v.id`,
          [companyId, JSON.stringify(restore.map((p) => ({ id: p.itemId, f: p.fromCents, t: p.toCents })))],
        );
        const done = new Set(upd.rows.map((r) => r.id));
        const results = chunk.map((p) => ({
          id: p.itemId,
          r: p.action === 'restore' && done.has(p.itemId) ? 'restored' : p.action === 'skip_not_applied' ? 'skipped_not_applied' : 'skipped_changed',
        }));
        await c.query(
          `UPDATE campaign_lines cl SET restore_result = r.r, restored_at = now() FROM jsonb_to_recordset($2::jsonb) AS r(id uuid, r text)
           WHERE cl.campaign_id = $1 AND cl.variant_id = r.id`, [campaignId, JSON.stringify(results)]);
        const hist = restore.filter((p) => done.has(p.itemId));
        if (hist.length) {
          await c.query(
            `INSERT INTO price_history (company_id, variant_id, old_price_cents, new_price_cents, source, campaign_id)
             SELECT $1, r.id, r.f, r.t, 'restore', $2 FROM jsonb_to_recordset($3::jsonb) AS r(id uuid, f int, t int)`,
            [companyId, campaignId, JSON.stringify(hist.map((p) => ({ id: p.itemId, f: p.fromCents, t: p.toCents })))]);
        }
      });
    }
    await pushPrices(ctx, campaignId, camp.channel, 'old');
  }
  const counts = await ctx.pool.query<{ restore_result: string | null; n: number }>(
    `SELECT restore_result, count(*)::int n FROM campaign_lines WHERE campaign_id = $1 AND status IN ('ok','warning') GROUP BY 1`, [campaignId]);
  const result = Object.fromEntries(counts.rows.map((r) => [r.restore_result ?? 'none', r.n]));
  await withTransaction(ctx.pool, async (c) => {
    await c.query(`UPDATE campaigns SET status = 'restored', updated_at = now() WHERE id = $1`, [campaignId]);
    await audit(c, { companyId, action: 'campaign.restored', entityType: 'campaign', entityId: campaignId, detail: result });
  });
  return result;
}

/** Called by the worker loop: start due campaigns and end expired ones. */
export async function runScheduler(ctx: AppContext) {
  const due = await ctx.pool.query<{ id: string; company_id: string }>(`SELECT id, company_id FROM campaigns WHERE status = 'scheduled' AND (starts_at IS NULL OR starts_at <= now())`);
  for (const c of due.rows) await enqueue(ctx.pool, { companyId: c.company_id, type: 'campaign.apply', payload: { campaignId: c.id }, idempotencyKey: `campaign:apply:${c.id}` });
  const ended = await ctx.pool.query<{ id: string; company_id: string }>(`SELECT id, company_id FROM campaigns WHERE status = 'active' AND ends_at IS NOT NULL AND ends_at <= now()`);
  for (const c of ended.rows) await enqueue(ctx.pool, { companyId: c.company_id, type: 'campaign.restore', payload: { campaignId: c.id }, idempotencyKey: `campaign:restore:${c.id}` });
  return { started: due.rowCount ?? 0, ended: ended.rowCount ?? 0 };
}
