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
