import { h } from './dom.js';

export function money(cents) {
  if (cents === null || cents === undefined || isNaN(cents)) return '—';
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return sign + '$' + dollars + '.' + String(abs % 100).padStart(2, '0');
}

export function pct(fraction, digits) {
  if (fraction === null || fraction === undefined || isNaN(fraction)) return '—';
  return (fraction * 100).toFixed(digits === undefined ? 1 : digits) + '%';
}

export function margin(price, cost) {
  if (cost === null || cost === undefined || !price) return null;
  return (price - cost) / price;
}

export function dateTime(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function date(v) {
  if (!v) return '—';
  const d = new Date(v);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function ago(v) {
  if (!v) return '—';
  const s = (Date.now() - new Date(v).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  return Math.floor(s / 86400) + ' d ago';
}

export const ORDER_STATUS = {
  new_order: ['New Order', ''],
  awaiting_review: ['Awaiting Review', 'warn'],
  awaiting_approval: ['Awaiting Approval', 'warn'],
  approved: ['Approved', 'info'],
  po_submitted: ['PO Submitted', 'info'],
  supplier_confirmed: ['Supplier Confirmed', 'info'],
  in_transit: ['In Transit', 'info'],
  received_at_ubc: ['Received at UBC', 'info'],
  ready_for_pickup: ['Ready for Pickup', 'ok'],
  shipped_to_customer: ['Shipped to Customer', 'ok'],
  completed: ['Completed', 'ok'],
  exception: ['Exception', 'bad'],
  cancelled: ['Cancelled', ''],
};

export const EXCEPTION_REASONS = {
  out_of_stock_after_purchase: 'Out of stock after purchase',
  cost_changed: 'Supplier cost changed',
  discontinued: 'Discontinued',
  partially_available: 'Partially available',
  po_rejected: 'PO rejected by supplier',
  connection_error: 'Connection error',
  damaged: 'Damaged product',
  return_requested: 'Return requested',
  refund_requested: 'Refund requested',
  other: 'Other',
};

export function orderBadge(status) {
  const s = ORDER_STATUS[status] || [status, ''];
  return h('span.badge', { class: s[1] }, s[0]);
}

export function availabilityBadge(av) {
  if (!av) return h('span.badge', '—');
  if (av.status === 'in_stock') return h('span.badge.ok', { title: 'Physical units at UBC store' }, 'In stock at UBC · ' + av.sellablePhysical);
  if (av.status === 'special_order') return h('span.badge.violet', { title: 'Available from an authorized supplier; not physically in UBC stock' }, 'Special order · ' + av.estimatedLeadDays + 'd');
  return h('span.badge.bad', 'Unavailable');
}

export const LINE_STATUS = { ok: ['Will apply', 'ok'], warning: ['Warning', 'warn'], blocked: ['Blocked', 'bad'], excluded: ['Excluded', ''] };

export const REASON_LABELS = {
  NO_COST: 'No cost on file',
  NO_CHANGE: 'No price change',
  ALREADY_ON_DEEPER_SALE: 'Already on deeper Sale Price',
  NON_POSITIVE_PRICE: 'Price <= 0',
  MAP_VIOLATION: 'Below MAP',
  MAP_EXCEPTION_APPLIED: 'MAP exception',
  BELOW_MIN_MARGIN: 'Below min. margin',
  CLAMPED_TO_MIN_MARGIN: 'Raised to min. margin',
  LOW_MARGIN: 'Low margin',
  BELOW_COST: 'Below cost',
  CHANGED_SINCE_PREVIEW: 'Changed since preview',
};

export const CAMPAIGN_STATUS = {
  draft: ['Draft', ''], scheduled: ['Scheduled', 'info'], applying: ['Applying…', 'info'], active: ['Active', 'ok'],
  restoring: ['Restoring…', 'info'], restored: ['Restored', ''], cancelled: ['Cancelled', ''], failed: ['Failed', 'bad'],
};

export const POS_EVENT_LABELS = {
  black_friday: 'Black Friday / Cyber Weekend',
  christmas: 'Christmas / Holiday Sale',
  holiday_sale: 'Seasonal / Holiday Event',
  annual_clearance: 'Annual Storewide Clearance',
  special_event: 'Special In-Store & Online Event',
};

export function channelBadge(channel, summary) {
  if (channel !== 'online_and_pos') {
    return h('span.badge', { title: 'Applies to Shopify Plus online store only; physical POS register prices stay unchanged' }, 'Online only');
  }
  const ev = summary && summary.posEventType ? POS_EVENT_LABELS[summary.posEventType] || summary.posEventType : null;
  return h('span.badge.violet', { title: 'Omnichannel event: synchronizes prices across Shopify Plus online store and Lightspeed R-Series physical store POS' },
    ev ? 'Online + Store POS · ' + ev : 'Online + Store POS');
}

export function campaignBadge(s) {
  const v = CAMPAIGN_STATUS[s] || [s, ''];
  return h('span.badge', { class: v[1] }, v[0]);
}

export function adjustmentLabel(a) {
  if (!a) return '';
  switch (a.type) {
    case 'percent_off': return pct(a.value, 0) + ' off';
    case 'amount_off': return money(a.value) + ' off';
    case 'percent_increase': return '+' + pct(a.value, 0);
    case 'amount_increase': return '+' + money(a.value);
    case 'set_price': return 'Set to ' + money(a.value);
    default: return a.type;
  }
}
