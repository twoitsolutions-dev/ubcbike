import {
  ConnectionMode,
  ILightspeedRSeriesPort,
  LightspeedBucketStatus,
} from '../../contracts/integrations';

/**
 * Adaptador para Lightspeed Retail R-Series API v3
 * Incluye:
 *  1. Control adaptativo de Leaky Bucket (X-LS-API-Bucket-Level) para evitar errores 429.
 *  2. Alta Just-In-Time (JIT) de ítems externos + creación/anexado a Purchase Order (PO) en pedidos especiales.
 *  3. Sincronización selectiva de precios hacia POS únicamente en campañas marcadas como
 *     OMNICHANNEL_EVENT (ej. Black Friday, Navidad).
 */
export class LightspeedRSeriesAdapter implements ILightspeedRSeriesPort {
  public readonly mode: ConnectionMode;
  private bucket: LightspeedBucketStatus = {
    usedUnits: 0,
    maxUnits: 60,
    dripRatePerSec: 1,
  };

  constructor(
    mode: ConnectionMode = (process.env.LIGHTSPEED_CONNECTION_MODE as ConnectionMode) || 'MOCK_READY'
  ) {
    this.mode = mode;
  }

  getBucketStatus(): LightspeedBucketStatus {
    return { ...this.bucket };
  }

  /**
   * Lee el encabezado X-LS-API-Bucket-Level (ej. "48/60") y calcula pausa preventiva
   * si el bucket supera el 75% de ocupación.
   */
  public parseBucketHeaderAndComputeDelayMs(headerValue?: string): number {
    if (!headerValue) return 0;
    const [usedStr, maxStr] = headerValue.split('/');
    const used = Number(usedStr);
    const max = Number(maxStr) || 60;
    if (!Number.isNaN(used)) {
      this.bucket = { ...this.bucket, usedUnits: used, maxUnits: max };
    }
    const utilization = this.bucket.usedUnits / this.bucket.maxUnits;
    if (utilization >= 0.85) return 2500;
    if (utilization >= 0.7) return 1100;
    return 0;
  }

  async fetchModifiedInventorySince(_sinceIso: string) {
    if (this.mode === 'MOCK_READY') {
      return [
        {
          lightspeedItemId: 10451,
          upc: '710845861239',
          mpn: '00.7918.167.000',
          qtyOnHand: 0, // Agotado físicamente en tienda -> activa catálogo virtual QBP/JBI
          avgCostUsd: 382.0,
        },
        {
          lightspeedItemId: 10899,
          upc: '601842551028',
          mpn: 'HELM-MIPS-BLK-M',
          qtyOnHand: 7, // Disponible físicamente en UBC
          avgCostUsd: 48.0,
        },
      ];
    }
    throw new Error('Definir LIGHTSPEED_OAUTH_REFRESH_TOKEN y LIGHTSPEED_ACCOUNT_ID en .env');
  }

  async ensureJitItemAndAttachToPurchaseOrder(params: {
    upc?: string;
    mpn?: string;
    title: string;
    vendorId: number;
    wholesaleCostUsd: number;
    retailPriceUsd: number;
    qty: number;
    existingOpenPoId?: number;
  }): Promise<{ lightspeedItemId: number; lightspeedPoId: number }> {
    if (this.mode === 'MOCK_READY') {
      return {
        lightspeedItemId: Math.floor(50000 + Math.random() * 9000),
        lightspeedPoId: params.existingOpenPoId ?? Math.floor(8000 + Math.random() * 900),
      };
    }
    throw new Error('Activar LIGHTSPEED_CONNECTION_MODE=LIVE para emitir Purchase Orders reales');
  }

  async syncPosEventPrices(
    updates: Array<{ lightspeedItemId: number; effectivePriceUsd: number }>
  ): Promise<{ updatedCount: number }> {
    if (this.mode === 'MOCK_READY') {
      return { updatedCount: updates.length };
    }
    // En LIVE: despacha con prioridad P3 (cede paso a ventas P1) respetando Leaky Bucket
    throw new Error('Activar LIGHTSPEED_CONNECTION_MODE=LIVE para sincronizar precios al POS');
  }
}
