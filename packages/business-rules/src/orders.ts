import type { Permission, SpecialOrderStatus } from '@ubc/shared';

/**
 * Internal special-order workflow. These statuses are ours; Shopify keeps
 * its own financial/fulfillment statuses which we only mirror.
 */
export const TRANSITIONS: Record<SpecialOrderStatus, readonly SpecialOrderStatus[]> = {
  new_order: ['awaiting_review', 'cancelled', 'exception'],
  awaiting_review: ['awaiting_approval', 'cancelled', 'exception'],
  awaiting_approval: ['approved', 'cancelled', 'exception'],
  approved: ['po_submitted', 'cancelled', 'exception'],
  po_submitted: ['supplier_confirmed', 'exception', 'cancelled'],
  supplier_confirmed: ['in_transit', 'exception', 'cancelled'],
  in_transit: ['received_at_ubc', 'shipped_to_customer', 'exception'],
  received_at_ubc: ['ready_for_pickup', 'shipped_to_customer', 'exception'],
  ready_for_pickup: ['completed', 'exception'],
  shipped_to_customer: ['completed', 'exception'],
  completed: ['exception'], // e.g. a later return or damage claim
  exception: ['awaiting_review', 'awaiting_approval', 'approved', 'po_submitted', 'cancelled', 'completed'],
  cancelled: [],
};

/** Transitions that need more than plain order-handling permission. */
export const TRANSITION_PERMISSION: Partial<Record<SpecialOrderStatus, Permission>> = {
  approved: 'purchasing.approve',
  po_submitted: 'purchasing.approve',
};

export class TransitionError extends Error {
  constructor(public readonly code: 'INVALID_TRANSITION' | 'FORBIDDEN' | 'NOTE_REQUIRED', message: string) {
    super(message);
    this.name = 'TransitionError';
  }
}

