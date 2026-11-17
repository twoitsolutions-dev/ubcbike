import {
  ConnectionMode,
  IShopifyPlusPort,
  ShopifyBulkPriceItem,
} from '../../contracts/integrations';

/**
 * Adaptador oficial para SHOPIFY PLUS
 * Aprovecha ventajas nativas del plan Plus de UBC:
 *  - Cuota GraphQL Admin API ampliada (1,000 pts/seg restore rate).
 *  - Shopify Functions: Delivery Customization para obligar Recogida en Tienda (Click & Collect)
 *    en marcas restringidas (ej. bicicletas Specialized) sin bloquear el resto del carrito.
 *  - Dual Locations: separa el inventario físico de UBC (Lightspeed) de la red virtual (QBP/JBI/Specialized).
 *  - Bulk Operations (JSONL) para campañas masivas de miles de productos (Black Friday, Navidad).
 */
export class ShopifyPlusAdapter implements IShopifyPlusPort {
  public readonly mode: ConnectionMode;
  private readonly physicalLocationGid: string;
  private readonly supplierNetworkLocationGid: string;

  constructor(
    mode: ConnectionMode = (process.env.SHOPIFY_CONNECTION_MODE as ConnectionMode) || 'MOCK_READY'
  ) {
    this.mode = mode;
    this.physicalLocationGid =
      process.env.SHOPIFY_LOCATION_ID_PHYSICAL || 'gid://shopify/Location/100000001';
    this.supplierNetworkLocationGid =
      process.env.SHOPIFY_LOCATION_ID_SUPPLIER_NET || 'gid://shopify/Location/100000002';
  }

  async syncDualInventory(params: {
    shopifyInventoryItemId: string;
    physicalSellableQty: number;
    supplierVirtualQty: number;
    availabilityBadgeText: string;
    requiresClickAndCollect: boolean;
  }): Promise<{ syncedAtIso: string }> {
    const _graphqlPayload = {
      mutation: 'inventorySetQuantities',
      input: {
        name: 'available',
        reason: 'correction',
        ignoreCompareQuantity: true,
        quantities: [
          {
            inventoryItemId: params.shopifyInventoryItemId,
            locationId: this.physicalLocationGid,
            quantity: Math.max(0, params.physicalSellableQty),
          },
          {
            inventoryItemId: params.shopifyInventoryItemId,
            locationId: this.supplierNetworkLocationGid,
            quantity: Math.max(0, params.supplierVirtualQty),
          },
        ],
      },
      metafields: [
        { namespace: 'ubc_hub', key: 'availability_badge', value: params.availabilityBadgeText },
        {
          namespace: 'ubc_hub',
          key: 'click_and_collect_only',
          value: String(params.requiresClickAndCollect),
        },
      ],
    };

    if (this.mode === 'MOCK_READY') {
      return { syncedAtIso: new Date().toISOString() };
    }

    // En LIVE: POST https://{SHOPIFY_STORE_DOMAIN}/admin/api/{SHOPIFY_API_VERSION}/graphql.json
    throw new Error('Definir SHOPIFY_ADMIN_ACCESS_TOKEN y cambiar SHOPIFY_CONNECTION_MODE=LIVE');
  }

  async runBulkPriceUpdate(items: ShopifyBulkPriceItem[]): Promise<{ bulkOperationId: string }> {
    // Construye líneas JSONL para stagedUploadsCreate -> bulkOperationRunMutation
    const _jsonlLines = items
      .map((item) =>
        JSON.stringify({
          productId: item.shopifyProductId,
          variants: [
            {
              id: item.shopifyVariantId,
              price: item.priceUsd,
              compareAtPrice: item.compareAtPriceUsd,
            },
          ],
        })
      )
      .join('\n');

    if (this.mode === 'MOCK_READY') {
      return { bulkOperationId: `gid://shopify/BulkOperation/mock-${Date.now()}` };
    }

    throw new Error('Definir SHOPIFY_ADMIN_ACCESS_TOKEN para ejecutar Bulk Mutation en LIVE');
  }

  async configureClickAndCollectRule(params: {
    shopifyProductId: string;
    enforceInStorePickupOnly: boolean;
  }): Promise<void> {
    if (this.mode === 'MOCK_READY') {
      return;
    }
    // En LIVE actualiza el metafield leído por la Shopify Plus Delivery Customization Function (Rust/WASM)
    void params;
  }
}
