import type { Pool } from 'pg';
import { z } from 'zod';
import type { AppContext } from './context.js';
import { audit } from './audit.js';

export interface ShippingBoxSpec {
  name: string;
  lengthIn: number;
  widthIn: number;
  heightIn: number;
  defaultWeightLb: number;
  fallbackCents: number;
}

export interface ShippingRules {
  enabled: boolean;
  originPostalCode: string;
  originProvince: string;
  originCountry: string;
  handlingFeePct: number;
  blockUspsOnBikes: boolean;
  easypostApiKey: string;
  carrierServiceId: string | null;
  boxes: {
    medium: ShippingBoxSpec;
    bike: ShippingBoxSpec;
    ebike: ShippingBoxSpec;
  };
}

export const DEFAULT_SHIPPING_RULES: ShippingRules = {
  enabled: true,
  originPostalCode: '33612',
  originProvince: 'FL',
  originCountry: 'US',
  handlingFeePct: 0.10,
  blockUspsOnBikes: true,
  easypostApiKey: '',
  carrierServiceId: null,
  boxes: {
    medium: { name: 'Medium Box', lengthIn: 12, widthIn: 12, heightIn: 12, defaultWeightLb: 8, fallbackCents: 1295 },
    bike: { name: 'Bicycles', lengthIn: 40, widthIn: 12, heightIn: 26, defaultWeightLb: 50, fallbackCents: 14500 },
    ebike: { name: 'E-Bike', lengthIn: 63, widthIn: 12, heightIn: 34, defaultWeightLb: 86, fallbackCents: 22500 },
  },
};

const boxSchema = z.object({
  name: z.string().min(1).max(60),
  lengthIn: z.number().min(1).max(120),
  widthIn: z.number().min(1).max(120),
  heightIn: z.number().min(1).max(120),
  defaultWeightLb: z.number().min(0.1).max(300),
  fallbackCents: z.number().int().min(0).max(500000),
});

export const shippingRulesSchema = z.object({
  enabled: z.boolean().default(true),
  originPostalCode: z.string().min(3).max(16),
  originProvince: z.string().min(2).max(10).default('FL'),
  originCountry: z.string().min(2).max(2).default('US'),
  handlingFeePct: z.number().min(0).max(1),
  blockUspsOnBikes: z.boolean().default(true),
  easypostApiKey: z.string().max(200).optional(),
  boxes: z.object({
    medium: boxSchema,
    bike: boxSchema,
    ebike: boxSchema,
  }),
});

export async function getShippingRules(db: Pool, companyId: string, maskSecret = false): Promise<ShippingRules> {
  const r = await db.query<{ shipping_rules?: Partial<ShippingRules> | null }>(
    `SELECT shipping_rules FROM company_settings WHERE company_id = $1`,
    [companyId],
  );
  const raw = r.rows[0]?.shipping_rules || {};
  const merged: ShippingRules = {
    ...DEFAULT_SHIPPING_RULES,
    ...raw,
    boxes: {
      medium: { ...DEFAULT_SHIPPING_RULES.boxes.medium, ...(raw.boxes?.medium || {}) },
      bike: { ...DEFAULT_SHIPPING_RULES.boxes.bike, ...(raw.boxes?.bike || {}) },
      ebike: { ...DEFAULT_SHIPPING_RULES.boxes.ebike, ...(raw.boxes?.ebike || {}) },
    },
  };
  if (maskSecret && merged.easypostApiKey) {
    merged.easypostApiKey = merged.easypostApiKey.length > 8
      ? `${merged.easypostApiKey.slice(0, 4)}••••${merged.easypostApiKey.slice(-4)}`
      : '••••••••';
  }
  return merged;
}

export async function saveShippingRules(
  ctx: AppContext,
  companyId: string,
  userId: string,
  input: z.infer<typeof shippingRulesSchema>,
): Promise<ShippingRules> {
  const current = await getShippingRules(ctx.pool, companyId, false);
  const incomingKey = input.easypostApiKey?.trim();
  const nextKey = incomingKey && !incomingKey.includes('••••') ? incomingKey : current.easypostApiKey;
  const next: ShippingRules = {
    ...current,
    ...input,
    easypostApiKey: nextKey,
  };
  await ctx.pool.query(
    `UPDATE company_settings SET shipping_rules = $2, updated_at = now() WHERE company_id = $1`,
    [companyId, JSON.stringify(next)],
  );
  await audit(ctx.pool, { companyId, userId, action: 'shipping.rules_updated', detail: { origin: next.originPostalCode, handlingFeePct: next.handlingFeePct, hasEasypost: !!next.easypostApiKey } });
  return getShippingRules(ctx.pool, companyId, true);
}

export interface ShopifyRateItem {
  name?: string;
  sku?: string;
  quantity?: number;
  grams?: number;
  price?: number;
  vendor?: string;
  product_id?: string | number;
  variant_id?: string | number;
}

export interface ShopifyCarrierRateRequest {
  rate?: {
    origin?: { postal_code?: string; province?: string; country?: string };
    destination?: { postal_code?: string; province?: string; country?: string; city?: string; address1?: string };
    items?: ShopifyRateItem[];
    currency?: string;
  };
}

