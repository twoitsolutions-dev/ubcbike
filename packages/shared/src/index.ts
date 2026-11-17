/**
 * Shared domain types for UBC Commerce Hub.
 *
 * Conventions:
 *  - All money values are integer cents (USD). Never floats.
 *  - Percentages are expressed as fractions in [0, 1] inside the rules
 *    engine (0.2 = 20 %). The UI converts to/from human percentages.
 *  - Every persisted record belongs to exactly one company (tenant).
 */

export type Cents = number;

export type AppMode = 'demo' | 'live';

export type Role = 'owner' | 'admin' | 'purchasing' | 'staff' | 'viewer';

export type Permission =
  | 'catalog.read'
  | 'catalog.write'
  | 'pricing.write'
  | 'campaign.approve'
  | 'map.exception'
  | 'orders.read'
  | 'orders.write'
  | 'purchasing.approve'
  | 'integrations.manage'
  | 'settings.manage'
  | 'audit.read';

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: [
    'catalog.read', 'catalog.write', 'pricing.write', 'campaign.approve', 'map.exception',
    'orders.read', 'orders.write', 'purchasing.approve', 'integrations.manage',
    'settings.manage', 'audit.read',
  ],
  admin: [
    'catalog.read', 'catalog.write', 'pricing.write', 'campaign.approve', 'map.exception',
    'orders.read', 'orders.write', 'purchasing.approve', 'integrations.manage',
    'settings.manage', 'audit.read',
  ],
  // Carlos Mirabal's role: buying, suppliers, pricing and promotions.
  purchasing: [
    'catalog.read', 'catalog.write', 'pricing.write', 'campaign.approve',
    'orders.read', 'orders.write', 'purchasing.approve', 'audit.read',
  ],
  staff: ['catalog.read', 'orders.read', 'orders.write'],
  viewer: ['catalog.read', 'orders.read'],
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export type PublishStatus = 'published' | 'hidden' | 'draft';

/** MAP = Minimum Advertised Price. 'umap' policies are treated the same as 'map' (hard floor). */
export type MapPolicy = 'none' | 'map' | 'umap';

export interface SupplierOffer {
  supplierCode: string;
  supplierSku: string;
  costCents: Cents;
  qtyAvailable: number;
  /** ISO timestamp of when the supplier reported this quantity. */
  reportedAt: string;
  dropShip: boolean;
  leadDays: number;
}

/**
 * A sellable unit (a Lightspeed "Item", a Shopify "ProductVariant").
 * Pricing, inventory and campaigns operate at this level.
 */
export interface CatalogItem {
  id: string;
  productId: string;
  title: string;
  brand: string;
  model: string;
  category: string;
  sku: string;
  upc: string | null;
  mpn: string | null;
  priceCents: Cents;
  compareAtCents: Cents | null;
  /** UBC's own replacement / landed cost. Null when unknown. */
  costCents: Cents | null;
  mapCents: Cents | null;
  mapPolicy: MapPolicy;
  status: PublishStatus;
  /** Units physically owned by UBC (sum of physical locations). */
  physicalQty: number;
  /** Units already promised to orders and not yet fulfilled. */
  reservedQty: number;
  offers: SupplierOffer[];
  shopifyVariantId: string | null;
  lightspeedItemId: string | null;
  updatedAt: string;
  /** Optimistic-locking version, incremented on every write. */
  version: number;
}

export type AdjustmentType =
  | 'percent_off'
  | 'amount_off'
  | 'percent_increase'
  | 'amount_increase'
  | 'set_price';

export interface PriceAdjustment {
  type: AdjustmentType;
  /** Fraction for percent types (0.2), cents for amount/set types. */
  value: number;
  rounding: 'none' | 'charm_99' | 'whole_dollar';
}

export interface CampaignRules {
  /** Hard floor. Lines whose new margin is below this are blocked (or clamped). */
  minMarginPct: number;
  /** Lines below this margin are flagged with a warning. */
  warnMarginPct: number;
  /** When true, prices that break the minimum margin are raised to the floor instead of blocked. */
  clampToMinMargin: boolean;
  /** Exclude items with no known cost (cannot verify margin). Always true in the default rules. */
  excludeWithoutCost: boolean;
}

export const DEFAULT_CAMPAIGN_RULES: CampaignRules = {
  minMarginPct: 0.15,
  warnMarginPct: 0.25,
  clampToMinMargin: false,
  excludeWithoutCost: true,
};

/** Authorised exception allowing a specific item to go below MAP (e.g. written vendor approval). */
export interface MapException {
  itemId: string;
  approvedBy: string;
  reference: string;
  validUntil: string;
}

export type CampaignChannel = 'online' | 'online_and_pos';

/**
 * POS price parity (`online_and_pos`) is reserved exclusively for major
 * omnichannel events (Black Friday, Christmas, etc.). Daily promos stay `online`.
 */
