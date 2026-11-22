import type {
  CampaignRules,
  CatalogItem,
  Cents,
  MapException,
  PriceAdjustment,
} from '@ubc/shared';

/** Gross margin as a fraction of the selling price. Null when cost or price is unknown/invalid. */
export function marginPct(priceCents: Cents, costCents: Cents | null): number | null {
  if (costCents === null || priceCents <= 0) return null;
  return (priceCents - costCents) / priceCents;
}

/** Smallest price (in cents) that still yields at least `minMargin` over `cost`. */
export function minPriceForMargin(costCents: Cents, minMargin: number): Cents {
  if (minMargin >= 1) throw new RangeError('minMargin must be < 1');
  // Round up so the resulting margin is never below the floor.
  return Math.ceil(costCents / (1 - minMargin));
}

export function roundPrice(cents: Cents, mode: PriceAdjustment['rounding']): Cents {
  if (mode === 'none') return Math.round(cents);
  if (mode === 'whole_dollar') return Math.round(cents / 100) * 100;
  // charm_99: nearest X.99 at or below the value, never below 0.99
  const dollars = Math.floor(cents / 100);
  const candidate = dollars * 100 + 99;
  const value = candidate > cents ? candidate - 100 : candidate;
  return Math.max(99, value);
}

export function applyAdjustment(priceCents: Cents, adj: PriceAdjustment): Cents {
  let next: number;
  switch (adj.type) {
    case 'percent_off':
      if (adj.value < 0 || adj.value >= 1) throw new RangeError('percent_off must be in [0, 1)');
      next = priceCents * (1 - adj.value);
      break;
    case 'percent_increase':
      if (adj.value < 0) throw new RangeError('percent_increase must be >= 0');
      next = priceCents * (1 + adj.value);
      break;
    case 'amount_off':
      next = priceCents - adj.value;
      break;
    case 'amount_increase':
      next = priceCents + adj.value;
      break;
    case 'set_price':
      next = adj.value;
      break;
    default: {
      const never: never = adj.type;
      throw new Error(`Unknown adjustment ${String(never)}`);
    }
  }
  return roundPrice(next, adj.rounding);
}

export type LineStatus = 'ok' | 'warning' | 'blocked' | 'excluded';

export type LineReason =
  | 'NO_COST'
  | 'NO_CHANGE'
  | 'ALREADY_ON_DEEPER_SALE'
  | 'NON_POSITIVE_PRICE'
  | 'MAP_VIOLATION'
  | 'MAP_EXCEPTION_APPLIED'
  | 'BELOW_MIN_MARGIN'
  | 'CLAMPED_TO_MIN_MARGIN'
  | 'LOW_MARGIN'
  | 'BELOW_COST';

export interface CampaignLine {
  itemId: string;
  sku: string;
  title: string;
  brand: string;
  category: string;
  oldPriceCents: Cents;
  newPriceCents: Cents;
  costCents: Cents | null;
  oldMarginPct: number | null;
  newMarginPct: number | null;
  mapCents: Cents | null;
  status: LineStatus;
  reasons: LineReason[];
}

export interface CampaignSummary {
  total: number;
  ok: number;
  warning: number;
  blocked: number;
  excluded: number;
  /** Sum over applicable (ok + warning) lines. */
  revenueDeltaCents: Cents;
  uniformAdjustment: boolean;
}

export interface EvaluateOptions {
  rules: CampaignRules;
  mapExceptions?: MapException[];
  now?: Date;
}

function activeException(itemId: string, list: MapException[] | undefined, now: Date): MapException | undefined {
  return list?.find((e) => e.itemId === itemId && new Date(e.validUntil).getTime() >= now.getTime());
}

/**
 * Evaluate a price adjustment for one item against the commercial rules.
 *
 * MAP is a contractual floor: a line under MAP is `blocked` and no UI
 * confirmation can unblock it. Only a recorded, unexpired MapException
 * (with approver + reference) allows it.
 */
