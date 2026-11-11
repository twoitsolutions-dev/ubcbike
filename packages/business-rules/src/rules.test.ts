import { describe, expect, it } from 'vitest';
import type { CatalogItem, PriceAdjustment } from '@ubc/shared';
import { DEFAULT_CAMPAIGN_RULES } from '@ubc/shared';
import {
  applyAdjustment, assertTransition, chooseExecutionStrategy, compareIdentities, computeAvailability,
  evaluateCampaign, evaluateLine, findBestMatch, isValidGtinCheckDigit, marginPct, matchesFilter,
  minPriceForMargin, nextSteps, normalizeGtin, planFulfillment, planRestore, revalidateCost, roundPrice,
  TransitionError,
} from './index.js';

const NOW = new Date('2026-11-20T12:00:00Z');

function item(over: Partial<CatalogItem> = {}): CatalogItem {
  return {
    id: 'v1', productId: 'p1', title: 'Trail Helmet', brand: 'Bell', model: 'Trail', category: 'Accessories',
    sku: 'UBC-1', upc: '036000291452', mpn: 'BL-TRAIL-M', priceCents: 10000, compareAtCents: null,
    costCents: 5000, mapCents: null, mapPolicy: 'none', status: 'published', physicalQty: 3, reservedQty: 0,
    offers: [], shopifyVariantId: null, lightspeedItemId: null, updatedAt: NOW.toISOString(), version: 1,
    ...over,
  };
}

const off20: PriceAdjustment = { type: 'percent_off', value: 0.2, rounding: 'none' };

describe('pricing', () => {
  it('computes margin and floor price', () => {
    expect(marginPct(10000, 5000)).toBe(0.5);
    expect(marginPct(0, 5000)).toBeNull();
    expect(marginPct(10000, null)).toBeNull();
    const floor = minPriceForMargin(5000, 0.15);
    expect(marginPct(floor, 5000)!).toBeGreaterThanOrEqual(0.15);
    expect(marginPct(floor - 1, 5000)!).toBeLessThan(0.15);
  });

  it('applies adjustments in integer cents', () => {
    expect(applyAdjustment(10000, off20)).toBe(8000);
    expect(applyAdjustment(1999, { type: 'percent_off', value: 0.15, rounding: 'none' })).toBe(1699);
    expect(applyAdjustment(10000, { type: 'amount_off', value: 1500, rounding: 'none' })).toBe(8500);
    expect(applyAdjustment(10000, { type: 'percent_increase', value: 0.1, rounding: 'none' })).toBe(11000);
    expect(applyAdjustment(10000, { type: 'set_price', value: 7777, rounding: 'none' })).toBe(7777);
    expect(() => applyAdjustment(100, { type: 'percent_off', value: 1, rounding: 'none' })).toThrow();
  });

  it('rounds to charm prices without going up', () => {
    expect(roundPrice(8000, 'charm_99')).toBe(7999);
    expect(roundPrice(8050, 'charm_99')).toBe(7999);
    expect(roundPrice(8099, 'charm_99')).toBe(8099);
    expect(roundPrice(8049, 'whole_dollar')).toBe(8000);
  });

  it('blocks MAP violations regardless of confirmation, unless an authorised exception exists', () => {
    const it1 = item({ mapPolicy: 'map', mapCents: 9000 });
    const blocked = evaluateLine(it1, off20, { rules: DEFAULT_CAMPAIGN_RULES, now: NOW });
    expect(blocked.status).toBe('blocked');
    expect(blocked.reasons).toContain('MAP_VIOLATION');

    const allowed = evaluateLine(it1, off20, {
      rules: DEFAULT_CAMPAIGN_RULES, now: NOW,
      mapExceptions: [{ itemId: 'v1', approvedBy: 'vendor-rep', reference: 'EMAIL-123', validUntil: '2026-12-01T00:00:00Z' }],
    });
    expect(allowed.status).toBe('warning');
    expect(allowed.reasons).toContain('MAP_EXCEPTION_APPLIED');

    const expired = evaluateLine(it1, off20, {
      rules: DEFAULT_CAMPAIGN_RULES, now: NOW,
      mapExceptions: [{ itemId: 'v1', approvedBy: 'x', reference: 'y', validUntil: '2026-11-01T00:00:00Z' }],
    });
    expect(expired.status).toBe('blocked');
  });

  it('enforces minimum margin, or clamps when configured', () => {
    const thin = item({ costCents: 7500 }); // 20 % off -> 8000, margin 6.25 %
    const r = evaluateLine(thin, off20, { rules: DEFAULT_CAMPAIGN_RULES, now: NOW });
    expect(r.status).toBe('blocked');
    expect(r.reasons).toContain('BELOW_MIN_MARGIN');

    const clamped = evaluateLine(thin, off20, { rules: { ...DEFAULT_CAMPAIGN_RULES, clampToMinMargin: true }, now: NOW });
    expect(clamped.status).toBe('warning');
    expect(clamped.newPriceCents).toBe(minPriceForMargin(7500, 0.15));
    expect(clamped.newMarginPct!).toBeGreaterThanOrEqual(0.15);
  });

  it('still blocks a clamped price that lands under MAP', () => {
    const it1 = item({ costCents: 7500, mapPolicy: 'map', mapCents: 9500 });
    const r = evaluateLine(it1, off20, { rules: { ...DEFAULT_CAMPAIGN_RULES, clampToMinMargin: true }, now: NOW });
    expect(r.status).toBe('blocked');
    expect(r.reasons).toEqual(expect.arrayContaining(['CLAMPED_TO_MIN_MARGIN', 'MAP_VIOLATION']));
  });

  it('excludes items with no cost and flags low margins', () => {
    expect(evaluateLine(item({ costCents: null }), off20, { rules: DEFAULT_CAMPAIGN_RULES }).status).toBe('excluded');
    const low = evaluateLine(item({ costCents: 6500 }), off20, { rules: DEFAULT_CAMPAIGN_RULES });
    expect(low.status).toBe('warning');
    expect(low.reasons).toContain('LOW_MARGIN');
  });

  it('summarises a large campaign quickly and chooses a strategy', () => {
    const items = Array.from({ length: 20000 }, (_, i) => item({ id: `v${i}`, priceCents: 5000 + i, costCents: 2000 }));
    const t0 = Date.now();
    const { summary } = evaluateCampaign(items, off20, { rules: DEFAULT_CAMPAIGN_RULES });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(summary.total).toBe(20000);
    expect(summary.ok + summary.warning).toBe(20000);
    expect(chooseExecutionStrategy(off20, 'online', summary)).toBe('shopify_automatic_discount');
    expect(chooseExecutionStrategy(off20, 'online_and_pos', summary)).toBe('variant_price_update');
    expect(chooseExecutionStrategy({ ...off20, rounding: 'charm_99' }, 'online',
      evaluateCampaign(items.slice(0, 5), { ...off20, rounding: 'charm_99' }, { rules: DEFAULT_CAMPAIGN_RULES }).summary,
    )).toBe('variant_price_update');
  });

  it('restore never overwrites prices changed after the campaign', () => {
    const plan = planRestore(
      [
        { itemId: 'a', oldPriceCents: 1000, newPriceCents: 800, applied: true },
        { itemId: 'b', oldPriceCents: 1000, newPriceCents: 800, applied: true },
        { itemId: 'c', oldPriceCents: 1000, newPriceCents: 800, applied: false },
      ],
      (id) => ({ a: 800, b: 850, c: 1000 } as Record<string, number>)[id],
    );
    expect(plan.map((p) => p.action)).toEqual(['restore', 'skip_changed_after_campaign', 'skip_not_applied']);
  });
});

