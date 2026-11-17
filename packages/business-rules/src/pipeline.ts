/**
 * Core Intermediary Engine rules (Import · Normalize · Store · Compare · Stage · Push):
 *  1. Normalizes heterogeneous supplier schemas (QBP `item_number`, JBI `sku`,
 *     Specialized `partNumber`, etc.) into one canonical model so Shopify never
 *     needs to know how any distributor works.
 *  2. Evaluates the Processing Buffer ("margen de procesamiento"): detects
 *     supplier cost/MAP/availability deltas, snapshots the price currently
 *     published on Shopify for version history, and holds records that would
 *     violate MAP or minimum margin before they reach Shopify.
 *  3. Enforces differentiated sync cadences (15–30 min availability, 6–12 h
 *     costs, daily content, event-driven full catalog) and feed silence
 *     observability (e.g. alerting if JBI stops sending files for 48 hours).
 */
import {
  DEFAULT_CAMPAIGN_RULES,
  DEFAULT_SYNC_CADENCES,
  type CampaignRules,
  type CatalogItem,
  type Cents,
  type MapException,
  type StagingDecision,
  type StagingHoldReason,
  type SupplierChangeType,
  type SupplierOffer,
  type SyncStream,
} from '@ubc/shared';
import { computeAvailability, DEFAULT_AVAILABILITY, type AvailabilitySettings } from './availability.js';
import { normalizeGtin } from './matching.js';
import { marginPct } from './pricing.js';

export interface SupplierFieldProfile {
  supplierSku: readonly string[];
  brand: readonly string[];
  title: readonly string[];
  mpn: readonly string[];
  upc: readonly string[];
  cost: readonly string[];
  map: readonly string[];
  msrp: readonly string[];
  qty: readonly string[];
  dropShip: readonly string[];
  leadDays: readonly string[];
  description: readonly string[];
  images: readonly string[];
}

/**
 * Built-in field profiles per distributor, plus fallback aliases so multi-tenant
 * onboarding (TwoIT Solutions) can plug in new suppliers declaratively.
 */
export const SUPPLIER_FIELD_PROFILES: Record<string, SupplierFieldProfile> = {
  QBP: {
    supplierSku: ['item_number', 'qbp_sku', 'part_number', 'sku'],
    brand: ['brand', 'brand_name', 'manufacturer'],
    title: ['description', 'item_description', 'title', 'name'],
    mpn: ['manufacturer_part_number', 'mfg_part_number', 'mpn'],
    upc: ['upc', 'ean', 'gtin', 'barcode'],
    cost: ['base_cost', 'dealer_cost', 'wholesale_price', 'cost'],
    map: ['map_price', 'umap_price', 'map'],
    msrp: ['msrp', 'retail_price'],
    qty: ['quantity_available', 'total_qty', 'qty_available', 'qty'],
    dropShip: ['drop_ship_eligible', 'dropship', 'drop_ship'],
    leadDays: ['lead_days', 'estimated_lead_days'],
    description: ['long_description', 'marketing_copy'],
    images: ['image_urls', 'images', 'primary_image'],
  },
  JBI: {
    supplierSku: ['sku', 'jbi_item', 'item_no'],
    brand: ['brand', 'vendor_name', 'mfg'],
    title: ['title', 'desc', 'description'],
    mpn: ['mfg_part_no', 'mpn', 'vendor_part'],
    upc: ['upc_code', 'upc', 'gtin'],
    cost: ['dealer_cost', 'net_cost', 'cost'],
    map: ['map', 'min_adv_price'],
    msrp: ['msrp', 'sug_retail'],
    qty: ['qoh', 'qty_avail', 'qty'],
    dropShip: ['dropship_ok', 'drop_ship'],
    leadDays: ['lead_time_days', 'lead_days'],
    description: ['extended_desc', 'long_description'],
    images: ['image_url', 'images'],
  },
  SPECIALIZED: {
    supplierSku: ['partNumber', 'specialized_sku', 'article_number', 'sku'],
    brand: ['brand'],
    title: ['productName', 'modelName', 'title', 'description'],
    mpn: ['partNumber', 'mpn'],
    upc: ['ean', 'upc', 'gtin'],
    cost: ['dealerPrice', 'wholesaleCost', 'cost'],
    map: ['mapPrice', 'retailPrice', 'map'],
    msrp: ['retailPrice', 'msrp'],
    qty: ['inventory', 'b2bAvailableQty', 'qty'],
    dropShip: ['directToConsumer', 'drop_ship'],
    leadDays: ['leadDays', 'etaDays'],
    description: ['copy', 'description_html'],
    images: ['heroImage', 'galleryUrls', 'images'],
  },
};

