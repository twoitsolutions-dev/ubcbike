/**
 * UBC COMMERCE HUB — Contratos Hexagonales de Integración (Ports & DTOs)
 * Diseñado para conectar Shopify Plus, Lightspeed R-Series y Distribuidores (QBP, JBI, Specialized)
 * mediante adaptadores intercambiables (MOCK_READY -> SANDBOX -> LIVE).
 */

export type ConnectionMode = 'MOCK_READY' | 'SANDBOX' | 'LIVE';

export type SupplierCode = 'QBP' | 'JBI' | 'SPECIALIZED';

export type CampaignScope = 'WEB_ONLY' | 'OMNICHANNEL_EVENT';

export type SpecialOrderState =
  | 'DETECTED_SPECIAL_ORDER'
  | 'REVALIDATING_SUPPLIER'
  | 'PENDING_APPROVAL'
  | 'EXCEPTION_HOLD'
  | 'APPROVED_PO_CREATED'
  | 'ORDERED_FROM_SUPPLIER'
  | 'IN_TRANSIT_TO_STORE'
  | 'DROPSHIPPED_TO_CUSTOMER'
  | 'RECEIVED_IN_LIGHTSPEED'
  | 'READY_FOR_PICKUP'
  | 'COMPLETED'
  | 'CANCELLED_REFUNDED';

export interface WarehouseStock {
  warehouseCode: string;
  qty: number;
  estimatedTransitDays: number;
}

export interface NormalizedSupplierItem {
  supplierCode: SupplierCode;
  supplierSku: string;
  upc?: string;
  mpn?: string;
  brandName: string;
  title: string;
  wholesaleCostUsd: number;
  msrpUsd?: number;
  mapPriceUsd?: number;
  totalQtyAvailable: number;
  warehouses: WarehouseStock[];
  isCompleteBike: boolean;
  requiresClickAndCollect: boolean;
  dropshipEligible: boolean;
  rawPayloadHash: string;
}

export interface RealtimeSupplierQuote {
  supplierCode: SupplierCode;
  supplierSku: string;
  availableQty: number;
  verifiedUnitCostUsd: number;
  fastestWarehouse?: WarehouseStock;
  checkedAtIso: string;
}

export interface ISupplierConnectorPort {
  readonly code: SupplierCode;
  readonly mode: ConnectionMode;
  healthCheck(): Promise<{ ok: boolean; mode: ConnectionMode; message: string }>;
  fetchDeltaCatalog(sinceIso?: string): Promise<NormalizedSupplierItem[]>;
  revalidateItemRealtime(supplierSku: string): Promise<RealtimeSupplierQuote>;
  submitSupplierOrder(params: {
    poReference: string;
    lines: Array<{ supplierSku: string; qty: number }>;
    shipToCustomerAddress?: Record<string, string>;
  }): Promise<{ supplierConfirmationNumber: string; estimatedDeliveryIso: string }>;
}

export interface ShopifyBulkPriceItem {
  shopifyProductId: string;
  shopifyVariantId: string;
  priceUsd: string;
  compareAtPriceUsd: string | null;
}

export interface IShopifyPlusPort {
  readonly mode: ConnectionMode;
  /**
   * Sincroniza existencias separando estrictamente ubicación física (Lightspeed)
   * de ubicación virtual (Red de Distribuidores).
   */
  syncDualInventory(params: {
    shopifyInventoryItemId: string;
    physicalSellableQty: number;
    supplierVirtualQty: number;
    availabilityBadgeText: string;
    requiresClickAndCollect: boolean;
  }): Promise<{ syncedAtIso: string }>;

  /**
   * Ejecuta actualización masiva de precios sobre Shopify Plus usando
   * GraphQL Bulk Mutation (JSONL) para eventos como Black Friday o Navidad.
   */
  runBulkPriceUpdate(items: ShopifyBulkPriceItem[]): Promise<{ bulkOperationId: string }>;

  /**
   * Configura metadatos consumidos por Shopify Plus Delivery Customization Function
   * para bloquear envío a domicilio en marcas restringidas (ej. bicicletas Specialized -> In-Store Pickup).
   */
  configureClickAndCollectRule(params: {
    shopifyProductId: string;
    enforceInStorePickupOnly: boolean;
  }): Promise<void>;
}

export interface LightspeedBucketStatus {
  usedUnits: number;
  maxUnits: number;
  dripRatePerSec: number;
}

export interface ILightspeedRSeriesPort {
  readonly mode: ConnectionMode;
  getBucketStatus(): LightspeedBucketStatus;
  fetchModifiedInventorySince(sinceIso: string): Promise<
    Array<{
      lightspeedItemId: number;
      upc?: string;
      mpn?: string;
      qtyOnHand: number;
      avgCostUsd: number;
    }>
  >;

  /**
   * Crea el producto Just-In-Time (solo cuando existe venta real de catálogo externo)
   * y lo anexa a una Orden de Compra (Purchase Order) en Lightspeed R-Series.
   */
  ensureJitItemAndAttachToPurchaseOrder(params: {
    upc?: string;
    mpn?: string;
    title: string;
    vendorId: number;
    wholesaleCostUsd: number;
    retailPriceUsd: number;
    qty: number;
    existingOpenPoId?: number;
  }): Promise<{ lightspeedItemId: number; lightspeedPoId: number }>;

  /**
   * Sincronización selectiva de precios hacia la caja registradora (POS).
   * SOLO se invoca cuando una campaña tiene campaignScope === 'OMNICHANNEL_EVENT'
   * y syncToLightspeedPos === true (ej. Black Friday, Navidad).
   */
  syncPosEventPrices(
    updates: Array<{ lightspeedItemId: number; effectivePriceUsd: number }>
  ): Promise<{ updatedCount: number }>;
}
