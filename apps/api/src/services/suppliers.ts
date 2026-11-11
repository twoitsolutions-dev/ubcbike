import { z } from 'zod';
import { findBestMatch } from '@ubc/business-rules';
import { mapFeed, type SupplierCatalogRecord } from '@ubc/integrations';
import { withTransaction } from '@ubc/database';
import { audit } from './audit.js';
import { notFound, type AppContext } from './context.js';

export const importSchema = z.object({
  csv: z.string().min(1).max(20_000_000),
  mapping: z.object({
    supplierSku: z.string(), brand: z.string(), title: z.string(),
    mpn: z.string().optional(), upc: z.string().optional(), category: z.string().optional(),
    cost: z.string().optional(), msrp: z.string().optional(), map: z.string().optional(),
    qty: z.string().optional(), dropShip: z.string().optional(), leadDays: z.string().optional(),
  }),
  contentLicensed: z.boolean().default(false),
});

/**
 * Import supplier records (from a feed file or a connector), upsert offers and
 * resolve identity: auto-match only on safe evidence; everything doubtful goes
 * to the manual review queue. Never creates duplicate catalog products.
 */
export async function importSupplierRecords(ctx: AppContext, companyId: string, supplierCode: string, records: SupplierCatalogRecord[]) {
  const sup = await ctx.pool.query<{ id: string }>(`SELECT id FROM suppliers WHERE company_id = $1 AND code = $2`, [companyId, supplierCode]);
  if (!sup.rows[0]) throw notFound('Supplier');
  const supplierId = sup.rows[0].id;
  const stats = { upserted: 0, autoMatched: 0, review: 0, unmatched: 0, alreadyLinked: 0 };
  for (let i = 0; i < records.length; i += 500) {
    const chunk = records.slice(i, i + 500);
    await withTransaction(ctx.pool, async (c) => {
      const up = await c.query<{ id: string; variant_id: string | null; supplier_sku: string }>(
        `INSERT INTO supplier_offers (company_id, supplier_id, supplier_sku, brand, title, upc, mpn, cost_cents, msrp_cents, map_cents, qty_available, drop_ship, lead_days, content_licensed, reported_at)
         SELECT $1, $2, r.sku, r.brand, r.title, r.upc, r.mpn, r.cost, r.msrp, r.map, r.qty, r.drop, r.lead, r.lic, now()
         FROM jsonb_to_recordset($3::jsonb) AS r(sku text, brand text, title text, upc text, mpn text, cost int, msrp int, map int, qty int, drop boolean, lead int, lic boolean)
         ON CONFLICT (company_id, supplier_id, supplier_sku) DO UPDATE SET
           cost_cents = EXCLUDED.cost_cents, msrp_cents = EXCLUDED.msrp_cents, map_cents = EXCLUDED.map_cents, qty_available = EXCLUDED.qty_available,
           drop_ship = EXCLUDED.drop_ship, lead_days = EXCLUDED.lead_days, title = EXCLUDED.title, brand = EXCLUDED.brand,
           upc = EXCLUDED.upc, mpn = EXCLUDED.mpn, content_licensed = EXCLUDED.content_licensed, reported_at = now(), updated_at = now()
         RETURNING id, variant_id, supplier_sku`,
        [companyId, supplierId, JSON.stringify(chunk.map((r) => ({
          sku: r.supplierSku, brand: r.brand, title: r.title, upc: r.upc, mpn: r.mpn, cost: r.costCents, msrp: r.msrpCents, map: r.mapCents,
          qty: r.qtyAvailable, drop: r.dropShip, lead: r.leadDays, lic: r.contentLicensed,
        })))]);
      stats.upserted += up.rowCount ?? 0;
      for (const row of up.rows) {
        if (row.variant_id) { stats.alreadyLinked++; continue; }
        const rec = chunk.find((r) => r.supplierSku === row.supplier_sku)!;
        // Candidate set: same UPC, or same MPN (any brand spelling) — the rules decide.
        const cands = await c.query<{ id: string; brand: string; mpn: string | null; upc: string | null; title: string }>(
          `SELECT v.id, p.brand, v.mpn, v.upc, v.title FROM variants v JOIN products p ON p.id = v.product_id
           WHERE v.company_id = $1 AND ((v.upc IS NOT NULL AND ltrim(v.upc,'0') = ltrim($2,'0')) OR (v.mpn IS NOT NULL AND upper(regexp_replace(v.mpn,'[^A-Za-z0-9]','','g')) = upper(regexp_replace($3,'[^A-Za-z0-9]','','g'))))
           LIMIT 20`, [companyId, rec.upc ?? '', rec.mpn ?? '']);
        const best = findBestMatch({ brand: rec.brand, mpn: rec.mpn, upc: rec.upc, title: rec.title }, cands.rows);
        if (best?.decision === 'auto_match') {
          await c.query(`UPDATE supplier_offers SET variant_id = $2 WHERE id = $1`, [row.id, best.item.id]);
          stats.autoMatched++;
        } else if (best?.decision === 'review') {
          await c.query(`INSERT INTO match_reviews (company_id, offer_id, candidate_variant_id, score, reasons) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
            [companyId, row.id, best.item.id, best.score.toFixed(3), JSON.stringify(best.reasons)]);
          stats.review++;
        } else stats.unmatched++;
      }
    });
  }
  await audit(ctx.pool, { companyId, action: 'supplier.imported', entityType: 'supplier', entityId: supplierCode, detail: stats });
  return stats;
}

export async function importFeedJob(ctx: AppContext, companyId: string, payload: z.infer<typeof importSchema> & { supplierCode: string }) {
  const { records, errors } = mapFeed(payload.csv, payload.mapping, { contentLicensed: payload.contentLicensed, defaultLeadDays: 5 });
  const stats = await importSupplierRecords(ctx, companyId, payload.supplierCode, records);
  return { ...stats, rowErrors: errors.slice(0, 200), rowErrorCount: errors.length };
}

export async function resolveReview(ctx: AppContext, companyId: string, userId: string, reviewId: string, decision: 'approved' | 'rejected') {
  return withTransaction(ctx.pool, async (c) => {
    const r = await c.query<{ offer_id: string; candidate_variant_id: string }>(
      `UPDATE match_reviews SET status = $3, resolved_by = $4, resolved_at = now() WHERE company_id = $1 AND id = $2 AND status = 'pending' RETURNING offer_id, candidate_variant_id`,
      [companyId, reviewId, decision, userId]);
    if (!r.rows[0]) throw notFound('Pending review');
    if (decision === 'approved') await c.query(`UPDATE supplier_offers SET variant_id = $2 WHERE id = $1`, [r.rows[0].offer_id, r.rows[0].candidate_variant_id]);
    await audit(c, { companyId, userId, action: `match.${decision}`, entityType: 'match_review', entityId: reviewId });
    return { status: decision };
  });
}