export interface NormalizedSupplierRecord {
  supplierCode: string;
  supplierSku: string;
  brand: string;
  title: string;
  mpn: string | null;
  upc: string | null;
  costCents: Cents | null;
  mapCents: Cents | null;
  msrpCents: Cents | null;
  qtyAvailable: number;
  dropShip: boolean;
  leadDays: number;
  description: string | null;
  images: string[];
  contentLicensed: boolean;
}

function pickRaw(raw: Record<string, unknown>, keys: readonly string[]): unknown {
  const lowerMap = new Map<string, unknown>();
  for (const [k, v] of Object.entries(raw)) lowerMap.set(k.trim().toLowerCase(), v);
  for (const key of keys) {
    if (key in raw && raw[key] !== undefined && raw[key] !== null && raw[key] !== '') return raw[key];
    const hit = lowerMap.get(key.toLowerCase());
    if (hit !== undefined && hit !== null && hit !== '') return hit;
  }
  return undefined;
}

function parseMoneyCents(val: unknown): Cents | null {
  if (val === undefined || val === null || val === '') return null;
  if (typeof val === 'number') return Number.isFinite(val) && val >= 0 ? Math.round(val * 100) : null;
  const cleaned = String(val).replace(/[$,\s]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}

/**
 * Translates a raw distributor record (from API JSON or parsed CSV object)
 * into UBC Commerce Hub's canonical supplier offer format.
 */
export function normalizeSupplierPayload(
  supplierCode: string,
  raw: Record<string, unknown>,
  opts: { contentLicensed?: boolean; defaultLeadDays?: number; customProfile?: Partial<SupplierFieldProfile> } = {},
): NormalizedSupplierRecord {
  const code = supplierCode.trim().toUpperCase();
  const base = SUPPLIER_FIELD_PROFILES[code] ?? SUPPLIER_FIELD_PROFILES.QBP!;
  const profile: SupplierFieldProfile = { ...base, ...opts.customProfile };

  const skuRaw = pickRaw(raw, profile.supplierSku);
  const supplierSku = skuRaw !== undefined ? String(skuRaw).trim() : '';
  if (!supplierSku) throw new Error(`${code}: missing supplier SKU`);

  const brandRaw = pickRaw(raw, profile.brand);
  const brand = brandRaw !== undefined ? String(brandRaw).trim() : (code === 'SPECIALIZED' ? 'Specialized' : '');
  const titleRaw = pickRaw(raw, profile.title);
  const title = titleRaw !== undefined ? String(titleRaw).trim() : supplierSku;

  const mpnRaw = pickRaw(raw, profile.mpn);
  const upcRaw = pickRaw(raw, profile.upc);
  const normalizedGtin = upcRaw !== undefined ? normalizeGtin(String(upcRaw)) : null;

  const qtyVal = pickRaw(raw, profile.qty);
  const qtyNum = qtyVal === undefined ? 0 : Number(qtyVal);
  const qtyAvailable = Number.isFinite(qtyNum) && qtyNum > 0 ? Math.floor(qtyNum) : 0;

  const dropRaw = pickRaw(raw, profile.dropShip);
  const dropShip = typeof dropRaw === 'boolean' ? dropRaw : /^(1|true|y|yes)$/i.test(String(dropRaw ?? ''));

  const leadRaw = pickRaw(raw, profile.leadDays);
  const leadNum = Number(leadRaw);
  const leadDays = Number.isFinite(leadNum) && leadNum > 0 ? Math.round(leadNum) : (opts.defaultLeadDays ?? 5);

  const licensed = !!opts.contentLicensed;
  const descRaw = licensed ? pickRaw(raw, profile.description) : undefined;
  const imgRaw = licensed ? pickRaw(raw, profile.images) : undefined;
  const images = Array.isArray(imgRaw)
    ? imgRaw.map(String).filter(Boolean)
    : typeof imgRaw === 'string'
      ? imgRaw.split(/[|,;\s]+/).map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s))
      : [];

  return {
    supplierCode: code,
    supplierSku,
    brand,
    title,
    mpn: mpnRaw !== undefined ? String(mpnRaw).trim() || null : null,
    upc: normalizedGtin ?? (upcRaw !== undefined ? String(upcRaw).trim() || null : null),
    costCents: parseMoneyCents(pickRaw(raw, profile.cost)),
    mapCents: parseMoneyCents(pickRaw(raw, profile.map)),
    msrpCents: parseMoneyCents(pickRaw(raw, profile.msrp)),
    qtyAvailable,
    dropShip,
    leadDays,
    description: descRaw !== undefined ? String(descRaw).trim() || null : null,
    images,
    contentLicensed: licensed,
  };
}

