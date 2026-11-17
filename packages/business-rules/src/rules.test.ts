import { describe, expect, it } from 'vitest';
import type { CatalogItem, PriceAdjustment } from '@ubc/shared';
import { DEFAULT_CAMPAIGN_RULES } from '@ubc/shared';
import {
  allocateSpecialOrderReceipts, applyAdjustment, assertTransition, chooseExecutionStrategy, compareIdentities, computeAvailability,
  evaluateCampaign, evaluateFeedWatchdog, evaluateLine, evaluateStagingBuffer, findBestMatch, formatRetailBarcode,
  isStreamDue, isValidGtinCheckDigit, marginPct, matchesFilter, minPriceForMargin, nextSteps,
  normalizeGtin, normalizeSupplierPayload, planFulfillment, planRestore, revalidateCost, roundPrice,
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

  it('never lets a missing cost bypass MAP (manual price path)', () => {
    const noCost = item({ costCents: null, mapPolicy: 'map', mapCents: 9500 });
    const manual = evaluateLine(noCost, { type: 'set_price', value: 9000, rounding: 'none' }, { rules: { ...DEFAULT_CAMPAIGN_RULES, excludeWithoutCost: false } });
    expect(manual.status).toBe('blocked');
    expect(manual.reasons).toContain('MAP_VIOLATION');
    const campaign = evaluateLine(noCost, off20, { rules: DEFAULT_CAMPAIGN_RULES });
    expect(campaign.status).toBe('excluded');
    expect(campaign.newPriceCents).toBe(noCost.priceCents);
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

  it('heals Workstand "00"-prefixed UPCs/EANs and Excel zero-stripped 11-digit UPCs automatically', () => {
    // 1. Standard 12-digit UPC vs Workstand "00" prefix (14 digits) vs Excel stripped leading zero (11 digits)
    expect(normalizeGtin('036000291452')).toBe('00036000291452');
    expect(normalizeGtin('00036000291452')).toBe('00036000291452');
    expect(normalizeGtin('36000291452')).toBe('00036000291452');
    expect(formatRetailBarcode('00768686473494')).toBe('768686473494');
    expect(formatRetailBarcode('36000291452')).toBe('036000291452');

    // 2. 13-digit European EAN (Continental/Shimano) vs Workstand "00" prefix (15 digits!)
    expect(normalizeGtin('4019238054408')).toBe('04019238054408');
    expect(normalizeGtin('004019238054408')).toBe('04019238054408');
    expect(formatRetailBarcode('004019238054408')).toBe('4019238054408');

    // 3. Lightspeed 12-digit UPC vs Workstand "00"-prefixed UPC auto-matches with 0.99 confidence
    const lsItem = { brand: 'Continental', mpn: '0101866', upc: '4019238054408', title: 'Conti GP5000 700x28' };
    const workstandItem = { brand: 'Continental', mpn: '0101866', upc: '004019238054408', title: 'Grand Prix 5000 S TR' };
    expect(compareIdentities(workstandItem, lsItem).decision).toBe('auto_match');
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

describe('intermediary engine pipeline (normalize, version, stage, cadence, watchdog)', () => {
  it('normalizes QBP item_number, JBI sku and Specialized partNumber into one canonical model', () => {
    const qbp = normalizeSupplierPayload('QBP', {
      item_number: 'BK-9012', brand_name: 'Salsa', item_description: 'Journeyer Claris 700c',
      manufacturer_part_number: 'SL-JRN-55', upc: '036000291452', base_cost: '450.00', map_price: '799.99',
      quantity_available: 6, drop_ship_eligible: 'Y', long_description: 'Alloy gravel frame',
    }, { contentLicensed: false });
    expect(qbp).toMatchObject({
      supplierCode: 'QBP', supplierSku: 'BK-9012', brand: 'Salsa', costCents: 45000, mapCents: 79999,
      qtyAvailable: 6, dropShip: true, description: null,
    });

    const jbi = normalizeSupplierPayload('JBI', {
      sku: 'JBI-44210', vendor_name: 'Salsa', desc: 'Journeyer Claris', mfg_part_no: 'SL-JRN-55',
      upc_code: '036000291452', dealer_cost: '$448.50', qoh: '11',
    });
    expect(jbi).toMatchObject({
      supplierCode: 'JBI', supplierSku: 'JBI-44210', costCents: 44850, qtyAvailable: 11, upc: qbp.upc,
    });

    const spec = normalizeSupplierPayload('SPECIALIZED', {
      partNumber: '94425-7054', productName: 'Tarmac SL8 Expert', dealerPrice: 3800, retailPrice: 6500, inventory: 4,
    });
    expect(spec).toMatchObject({
      supplierCode: 'SPECIALIZED', supplierSku: '94425-7054', brand: 'Specialized', costCents: 380000, mapCents: 650000, qtyAvailable: 4,
    });
  });

  it('versions QBP cost change ($450 -> $475) with Shopify published price snapshot and enforces staging buffer', () => {
    const bike = item({
      id: 'bike-1', title: 'Gravel Bike', category: 'Bikes', priceCents: 69999, costCents: 45000,
      mapPolicy: 'map', mapCents: 64999, physicalQty: 0,
      offers: [{ supplierCode: 'QBP', supplierSku: 'BK-9012', costCents: 45000, qtyAvailable: 6, reportedAt: NOW.toISOString(), dropShip: true, leadDays: 4 }],
    });
    const incoming = normalizeSupplierPayload('QBP', {
      item_number: 'BK-9012', brand: 'Salsa', description: 'Gravel Bike', base_cost: '475.00', map_price: '649.99', quantity_available: 6,
    });
    const staged = evaluateStagingBuffer({
      item: bike,
      previousOffer: { costCents: 45000, mapCents: 64999, msrpCents: null, qtyAvailable: 6 },
      incoming,
      now: NOW,
    });
    expect(staged.decision).toBe('ready_for_shopify');
    expect(staged.versionDelta).toMatchObject({
      changed: true,
      changeTypes: ['cost_changed'],
      oldCostCents: 45000,
      newCostCents: 47500,
      shopifyPublishedPriceCents: 69999,
    });
    expect(staged.shopifyPayload).toMatchObject({
      publishedQty: 0,
      inventoryPolicy: 'continue',
      availability: 'special_order',
      clickAndCollectOnly: false,
    });

    // Hold in processing buffer if supplier raises MAP above UBC's published Shopify price or erodes margin < 15%.
    const mapRaised = normalizeSupplierPayload('QBP', {
      item_number: 'BK-9012', brand: 'Salsa', description: 'Gravel Bike', base_cost: '620.00', map_price: '749.99', quantity_available: 6,
    });
    const held = evaluateStagingBuffer({
      item: bike,
      previousOffer: { costCents: 47500, mapCents: 64999, msrpCents: null, qtyAvailable: 6 },
      incoming: mapRaised,
      now: NOW,
    });
    expect(held.decision).toBe('held_for_review');
    expect(held.holdReasons).toEqual(expect.arrayContaining(['map_above_published_price', 'margin_below_minimum']));
  });

  it('enforces differentiated sync cadences (15-30m availability, 6-12h costs, 24h content, manual full_catalog)', () => {
    expect(isStreamDue('availability', '2026-11-20T11:50:00Z', NOW)).toBe(false); // 10m < 20m
    expect(isStreamDue('availability', '2026-11-20T11:35:00Z', NOW)).toBe(true);  // 25m >= 20m
    expect(isStreamDue('costs', '2026-11-20T08:00:00Z', NOW)).toBe(false);        // 4h < 9h
    expect(isStreamDue('costs', '2026-11-20T02:00:00Z', NOW)).toBe(true);         // 10h >= 9h
    expect(isStreamDue('content', '2026-11-20T00:00:00Z', NOW)).toBe(false);      // 12h < 24h
    expect(isStreamDue('content', '2026-11-19T11:00:00Z', NOW)).toBe(true);       // 25h >= 24h
    expect(isStreamDue('full_catalog', '2026-10-01T00:00:00Z', NOW)).toBe(false); // event/manual only
  });

  it('detects when JBI stops sending files for 2 days (48h watchdog alert)', () => {
    const reports = evaluateFeedWatchdog([
      { supplierCode: 'QBP', supplierName: 'Quality Bicycle Products', isActive: true, lastReportAt: '2026-11-20T11:45:00Z', maxSilenceHours: 2 },
      { supplierCode: 'JBI', supplierName: 'J&B Importers', isActive: true, lastReportAt: '2026-11-18T10:00:00Z', maxSilenceHours: 48 },
    ], NOW);
    expect(reports[0]!.status).toBe('healthy');
    expect(reports[1]!.status).toBe('stalled');
    expect(reports[1]!.hoursSilent).toBe(50);
    expect(reports[1]!.alertKey).toBe('watchdog:JBI:stalled:2026-11-20');
  });

  it('allocates arrived SpecialOrder units strictly 1-to-1 per customer (#Order ref first, FIFO second, never double-releasing)', () => {
    const waiting = [
      { orderId: 'ord-a', orderNumber: '#1051', createdAt: '2026-11-18T09:00:00Z', sku: 'GP5000-700X28', qtyNeeded: 1 },
      { orderId: 'ord-b', orderNumber: '#1068', createdAt: '2026-11-19T14:00:00Z', sku: 'GP5000-700X28', qtyNeeded: 1 },
    ];
    // Case 1: Only 1 untagged unit arrives -> ONLY oldest customer (#1051) gets 1 unit; #1068 stays waiting; flagged for confirmation
    const fifoAlloc = allocateSpecialOrderReceipts(waiting, [
      { specialOrderId: 'ls-so-1', sku: 'GP5000-700X28', qtyReady: 1, referenceOrderNumber: null },
    ]);
    expect(fifoAlloc).toHaveLength(1);
    expect(fifoAlloc[0]).toMatchObject({
      orderId: 'ord-a',
      orderNumber: '#1051',
      qtyAllocated: 1,
      qtyStillWaiting: 0,
      matchedBy: 'fifo_oldest',
      sharedSkuNeedsConfirmation: true,
    });

    // Case 2: Explicit Shopify #1068 reference on Lightspeed SpecialOrder routes strictly to #1068 without ambiguity
    const explicitAlloc = allocateSpecialOrderReceipts(waiting, [
      { specialOrderId: 'ls-so-2', sku: 'GP5000-700X28', qtyReady: 1, referenceOrderNumber: '#1068' },
    ]);
    expect(explicitAlloc).toHaveLength(1);
    expect(explicitAlloc[0]).toMatchObject({
      orderId: 'ord-b',
      orderNumber: '#1068',
      qtyAllocated: 1,
      matchedBy: 'explicit_order_ref',
      sharedSkuNeedsConfirmation: false,
    });
  });
});