export function evaluateLine(item: CatalogItem, adj: PriceAdjustment, opts: EvaluateOptions): CampaignLine {
  const now = opts.now ?? new Date();
  const reasons: LineReason[] = [];
  let status: LineStatus = 'ok';
  const oldPrice = item.priceCents;
  const promoBasePrice = item.compareAtCents && item.compareAtCents > item.priceCents ? item.compareAtCents : item.priceCents;
  let newPrice = applyAdjustment(promoBasePrice, adj);
  const cost = item.costCents;

  const base = {
    itemId: item.id,
    sku: item.sku,
    title: item.title,
    brand: item.brand,
    category: item.category,
    oldPriceCents: oldPrice,
    costCents: cost,
    oldMarginPct: marginPct(oldPrice, cost),
    mapCents: item.mapPolicy === 'none' ? null : item.mapCents,
  };

  // MAP is checked before anything else can exclude the line, so no path skips it.
  const mapExc = base.mapCents !== null && newPrice < base.mapCents ? activeException(item.id, opts.mapExceptions, now) : undefined;
  const violatesMap = base.mapCents !== null && newPrice < base.mapCents && !mapExc;

  if (cost === null && opts.rules.excludeWithoutCost) {
    return { ...base, newPriceCents: oldPrice, newMarginPct: base.oldMarginPct, status: 'excluded', reasons: violatesMap ? ['NO_COST', 'MAP_VIOLATION'] : ['NO_COST'] };
  }

  if (newPrice <= 0) {
    return { ...base, newPriceCents: newPrice, newMarginPct: null, status: 'blocked', reasons: ['NON_POSITIVE_PRICE'] };
  }

  // Minimum margin floor.
  if (cost !== null) {
    const floor = minPriceForMargin(cost, opts.rules.minMarginPct);
    if (newPrice < floor) {
      if (opts.rules.clampToMinMargin) {
        newPrice = floor;
        reasons.push('CLAMPED_TO_MIN_MARGIN');
        status = 'warning';
      } else {
        reasons.push(newPrice < cost ? 'BELOW_COST' : 'BELOW_MIN_MARGIN');
        status = 'blocked';
      }
    }
  }

  // MAP floor (evaluated after clamping, so a clamped price is still checked).
  if (base.mapCents !== null && newPrice < base.mapCents) {
    const exc = activeException(item.id, opts.mapExceptions, now);
    if (exc) {
      reasons.push('MAP_EXCEPTION_APPLIED');
      if (status === 'ok') status = 'warning';
    } else {
      reasons.push('MAP_VIOLATION');
      status = 'blocked';
    }
  }

  if ((adj.type === 'percent_off' || adj.type === 'amount_off') && newPrice > oldPrice && status !== 'blocked') {
    return { ...base, newPriceCents: oldPrice, newMarginPct: base.oldMarginPct, status: 'excluded', reasons: ['ALREADY_ON_DEEPER_SALE'] };
  }

  if (newPrice === oldPrice && status !== 'blocked') {
    return { ...base, newPriceCents: newPrice, newMarginPct: base.oldMarginPct, status: 'excluded', reasons: ['NO_CHANGE'] };
  }

  const newMargin = marginPct(newPrice, cost);
  if (status === 'ok' && newMargin !== null && newMargin < opts.rules.warnMarginPct) {
    reasons.push('LOW_MARGIN');
    status = 'warning';
  }

  return { ...base, newPriceCents: newPrice, newMarginPct: newMargin, status, reasons };
}

export function evaluateCampaign(
  items: readonly CatalogItem[],
  adj: PriceAdjustment,
  opts: EvaluateOptions,
): { lines: CampaignLine[]; summary: CampaignSummary } {
  const lines = items.map((it) => evaluateLine(it, adj, opts));
  return { lines, summary: summarize(lines, adj) };
}

export function summarize(lines: readonly CampaignLine[], adj: PriceAdjustment): CampaignSummary {
  const s: CampaignSummary = {
    total: lines.length, ok: 0, warning: 0, blocked: 0, excluded: 0, revenueDeltaCents: 0,
    uniformAdjustment: true,
  };
  for (const l of lines) {
    s[l.status] += 1;
    if (l.status === 'ok' || l.status === 'warning') {
      s.revenueDeltaCents += l.newPriceCents - l.oldPriceCents;
      if (l.reasons.includes('CLAMPED_TO_MIN_MARGIN')) s.uniformAdjustment = false;
    }
  }
  if (adj.rounding !== 'none') s.uniformAdjustment = false;
  return s;
}

export function applicableLines(lines: readonly CampaignLine[]): CampaignLine[] {
  return lines.filter((l) => l.status === 'ok' || l.status === 'warning');
}

export type ExecutionStrategy = 'shopify_automatic_discount' | 'variant_price_update';

/**
 * Prefer a native Shopify discount when it reproduces the exact result:
 * a uniform percentage/amount off, online only, with no per-line clamping.
 * Otherwise variant prices must be rewritten (and later restored).
 */
export function chooseExecutionStrategy(
  adj: PriceAdjustment,
  channel: 'online' | 'online_and_pos',
  summary: CampaignSummary,
): ExecutionStrategy {
  if (channel !== 'online') return 'variant_price_update';
  if (adj.type !== 'percent_off' && adj.type !== 'amount_off') return 'variant_price_update';
  if (!summary.uniformAdjustment) return 'variant_price_update';
  return 'shopify_automatic_discount';
}

export interface RestorePlanEntry {
  itemId: string;
  action: 'restore' | 'skip_changed_after_campaign' | 'skip_not_applied';
  fromCents: Cents;
  toCents: Cents;
}

/**
 * Restoring a campaign must never overwrite legitimate later edits: an item
 * is only restored if its current price is still the price the campaign set.
 */
export function planRestore(
  applied: readonly { itemId: string; oldPriceCents: Cents; newPriceCents: Cents; applied: boolean }[],
  currentPrice: (itemId: string) => Cents | undefined,
): RestorePlanEntry[] {
  return applied.map((l) => {
    const cur = currentPrice(l.itemId);
    if (!l.applied || cur === undefined) {
      return { itemId: l.itemId, action: 'skip_not_applied', fromCents: cur ?? l.newPriceCents, toCents: l.oldPriceCents };
    }
    if (cur !== l.newPriceCents) {
      return { itemId: l.itemId, action: 'skip_changed_after_campaign', fromCents: cur, toCents: l.oldPriceCents };
    }
    return { itemId: l.itemId, action: 'restore', fromCents: cur, toCents: l.oldPriceCents };
  });
}

export const REASON_LABELS: Record<LineReason, string> = {
  NO_COST: 'No cost on file — margin cannot be verified',
  NO_CHANGE: 'Price does not change',
  ALREADY_ON_DEEPER_SALE: 'Already on a deeper Sale Price than this discount',
  NON_POSITIVE_PRICE: 'Resulting price is zero or negative',
  MAP_VIOLATION: 'Below MAP — requires an authorised MAP exception',
  MAP_EXCEPTION_APPLIED: 'Below MAP under an authorised exception',
  BELOW_MIN_MARGIN: 'Below minimum margin',
  CLAMPED_TO_MIN_MARGIN: 'Raised to the minimum-margin price',
  LOW_MARGIN: 'Margin below warning threshold',
  BELOW_COST: 'Below cost',
};