export interface PreviousOfferSnapshot {
  costCents: Cents | null;
  mapCents: Cents | null;
  msrpCents: Cents | null;
  qtyAvailable: number;
}

export interface OfferVersionDelta {
  changed: boolean;
  changeTypes: SupplierChangeType[];
  oldCostCents: Cents | null;
  newCostCents: Cents | null;
  oldMapCents: Cents | null;
  newMapCents: Cents | null;
  oldMsrpCents: Cents | null;
  newMsrpCents: Cents | null;
  oldQty: number | null;
  newQty: number;
  /** Exact price UBC had published on Shopify when the supplier changed its data. */
  shopifyPublishedPriceCents: Cents | null;
  /** Resulting gross margin against the published price using the new supplier cost. */
  resultingMarginPct: number | null;
}

/**
 * Versioned diff between the stored supplier offer and the newly received record,
 * capturing the retail price published on Shopify at the moment of change.
 */
export function detectOfferChanges(
  previous: PreviousOfferSnapshot | null,
  incoming: Pick<NormalizedSupplierRecord, 'costCents' | 'mapCents' | 'msrpCents' | 'qtyAvailable'>,
  shopifyPublishedPriceCents: Cents | null,
  safetyQty = DEFAULT_AVAILABILITY.supplierSafetyQty,
): OfferVersionDelta {
  const changeTypes: SupplierChangeType[] = [];
  if (previous) {
    if (previous.costCents !== incoming.costCents) changeTypes.push('cost_changed');
    if (previous.mapCents !== incoming.mapCents) changeTypes.push('map_changed');
    if (previous.msrpCents !== incoming.msrpCents) changeTypes.push('msrp_changed');
    const wasSellable = previous.qtyAvailable > safetyQty;
    const isSellable = incoming.qtyAvailable > safetyQty;
    if (wasSellable !== isSellable || Math.abs(previous.qtyAvailable - incoming.qtyAvailable) >= 5) {
      changeTypes.push('availability_changed');
    }
  } else {
    changeTypes.push('availability_changed');
    if (incoming.costCents !== null) changeTypes.push('cost_changed');
    if (incoming.mapCents !== null) changeTypes.push('map_changed');
  }

  return {
    changed: changeTypes.length > 0,
    changeTypes,
    oldCostCents: previous ? previous.costCents : null,
    newCostCents: incoming.costCents,
    oldMapCents: previous ? previous.mapCents : null,
    newMapCents: incoming.mapCents,
    oldMsrpCents: previous ? previous.msrpCents : null,
    newMsrpCents: incoming.msrpCents,
    oldQty: previous ? previous.qtyAvailable : null,
    newQty: incoming.qtyAvailable,
    shopifyPublishedPriceCents,
    resultingMarginPct:
      shopifyPublishedPriceCents !== null && incoming.costCents !== null
        ? marginPct(shopifyPublishedPriceCents, incoming.costCents)
        : null,
  };
}