export type PosSyncEventType =
  | 'black_friday'
  | 'christmas'
  | 'holiday_sale'
  | 'annual_clearance'
  | 'special_event';

export const POS_SYNC_EVENT_LABELS: Record<PosSyncEventType, string> = {
  black_friday: 'Black Friday / Cyber Weekend',
  christmas: 'Christmas / Holiday Sale',
  holiday_sale: 'Seasonal / Holiday Event',
  annual_clearance: 'Annual Storewide Clearance',
  special_event: 'Special In-Store & Online Event',
};

export type ShopifyPlan = 'trial' | 'basic' | 'grow' | 'standard' | 'advanced' | 'plus';

export type CampaignStatus =
  | 'draft'
  | 'scheduled'
  | 'applying'
  | 'active'
  | 'restoring'
  | 'restored'
  | 'cancelled'
  | 'failed';

export interface ItemFilter {
  q?: string;
  ids?: string[];
  categories?: string[];
  brands?: string[];
  suppliers?: string[];
  priceMinCents?: number;
  priceMaxCents?: number;
  marginMinPct?: number;
  marginMaxPct?: number;
  stock?: 'any' | 'physical' | 'virtual_only' | 'unavailable';
  status?: PublishStatus | 'any';
}

export type SpecialOrderStatus =
  | 'new_order'
  | 'awaiting_review'
  | 'awaiting_approval'
  | 'approved'
  | 'po_submitted'
  | 'supplier_confirmed'
  | 'in_transit'
  | 'received_at_ubc'
  | 'ready_for_pickup'
  | 'shipped_to_customer'
  | 'completed'
  | 'exception'
  | 'cancelled';

export const SPECIAL_ORDER_STATUS_LABELS: Record<SpecialOrderStatus, string> = {
  new_order: 'New Order',
  awaiting_review: 'Awaiting Review',
  awaiting_approval: 'Awaiting Approval',
  approved: 'Approved',
  po_submitted: 'Purchase Order Submitted',
  supplier_confirmed: 'Supplier Confirmed',
  in_transit: 'In Transit',
  received_at_ubc: 'Received at UBC',
  ready_for_pickup: 'Ready for Pickup',
  shipped_to_customer: 'Shipped to Customer',
  completed: 'Completed',
  exception: 'Exception',
  cancelled: 'Cancelled',
};

export type ExceptionReason =
  | 'out_of_stock_after_purchase'
  | 'cost_changed'
  | 'discontinued'
  | 'partially_available'
  | 'po_rejected'
  | 'connection_error'
  | 'damaged'
  | 'return_requested'
  | 'refund_requested'
  | 'other';

export type IntegrationSystem =
  | 'shopify'
  | 'lightspeed_r'
  | 'qbp'
  | 'jbi'
  | 'specialized';

export type IntegrationStatus = 'not_connected' | 'configured' | 'connected' | 'error' | 'demo_adapter';

/**
 * Intermediary Engine sync streams with differentiated cadences:
 *  - availability: every 15–30 minutes
 *  - costs: every 6–12 hours
 *  - content: daily (descriptions & images, subject to supplier license)
 *  - full_catalog: on supplier change / manual import
 */
export type SyncStream = 'availability' | 'costs' | 'content' | 'full_catalog';

export interface SyncCadencePolicy {
  stream: SyncStream;
  /** Target polling interval in minutes (`null` = event/manual driven). */
  intervalMinutes: number | null;
  /** Design range [min, max] in minutes for operator reference. */
  windowMinutes: [number, number] | null;
  /** Alert threshold in hours if no successful feed/pull arrives. */
  maxSilenceHours: number;
}

export const DEFAULT_SYNC_CADENCES: Record<SyncStream, SyncCadencePolicy> = {
  availability: { stream: 'availability', intervalMinutes: 20, windowMinutes: [15, 30], maxSilenceHours: 2 },
  costs: { stream: 'costs', intervalMinutes: 540, windowMinutes: [360, 720], maxSilenceHours: 24 },
  content: { stream: 'content', intervalMinutes: 1440, windowMinutes: [1440, 1440], maxSilenceHours: 48 },
  full_catalog: { stream: 'full_catalog', intervalMinutes: null, windowMinutes: null, maxSilenceHours: 48 },
};

export type SupplierChangeType =
  | 'cost_changed'
  | 'map_changed'
  | 'msrp_changed'
  | 'availability_changed';

export type StagingDecision = 'ready_for_shopify' | 'held_for_review' | 'unchanged';

export type StagingHoldReason =
  | 'map_above_published_price'
  | 'margin_below_minimum'
  | 'unlicensed_content'
  | 'unmatched_identity';

export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const rest = (abs % 100).toString().padStart(2, '0');
  return `${sign}$${dollars}.${rest}`;
}