describe('availability', () => {
  const fresh = { supplierCode: 'QBP', supplierSku: 'Q1', costCents: 4800, qtyAvailable: 10, reportedAt: '2026-11-20T06:00:00Z', dropShip: true, leadDays: 3 };

  it('never adds supplier quantity to physical stock', () => {
    const av = computeAvailability(item({ physicalQty: 0, offers: [fresh] }), undefined, NOW);
    expect(av.sellablePhysical).toBe(0);
    expect(av.status).toBe('special_order');
    expect(av.shopify.publishedQty).toBe(0);
    expect(av.shopify.inventoryPolicy).toBe('continue');
    expect(av.estimatedLeadDays).toBe(5);
  });

  it('ignores stale and thin supplier offers', () => {
    const stale = { ...fresh, reportedAt: '2026-11-10T00:00:00Z' };
    const thin = { ...fresh, supplierCode: 'JBI', qtyAvailable: 2 };
    const av = computeAvailability(item({ physicalQty: 0, offers: [stale, thin] }), undefined, NOW);
    expect(av.status).toBe('unavailable');
    expect(av.shopify.inventoryPolicy).toBe('deny');
    expect(av.staleOffers).toHaveLength(1);
  });

  it('subtracts reserved units', () => {
    expect(computeAvailability(item({ physicalQty: 2, reservedQty: 2 }), undefined, NOW).sellablePhysical).toBe(0);
  });

  it('plans split fulfilment: stock first, then suppliers, remainder unfulfillable', () => {
    const jbi = { ...fresh, supplierCode: 'JBI', costCents: 4700, qtyAvailable: 4, dropShip: false };
    const plan = planFulfillment(item({ physicalQty: 1, offers: [fresh, jbi] }), 15, 'pickup', undefined, NOW);
    expect(plan).toEqual([
      { kind: 'ubc_stock', qty: 1 },
      { kind: 'supplier', supplierCode: 'JBI', qty: 2, costCents: 4700, dropShip: false },
      { kind: 'supplier', supplierCode: 'QBP', qty: 8, costCents: 4800, dropShip: true },
      { kind: 'unfulfillable', qty: 4 },
    ]);
    const ship = planFulfillment(item({ physicalQty: 0, offers: [fresh, jbi] }), 1, 'ship', undefined, NOW);
    expect(ship[0]).toMatchObject({ supplierCode: 'QBP', dropShip: true });
  });
});