export interface ShopifyCleanVariantPayload {
  publishedQty: number;
  inventoryPolicy: 'deny' | 'continue';
  availability: 'in_stock' | 'special_order' | 'unavailable';
  leadTimeDays: number | null;
  clickAndCollectOnly: boolean;
}

export interface StagingEvaluation {
  decision: StagingDecision;
  holdReasons: StagingHoldReason[];
  versionDelta: OfferVersionDelta;
  shopifyPayload: ShopifyCleanVariantPayload | null;
}

function isPickupRestrictedBike(item: Pick<CatalogItem, 'brand' | 'category'>): boolean {
  return item.brand.toLowerCase() === 'specialized' && item.category.toLowerCase().includes('bike');
}

/**
 * Processing Buffer ("margen de procesamiento"): validates supplier updates
 * against canonical catalog state, MAP policy and margin floors BEFORE anything
 * is sent to Shopify.
 */
export function evaluateStagingBuffer(params: {
  item: CatalogItem | null;
  previousOffer: PreviousOfferSnapshot | null;
  incoming: NormalizedSupplierRecord;
  stream?: SyncStream;
  campaignRules?: CampaignRules;
  availabilitySettings?: AvailabilitySettings;
  mapExceptions?: readonly MapException[];
  now?: Date;
}): StagingEvaluation {
  const now = params.now ?? new Date();
  const rules = params.campaignRules ?? DEFAULT_CAMPAIGN_RULES;
  const avSettings = params.availabilitySettings ?? DEFAULT_AVAILABILITY;
  const publishedPrice = params.item ? params.item.priceCents : null;
  const versionDelta = detectOfferChanges(params.previousOffer, params.incoming, publishedPrice, avSettings.supplierSafetyQty);

  if (!params.item) {
    return {
      decision: 'held_for_review',
      holdReasons: ['unmatched_identity'],
      versionDelta,
      shopifyPayload: null,
    };
  }

  const holdReasons: StagingHoldReason[] = [];
  if (params.stream === 'content' && !params.incoming.contentLicensed) {
    holdReasons.push('unlicensed_content');
  }

  const effectiveMap = Math.max(params.item.mapCents ?? 0, params.incoming.mapCents ?? 0);
  const hasMapException = (params.mapExceptions ?? []).some(
    (ex) => ex.itemId === params.item!.id && new Date(ex.validUntil).getTime() > now.getTime(),
  );
  if (effectiveMap > 0 && params.item.priceCents < effectiveMap && !hasMapException) {
    holdReasons.push('map_above_published_price');
  }

  // Margin erosion check when UBC relies on this supplier (no physical stock on hand or supplier cost exceeds stored cost).
  const effectiveCost = params.incoming.costCents ?? params.item.costCents;
  if (effectiveCost !== null) {
    const m = marginPct(params.item.priceCents, effectiveCost);
    if (m !== null && m < rules.minMarginPct) {
      holdReasons.push('margin_below_minimum');
    }
  }

  // Compute clean availability with the updated supplier offer applied to the canonical item.
  const updatedOffer: SupplierOffer = {
    supplierCode: params.incoming.supplierCode,
    supplierSku: params.incoming.supplierSku,
    costCents: params.incoming.costCents ?? params.item.costCents ?? 0,
    qtyAvailable: params.incoming.qtyAvailable,
    reportedAt: now.toISOString(),
    dropShip: params.incoming.dropShip,
    leadDays: params.incoming.leadDays,
  };
  const mergedOffers = [
    ...params.item.offers.filter(
      (o) => !(o.supplierCode === updatedOffer.supplierCode && o.supplierSku === updatedOffer.supplierSku),
    ),
    updatedOffer,
  ];
  const prevAv = computeAvailability(params.item, avSettings, now);
  const nextAv = computeAvailability({ ...params.item, offers: mergedOffers }, avSettings, now);

  const shopifyPayload: ShopifyCleanVariantPayload = {
    publishedQty: nextAv.shopify.publishedQty,
    inventoryPolicy: nextAv.shopify.inventoryPolicy,
    availability: nextAv.status,
    leadTimeDays: nextAv.shopify.leadTimeDays,
    clickAndCollectOnly: isPickupRestrictedBike(params.item),
  };

  if (holdReasons.length > 0) {
    return { decision: 'held_for_review', holdReasons, versionDelta, shopifyPayload };
  }

  const shopifyChanged =
    prevAv.status !== nextAv.status ||
    prevAv.shopify.publishedQty !== nextAv.shopify.publishedQty ||
    prevAv.shopify.inventoryPolicy !== nextAv.shopify.inventoryPolicy ||
    prevAv.shopify.leadTimeDays !== nextAv.shopify.leadTimeDays;

  return {
    decision: shopifyChanged || versionDelta.changed ? 'ready_for_shopify' : 'unchanged',
    holdReasons: [],
    versionDelta,
    shopifyPayload,
  };
}

