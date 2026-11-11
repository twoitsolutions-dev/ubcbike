import type { CatalogItem, SupplierOffer } from '@ubc/shared';

export interface AvailabilitySettings {
  /** Units of physical stock kept back from online sale (display units, damage buffer). */
  physicalSafetyQty: number;
  /** A supplier must report more than this many units for the offer to count. */
  supplierSafetyQty: number;
  /** Supplier quantities older than this are not trusted. */
  maxOfferAgeHours: number;
  /** Extra days added to supplier lead time for receiving/assembly at UBC. */
  handlingDays: number;
}

export const DEFAULT_AVAILABILITY: AvailabilitySettings = {
  physicalSafetyQty: 0,
  supplierSafetyQty: 2,
  maxOfferAgeHours: 48,
  handlingDays: 2,
};

export type AvailabilityStatus = 'in_stock' | 'special_order' | 'unavailable';

export interface Availability {
  status: AvailabilityStatus;
  /** Physical units UBC can sell now. Never includes supplier quantities. */
  sellablePhysical: number;
  /** Fresh supplier offers above the safety threshold, cheapest first. */
  eligibleOffers: SupplierOffer[];
  staleOffers: SupplierOffer[];
  bestOffer: SupplierOffer | null;
  /** Estimated days to ship/pickup for a special order. */
  estimatedLeadDays: number | null;
  /**
   * How the item should be represented in Shopify. We never publish supplier
   * quantities as stock; instead we allow overselling ("continue") only while
   * a fresh supplier offer exists, and flag it via metafield as special order.
   */
  shopify: {
    publishedQty: number;
    inventoryPolicy: 'deny' | 'continue';
    availabilityMetafield: AvailabilityStatus;
    leadTimeDays: number | null;
  };
}

export function isOfferFresh(offer: SupplierOffer, now: Date, maxAgeHours: number): boolean {
  const age = (now.getTime() - new Date(offer.reportedAt).getTime()) / 3_600_000;
  return age >= 0 && age <= maxAgeHours;
}

export function computeAvailability(
  item: Pick<CatalogItem, 'physicalQty' | 'reservedQty' | 'offers'>,
  settings: AvailabilitySettings = DEFAULT_AVAILABILITY,
  now: Date = new Date(),
): Availability {
  const sellablePhysical = Math.max(0, item.physicalQty - item.reservedQty - settings.physicalSafetyQty);
  const eligible: SupplierOffer[] = [];
  const stale: SupplierOffer[] = [];
  for (const o of item.offers) {
    if (!isOfferFresh(o, now, settings.maxOfferAgeHours)) stale.push(o);
    else if (o.qtyAvailable > settings.supplierSafetyQty) eligible.push(o);
  }
  eligible.sort((a, b) => a.costCents - b.costCents || a.leadDays - b.leadDays);
  const best = eligible[0] ?? null;
  const lead = best ? best.leadDays + settings.handlingDays : null;

  let status: AvailabilityStatus;
  if (sellablePhysical > 0) status = 'in_stock';
  else if (best) status = 'special_order';
  else status = 'unavailable';

  return {
    status,
    sellablePhysical,
    eligibleOffers: eligible,
    staleOffers: stale,
    bestOffer: best,
    estimatedLeadDays: status === 'special_order' ? lead : null,
    shopify: {
      publishedQty: sellablePhysical,
      inventoryPolicy: status === 'special_order' ? 'continue' : 'deny',
      availabilityMetafield: status,
      leadTimeDays: status === 'special_order' ? lead : null,
    },
  };
}

export type FulfillmentSource =
  | { kind: 'ubc_stock'; qty: number }
  | { kind: 'supplier'; supplierCode: string; qty: number; costCents: number; dropShip: boolean }
  | { kind: 'unfulfillable'; qty: number };

/**
 * Decide how to fulfil `qty` units: UBC stock first, then the cheapest fresh
 * supplier offers. May split across sources; any remainder is unfulfillable.
 * When the customer wants home delivery, drop-ship offers are preferred.
 */
export function planFulfillment(
  item: Pick<CatalogItem, 'physicalQty' | 'reservedQty' | 'offers'>,
  qty: number,
  method: 'pickup' | 'ship',
  settings: AvailabilitySettings = DEFAULT_AVAILABILITY,
  now: Date = new Date(),
): FulfillmentSource[] {
  const av = computeAvailability(item, settings, now);
  const out: FulfillmentSource[] = [];
  let remaining = qty;
  const fromStock = Math.min(remaining, av.sellablePhysical);
  if (fromStock > 0) {
    out.push({ kind: 'ubc_stock', qty: fromStock });
    remaining -= fromStock;
  }
  const offers = [...av.eligibleOffers];
  if (method === 'ship') offers.sort((a, b) => Number(b.dropShip) - Number(a.dropShip) || a.costCents - b.costCents);
  for (const o of offers) {
    if (remaining <= 0) break;
    const usable = o.qtyAvailable - settings.supplierSafetyQty;
    const take = Math.min(remaining, usable);
    if (take > 0) {
      out.push({ kind: 'supplier', supplierCode: o.supplierCode, qty: take, costCents: o.costCents, dropShip: o.dropShip });
      remaining -= take;
    }
  }
  if (remaining > 0) out.push({ kind: 'unfulfillable', qty: remaining });
  return out;
}