export interface ShopifyCarrierRate {
  service_name: string;
  service_code: string;
  total_price: string;
  currency: string;
  description: string;
}

type BoxKind = 'ebike' | 'bike' | 'medium';

function classifyKind(category: string, title: string, weightLb: number): BoxKind {
  const text = `${category} ${title}`.toLowerCase();
  if (/\b(e-?bike|electric bike|turbo levo|turbo vado|turbo como|ebike|pedego)\b/.test(text)) return 'ebike';
  if (weightLb >= 55) return 'ebike';
  if (/\b(bike|bicycle|bmx|cruiser|road bike|mountain bike|gravel|hybrid|commuter|kids bike)\b/.test(text) && !/\b(helmet|shoe|jersey|rack|lock|light|tire|tube|pump|bottle|cage|pedal|saddle|stand|bag|glove|short|jacket)\b/.test(text)) {
    return 'bike';
  }
  if (weightLb >= 22) return 'bike';
  return 'medium';
}

function zoneMultiplier(originZip: string, destZip: string): number {
  const o = originZip.trim()[0];
  const d = destZip.trim()[0];
  if (!o || !d) return 1.05;
  const diff = Math.abs(Number(o) - Number(d));
  if (!Number.isFinite(diff)) return 1.05;
  if (diff === 0) return 0.9;
  if (diff <= 2) return 1.0;
  if (diff <= 4) return 1.15;
  return 1.3;
}

async function quoteEasyPostBox(
  apiKey: string,
  from: { zip: string; state: string; country: string },
  to: { zip: string; state: string; country: string },
  box: ShippingBoxSpec,
  weightOz: number,
): Promise<{ carrier: string; service: string; cents: number }[]> {
  const auth = Buffer.from(`${apiKey}:`).toString('base64');
  const res = await fetch('https://api.easypost.com/v2/shipments', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      shipment: {
        from_address: { zip: from.zip, state: from.state, country: from.country },
        to_address: { zip: to.zip, state: to.state, country: to.country },
        parcel: {
          length: box.lengthIn,
          width: box.widthIn,
          height: box.heightIn,
          weight: Math.max(4, Math.round(weightOz)),
        },
      },
    }),
    signal: AbortSignal.timeout(3500),
  });
  if (!res.ok) throw new Error(`EasyPost HTTP ${res.status}`);
  const data = (await res.json()) as { rates?: { carrier?: string; service?: string; rate?: string }[] };
  return (data.rates || [])
    .map((r) => ({
      carrier: String(r.carrier || ''),
      service: String(r.service || ''),
      cents: Math.round(Number(r.rate || 0) * 100),
    }))
    .filter((r) => r.cents > 0 && (r.carrier === 'UPS' || r.carrier === 'USPS'));
}

export async function resolveCompanyIdForShop(db: Pool, shopHeader?: string): Promise<string | null> {
  const shop = String(shopHeader || '').toLowerCase().trim();
  if (shop) {
    const byLink = await db.query<{ company_id: string }>(
      `SELECT company_id FROM shopify_variant_links WHERE shop_domain = $1 LIMIT 1`,
      [shop],
    );
    if (byLink.rows[0]?.company_id) return byLink.rows[0].company_id;
  }
  const one = await db.query<{ id: string }>(`SELECT id FROM companies ORDER BY created_at ASC LIMIT 1`);
  return one.rows[0]?.id ?? null;
}