/**
 * Checks whether a scheduled sync stream is due based on its target interval.
 * Event/manual streams (`intervalMinutes === null`) never auto-fire on timer.
 */
export function isStreamDue(
  stream: SyncStream,
  lastSuccessAt: string | Date | null,
  now: Date = new Date(),
  overrideIntervalMinutes?: number | null,
): boolean {
  const interval = overrideIntervalMinutes !== undefined ? overrideIntervalMinutes : DEFAULT_SYNC_CADENCES[stream].intervalMinutes;
  if (interval === null || interval <= 0) return false;
  if (!lastSuccessAt) return true;
  const elapsedMinutes = (now.getTime() - new Date(lastSuccessAt).getTime()) / 60_000;
  return elapsedMinutes >= interval;
}

export interface SupplierHeartbeatInput {
  supplierCode: string;
  supplierName: string;
  isActive: boolean;
  lastReportAt: string | Date | null;
  maxSilenceHours?: number;
}

export interface FeedWatchdogReport {
  supplierCode: string;
  status: 'healthy' | 'stalled' | 'never_synced' | 'inactive';
  hoursSilent: number | null;
  maxSilenceHours: number;
  alertKey: string | null;
  message: string;
}

/**
 * Observability watchdog: detects silent/stalled supplier feeds (e.g. JBI not
 * delivering SFTP/CSV files for 48 hours) so operators are alerted immediately.
 */
export function evaluateFeedWatchdog(
  suppliers: readonly SupplierHeartbeatInput[],
  now: Date = new Date(),
): FeedWatchdogReport[] {
  return suppliers.map((s) => {
    const threshold = s.maxSilenceHours ?? DEFAULT_SYNC_CADENCES.full_catalog.maxSilenceHours;
    if (!s.isActive) {
      return { supplierCode: s.supplierCode, status: 'inactive', hoursSilent: null, maxSilenceHours: threshold, alertKey: null, message: `${s.supplierName} is inactive.` };
    }
    if (!s.lastReportAt) {
      const dayBucket = now.toISOString().slice(0, 10);
      return {
        supplierCode: s.supplierCode,
        status: 'never_synced',
        hoursSilent: null,
        maxSilenceHours: threshold,
        alertKey: `watchdog:${s.supplierCode}:never:${dayBucket}`,
        message: `${s.supplierName} (${s.supplierCode}) has no recorded feed or sync yet.`,
      };
    }
    const hoursSilent = Math.max(0, Math.round(((now.getTime() - new Date(s.lastReportAt).getTime()) / 3_600_000) * 10) / 10);
    if (hoursSilent >= threshold) {
      const dayBucket = now.toISOString().slice(0, 10);
      return {
        supplierCode: s.supplierCode,
        status: 'stalled',
        hoursSilent,
        maxSilenceHours: threshold,
        alertKey: `watchdog:${s.supplierCode}:stalled:${dayBucket}`,
        message: `${s.supplierName} (${s.supplierCode}) has not sent updates for ${hoursSilent}h (threshold: ${threshold}h).`,
      };
    }
    return {
      supplierCode: s.supplierCode,
      status: 'healthy',
      hoursSilent,
      maxSilenceHours: threshold,
      alertKey: null,
      message: `${s.supplierName} (${s.supplierCode}) healthy (${hoursSilent}h since last update; threshold ${threshold}h).`,
    };
  });
}