describe('matching', () => {
  it('validates GTIN check digits and rejects placeholders', () => {
    expect(isValidGtinCheckDigit('036000291452')).toBe(true);
    expect(normalizeGtin('0 36000 29145 2')).toBe('00036000291452');
    expect(normalizeGtin('036000291453')).toBeNull();
    expect(normalizeGtin('000000000000')).toBeNull();
    expect(normalizeGtin('1234')).toBeNull();
  });

  it('auto-matches only on equal valid GTIN without conflicts', () => {
    const a = { brand: 'Bell', mpn: 'BL-TRAIL-M', upc: '036000291452', title: 'Bell Trail helmet M' };
    expect(compareIdentities(a, { ...a, title: 'Trail Helmet Medium' }).decision).toBe('auto_match');
    expect(compareIdentities(a, { ...a, brand: 'Giro' }).decision).toBe('review');
    expect(compareIdentities(a, { ...a, mpn: 'OTHER-123' }).decision).toBe('review');
  });

  it('sends brand+MPN matches without GTIN to review, never auto', () => {
    const a = { brand: 'Shimano Inc', mpn: 'CN-HG601', upc: null, title: 'Shimano 105 chain 11s' };
    const b = { brand: 'shimano', mpn: 'cn hg601', upc: '036000291452', title: '105 HG601 chain' };
    const r = compareIdentities(a, b);
    expect(r.decision).toBe('review');
    expect(r.reasons).toContain('BRAND_MPN_EQUAL');
  });

  it('does not assume supplier SKUs are universal', () => {
    const a = { brand: 'Bell', mpn: null, upc: null, title: 'Tube 700x25' };
    const b = { brand: 'Continental', mpn: null, upc: null, title: 'Tube 700x25' };
    expect(compareIdentities(a, b).decision).toBe('no_match');
  });

  it('downgrades multiple GTIN hits to review', () => {
    const inc = { brand: 'Bell', mpn: null, upc: '036000291452', title: 'x' };
    const cat = [
      { brand: 'Bell', mpn: null, upc: '036000291452', title: 'a' },
      { brand: 'Bell', mpn: null, upc: '036000291452', title: 'b' },
    ];
    expect(findBestMatch(inc, cat)!.decision).toBe('review');
  });
});

describe('special orders', () => {
  const carlos = ['orders.write', 'purchasing.approve'] as const;
  it('enforces the state machine and approval permission', () => {
    expect(() => assertTransition('awaiting_approval', 'approved', carlos)).not.toThrow();
    expect(() => assertTransition('awaiting_approval', 'approved', ['orders.write'])).toThrow(TransitionError);
    expect(() => assertTransition('new_order', 'completed', carlos)).toThrow(/Cannot move/);
    expect(() => assertTransition('approved', 'cancelled', carlos)).toThrow(/note is required/);
    expect(() => assertTransition('cancelled', 'approved', carlos)).toThrow();
  });

  it('filters steps by fulfilment method', () => {
    expect(nextSteps('received_at_ubc', 'pickup')).not.toContain('shipped_to_customer');
    expect(nextSteps('received_at_ubc', 'ship')).not.toContain('ready_for_pickup');
  });

  it('revalidates cost and stock before purchase', () => {
    expect(revalidateCost(10000, 10100, 5, 1)).toEqual({ ok: true });
    expect(revalidateCost(10000, 11000, 5, 1)).toEqual({ ok: false, reason: 'cost_changed' });
    expect(revalidateCost(10000, 10000, 0, 1)).toEqual({ ok: false, reason: 'out_of_stock_after_purchase' });
    expect(revalidateCost(10000, 10000, 1, 2)).toEqual({ ok: false, reason: 'partially_available' });
    expect(revalidateCost(10000, null, 1, 1)).toEqual({ ok: false, reason: 'discontinued' });
  });
});

describe('selection', () => {
  it('combines filters', () => {
    const i = item({ offers: [{ supplierCode: 'QBP', supplierSku: 'x', costCents: 1, qtyAvailable: 9, reportedAt: NOW.toISOString(), dropShip: false, leadDays: 2 }] });
    expect(matchesFilter(i, { categories: ['Accessories'], brands: ['Bell'], suppliers: ['QBP'], q: 'trail helm' }, undefined, NOW)).toBe(true);
    expect(matchesFilter(i, { marginMinPct: 0.6 }, undefined, NOW)).toBe(false);
    expect(matchesFilter(i, { stock: 'virtual_only' }, undefined, NOW)).toBe(false);
    expect(matchesFilter(i, { priceMaxCents: 9999 }, undefined, NOW)).toBe(false);
  });
});