export async function calculateShopifyCarrierRates(
  ctx: AppContext,
  companyId: string,
  payload: ShopifyCarrierRateRequest,
): Promise<{ rates: ShopifyCarrierRate[]; debug?: Record<string, unknown> }> {
  const rules = await getShippingRules(ctx.pool, companyId, false);
  const items = payload.rate?.items || [];
  const dest = payload.rate?.destination || {};
  const currency = payload.rate?.currency || 'USD';

  // Look up matching categories & weights from Hub catalog
  const skus = items.map((i) => String(i.sku || '').trim()).filter(Boolean);
  const catalogBySku = new Map<string, { category: string; title: string }>();
  if (skus.length) {
    const r = await ctx.pool.query<{ sku: string; category: string; title: string }>(
      `SELECT v.sku, COALESCE(p.category, '') AS category, COALESCE(NULLIF(v.title, ''), p.title) AS title
       FROM variants v
       JOIN products p ON p.id = v.product_id AND p.company_id = v.company_id
       WHERE v.company_id = $1 AND v.sku = ANY($2::text[])`,
      [companyId, skus],
    );
    for (const row of r.rows) catalogBySku.set(row.sku, { category: row.category, title: row.title });
  }

  const packedBoxes: { kind: BoxKind; box: ShippingBoxSpec; weightLb: number }[] = [];
  let mediumWeightLb = 0;
  let hasBikes = false;

  for (const it of items) {
    const qty = Math.max(1, Number(it.quantity || 1));
    const sku = String(it.sku || '').trim();
    const cat = catalogBySku.get(sku)?.category || '';
    const title = catalogBySku.get(sku)?.title || String(it.name || '');
    const unitWeightLb = (Number(it.grams || 0) / 453.592) || 0;
    const kind = classifyKind(cat, title, unitWeightLb);

    if (kind === 'ebike' || kind === 'bike') {
      hasBikes = true;
      const spec = rules.boxes[kind];
      const boxWt = unitWeightLb > 0 ? unitWeightLb : spec.defaultWeightLb;
      for (let q = 0; q < qty; q++) {
        packedBoxes.push({ kind, box: spec, weightLb: boxWt });
      }
    } else {
      mediumWeightLb += (unitWeightLb > 0 ? unitWeightLb : 1.5) * qty;
    }
  }

  if (mediumWeightLb > 0 || packedBoxes.length === 0) {
    const med = rules.boxes.medium;
    const numMedBoxes = Math.max(1, Math.ceil(mediumWeightLb / Math.max(1, med.defaultWeightLb * 2)));
    const perBoxWt = Math.max(1, mediumWeightLb / numMedBoxes);
    for (let i = 0; i < numMedBoxes; i++) {
      packedBoxes.push({ kind: 'medium', box: med, weightLb: perBoxWt });
    }
  }

  const feeMult = 1 + (rules.handlingFeePct || 0);
  const apiKey = rules.easypostApiKey || String(process.env.EASYPOST_API_KEY || '');

  // Try live EasyPost multi-box quote if API key is configured
  if (apiKey && dest.postal_code) {
    try {
      const boxQuotes = await Promise.all(
        packedBoxes.map((pb) =>
          quoteEasyPostBox(
            apiKey,
            { zip: rules.originPostalCode, state: rules.originProvince, country: rules.originCountry },
            { zip: String(dest.postal_code || '33612'), state: String(dest.province || 'FL'), country: String(dest.country || 'US') },
            pb.box,
            pb.weightLb * 16,
          ),
        ),
      );
      const allowedServices = new Map<string, { carrier: string; service: string; totalCents: number; boxCount: number }>();
      for (const quotes of boxQuotes) {
        for (const q of quotes) {
          if (hasBikes && rules.blockUspsOnBikes && q.carrier === 'USPS') continue;
          const key = `${q.carrier}:${q.service}`;
          const prev = allowedServices.get(key) || { carrier: q.carrier, service: q.service, totalCents: 0, boxCount: 0 };
          prev.totalCents += q.cents;
          prev.boxCount += 1;
          allowedServices.set(key, prev);
        }
      }
      const complete = Array.from(allowedServices.values())
        .filter((s) => s.boxCount === packedBoxes.length)
        .sort((a, b) => a.totalCents - b.totalCents)
        .slice(0, 5);
      if (complete.length > 0) {
        return {
          rates: complete.map((s) => ({
            service_name: `${s.carrier} ${s.service.replace(/_/g, ' ')}`,
            service_code: `${s.carrier}_${s.service}`.toUpperCase(),
            total_price: String(Math.round(s.totalCents * feeMult)),
            currency,
            description: `Calculated for ${packedBoxes.length} box(es)`,
          })),
          debug: { source: 'easypost', packedBoxes: packedBoxes.map((b) => b.box.name), hasBikes },
        };
      }
    } catch {
      // Fall through to dimensional zone fallback so checkout never fails
    }
  }

  // Smart dimensional + zone fallback
  const zMult = zoneMultiplier(rules.originPostalCode, String(dest.postal_code || '33612'));
  let groundBaseCents = 0;
  for (const pb of packedBoxes) {
    if (pb.kind === 'medium') {
      const wtFactor = Math.max(1, pb.weightLb * 115);
      groundBaseCents += Math.max(pb.box.fallbackCents, Math.round(wtFactor * zMult));
    } else {
      groundBaseCents += Math.round(pb.box.fallbackCents * zMult);
    }
  }

  const rates: ShopifyCarrierRate[] = [
    {
      service_name: 'UPS Ground',
      service_code: 'UPS_GROUND',
      total_price: String(Math.round(groundBaseCents * feeMult)),
      currency,
      description: `Dimensional rate (${packedBoxes.map((b) => b.box.name).join(', ')})`,
    },
    {
      service_name: 'UPS 2nd Day Air',
      service_code: 'UPS_2ND_DAY_AIR',
      total_price: String(Math.round(groundBaseCents * 1.65 * feeMult)),
      currency,
      description: '2 business days via UPS',
    },
  ];
  if (!hasBikes || !rules.blockUspsOnBikes) {
    rates.unshift({
      service_name: 'USPS Ground Advantage',
      service_code: 'USPS_GROUND_ADVANTAGE',
      total_price: String(Math.round(Math.max(895, groundBaseCents * 0.85) * feeMult)),
      currency,
      description: '2-5 business days via USPS',
    });
  }

  return {
    rates,
    debug: { source: 'hub_dimensional_fallback', packedBoxes: packedBoxes.map((b) => b.box.name), hasBikes, zMult },
  };
}