export function canTransition(from: SpecialOrderStatus, to: SpecialOrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(
  from: SpecialOrderStatus,
  to: SpecialOrderStatus,
  permissions: readonly Permission[],
  note?: string,
): void {
  if (!canTransition(from, to)) {
    throw new TransitionError('INVALID_TRANSITION', `Cannot move order from ${from} to ${to}`);
  }
  const needed = TRANSITION_PERMISSION[to];
  if (needed && !permissions.includes(needed)) {
    throw new TransitionError('FORBIDDEN', `Moving to ${to} requires ${needed}`);
  }
  if ((to === 'exception' || to === 'cancelled') && !note?.trim()) {
    throw new TransitionError('NOTE_REQUIRED', `A note is required when moving to ${to}`);
  }
}

/** Valid next steps for a given method (pickup orders never go to shipped_to_customer etc.). */
export function nextSteps(from: SpecialOrderStatus, method: 'pickup' | 'ship'): SpecialOrderStatus[] {
  return TRANSITIONS[from].filter((s) => {
    if (method === 'pickup' && s === 'shipped_to_customer') return false;
    if (method === 'ship' && s === 'ready_for_pickup') return false;
    return true;
  });
}

/**
 * Re-validation before Carlos approves a purchase: availability and cost are
 * fetched again; changes push the order into an exception instead of
 * silently buying at a different price.
 */
export function revalidateCost(
  quotedCostCents: number,
  currentCostCents: number | null,
  qtyAvailable: number,
  qtyNeeded: number,
  tolerancePct = 0.02,
): { ok: true } | { ok: false; reason: 'out_of_stock_after_purchase' | 'cost_changed' | 'partially_available' | 'discontinued' } {
  if (currentCostCents === null) return { ok: false, reason: 'discontinued' };
  if (qtyAvailable <= 0) return { ok: false, reason: 'out_of_stock_after_purchase' };
  if (qtyAvailable < qtyNeeded) return { ok: false, reason: 'partially_available' };
  if (Math.abs(currentCostCents - quotedCostCents) > quotedCostCents * tolerancePct) {
    return { ok: false, reason: 'cost_changed' };
  }
  return { ok: true };
}

export interface WaitingSpecialOrderLine {
  orderId: string;
  orderNumber: string;
  createdAt: string;
  sku: string;
  qtyNeeded: number;
}

export interface InboundSpecialOrderReceipt {
  specialOrderId: string;
  sku: string;
  qtyReady: number;
  /** Optional explicit Shopify order reference stored on the Lightspeed SpecialOrder note (e.g. "#1051"). */
  referenceOrderNumber?: string | null;
}

export interface SpecialOrderAllocation {
  orderId: string;
  orderNumber: string;
  specialOrderId: string;
  sku: string;
  qtyAllocated: number;
  qtyStillWaiting: number;
  matchedBy: 'explicit_order_ref' | 'fifo_oldest';
  /** True when multiple open customer orders share this SKU and no explicit #Order tag was present. */
  sharedSkuNeedsConfirmation: boolean;
}

function normOrderNum(s: string | null | undefined): string {
  return (s || '').trim().replace(/^#+/, '').toUpperCase();
}

/**
 * Allocates arrived Lightspeed `SpecialOrder` units strictly 1-to-1 per customer order,
 * NEVER broadcasting a single scanned unit across two different customers who ordered the same SKU.
 *  1. Exact match by Shopify Order # (`referenceOrderNumber`) first.
 *  2. Strict unit-by-unit FIFO (`createdAt` oldest first) for remaining untagged units,
 *     flagging `sharedSkuNeedsConfirmation: true` when sibling orders share the SKU.
 */
export function allocateSpecialOrderReceipts(
  waiting: readonly WaitingSpecialOrderLine[],
  receipts: readonly InboundSpecialOrderReceipt[],
): SpecialOrderAllocation[] {
  const remainingNeed = new Map<string, number>();
  const skuOpenOrderCount = new Map<string, number>();
  for (const w of waiting) {
    if (w.qtyNeeded <= 0) continue;
    remainingNeed.set(w.orderId + ':' + w.sku, (remainingNeed.get(w.orderId + ':' + w.sku) ?? 0) + w.qtyNeeded);
    skuOpenOrderCount.set(w.sku, (skuOpenOrderCount.get(w.sku) ?? 0) + 1);
  }

  const sortedWaiting = [...waiting].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.orderNumber.localeCompare(b.orderNumber));
  const allocations: SpecialOrderAllocation[] = [];
  const leftoverReceipts: { specialOrderId: string; sku: string; qtyLeft: number }[] = [];

  // Pass 1: Explicit Shopify #Order reference match
  for (const r of receipts) {
    let qtyLeft = Math.max(0, r.qtyReady);
    if (!qtyLeft) continue;
    const refNorm = normOrderNum(r.referenceOrderNumber);
    if (refNorm) {
      const target = sortedWaiting.find((w) => w.sku === r.sku && normOrderNum(w.orderNumber) === refNorm);
      if (target) {
        const key = target.orderId + ':' + target.sku;
        const need = remainingNeed.get(key) ?? 0;
        const take = Math.min(need, qtyLeft);
        if (take > 0) {
          const after = need - take;
          remainingNeed.set(key, after);
          qtyLeft -= take;
          allocations.push({
            orderId: target.orderId,
            orderNumber: target.orderNumber,
            specialOrderId: r.specialOrderId,
            sku: r.sku,
            qtyAllocated: take,
            qtyStillWaiting: after,
            matchedBy: 'explicit_order_ref',
            sharedSkuNeedsConfirmation: false,
          });
        }
      }
    }
    if (qtyLeft > 0) {
      leftoverReceipts.push({ specialOrderId: r.specialOrderId, sku: r.sku, qtyLeft });
    }
  }

  // Pass 2: Strict 1-to-1 FIFO (oldest customer order first)
  for (const r of leftoverReceipts) {
    let qtyLeft = r.qtyLeft;
    const shared = (skuOpenOrderCount.get(r.sku) ?? 0) > 1;
    for (const w of sortedWaiting) {
      if (qtyLeft <= 0) break;
      if (w.sku !== r.sku) continue;
      const key = w.orderId + ':' + w.sku;
      const need = remainingNeed.get(key) ?? 0;
      if (need <= 0) continue;
      const take = Math.min(need, qtyLeft);
      const after = need - take;
      remainingNeed.set(key, after);
      qtyLeft -= take;
      allocations.push({
        orderId: w.orderId,
        orderNumber: w.orderNumber,
        specialOrderId: r.specialOrderId,
        sku: r.sku,
        qtyAllocated: take,
        qtyStillWaiting: after,
        matchedBy: 'fifo_oldest',
        sharedSkuNeedsConfirmation: shared,
      });
    }
  }

  return allocations;
}
