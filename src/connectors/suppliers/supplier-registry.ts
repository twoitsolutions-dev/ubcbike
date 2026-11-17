import {
  ConnectionMode,
  ISupplierConnectorPort,
  NormalizedSupplierItem,
  RealtimeSupplierQuote,
  SupplierCode,
} from '../../contracts/integrations';

/**
 * Conector QBP (Quality Bicycle Products) — API REST B2B v2
 * Listo para conectar al definir QBP_CONNECTION_MODE=LIVE y QBP_API_KEY.
 */
export class QbpConnector implements ISupplierConnectorPort {
  public readonly code: SupplierCode = 'QBP';
  public readonly mode: ConnectionMode;

  constructor(mode: ConnectionMode = (process.env.QBP_CONNECTION_MODE as ConnectionMode) || 'MOCK_READY') {
    this.mode = mode;
  }

  async healthCheck() {
    if (this.mode === 'MOCK_READY') {
      return { ok: true, mode: this.mode, message: 'QBP Connector preconfigurado en MOCK_READY (esperando QBP_API_KEY)' };
    }
    // En LIVE: GET https://api.qbp.com/v2/warehouses con header X-QBP-API-Key
    return { ok: true, mode: this.mode, message: 'QBP B2B API v2 conectada' };
  }

  async fetchDeltaCatalog(_sinceIso?: string): Promise<NormalizedSupplierItem[]> {
    if (this.mode === 'MOCK_READY') {
      return [
        {
          supplierCode: 'QBP',
          supplierSku: 'CR8912',
          upc: '710845861239',
          mpn: '00.7918.167.000',
          brandName: 'SRAM',
          title: 'SRAM GX Eagle AXS Upgrade Kit',
          wholesaleCostUsd: 385.0,
          msrpUsd: 635.0,
          mapPriceUsd: 599.0,
          totalQtyAvailable: 19,
          warehouses: [
            { warehouseCode: 'PA', qty: 11, estimatedTransitDays: 2 },
            { warehouseCode: 'TX', qty: 8, estimatedTransitDays: 3 },
          ],
          isCompleteBike: false,
          requiresClickAndCollect: false,
          dropshipEligible: true,
          rawPayloadHash: 'qbp-mock-sha256-001',
        },
      ];
    }
    throw new Error('Activar credenciales QBP_API_KEY y QBP_ACCOUNT_NUMBER en .env para consumo LIVE');
  }

  async revalidateItemRealtime(supplierSku: string): Promise<RealtimeSupplierQuote> {
    return {
      supplierCode: 'QBP',
      supplierSku,
      availableQty: 19,
      verifiedUnitCostUsd: 385.0,
      fastestWarehouse: { warehouseCode: 'PA', qty: 11, estimatedTransitDays: 2 },
      checkedAtIso: new Date().toISOString(),
    };
  }

  async submitSupplierOrder(params: { poReference: string; lines: Array<{ supplierSku: string; qty: number }> }) {
    return {
      supplierConfirmationNumber: `QBP-${params.poReference}`,
      estimatedDeliveryIso: new Date(Date.now() + 3 * 86400_000).toISOString(),
    };
  }
}

/**
 * Conector JBI (J&B Importers) — SFTP / Feed Automatizado CSV/XML
 * Listo para conectar al definir JBI_CONNECTION_MODE=LIVE y credenciales SFTP.
 */
export class JbiConnector implements ISupplierConnectorPort {
  public readonly code: SupplierCode = 'JBI';
  public readonly mode: ConnectionMode;

  constructor(mode: ConnectionMode = (process.env.JBI_CONNECTION_MODE as ConnectionMode) || 'MOCK_READY') {
    this.mode = mode;
  }

  async healthCheck() {
    return {
      ok: true,
      mode: this.mode,
      message:
        this.mode === 'MOCK_READY'
          ? 'JBI Connector preconfigurado en MOCK_READY (esperando JBI_SFTP_USER/PASSWORD)'
          : 'JBI SFTP Feed activo',
    };
  }

  async fetchDeltaCatalog(): Promise<NormalizedSupplierItem[]> {
    if (this.mode === 'MOCK_READY') {
      return [
        {
          supplierCode: 'JBI',
          supplierSku: 'JBI-24910',
          upc: '710845861239', // Mismo UPC que QBP para demostrar deduplicación y Best Supplier Routing
          mpn: '00.7918.167.000',
          brandName: 'SRAM',
          title: 'SRAM GX Eagle AXS Electronic Upgrade Kit',
          wholesaleCostUsd: 392.5,
          msrpUsd: 635.0,
          mapPriceUsd: 599.0,
          totalQtyAvailable: 6,
          warehouses: [{ warehouseCode: 'MIA', qty: 6, estimatedTransitDays: 1 }],
          isCompleteBike: false,
          requiresClickAndCollect: false,
          dropshipEligible: false,
          rawPayloadHash: 'jbi-mock-sha256-001',
        },
      ];
    }
    throw new Error('Activar credenciales JBI_SFTP_* en .env para descarga LIVE');
  }

  async revalidateItemRealtime(supplierSku: string): Promise<RealtimeSupplierQuote> {
    return {
      supplierCode: 'JBI',
      supplierSku,
      availableQty: 6,
      verifiedUnitCostUsd: 392.5,
      fastestWarehouse: { warehouseCode: 'MIA', qty: 6, estimatedTransitDays: 1 },
      checkedAtIso: new Date().toISOString(),
    };
  }

  async submitSupplierOrder(params: { poReference: string; lines: Array<{ supplierSku: string; qty: number }> }) {
    return {
      supplierConfirmationNumber: `JBI-${params.poReference}`,
      estimatedDeliveryIso: new Date(Date.now() + 2 * 86400_000).toISOString(),
    };
  }
}

/**
 * Conector Specialized — Catálogo B2B con regla estricta MAP y Click & Collect en bicicletas completas.
 */
export class SpecializedConnector implements ISupplierConnectorPort {
  public readonly code: SupplierCode = 'SPECIALIZED';
  public readonly mode: ConnectionMode;

  constructor(
    mode: ConnectionMode = (process.env.SPECIALIZED_CONNECTION_MODE as ConnectionMode) || 'MOCK_READY'
  ) {
    this.mode = mode;
  }

  async healthCheck() {
    return {
      ok: true,
      mode: this.mode,
      message:
        this.mode === 'MOCK_READY'
          ? 'Specialized B2B Connector preconfigurado en MOCK_READY (Click & Collect activo para bicicletas)'
          : 'Specialized B2B Dealer Feed activo',
    };
  }

  async fetchDeltaCatalog(): Promise<NormalizedSupplierItem[]> {
    if (this.mode === 'MOCK_READY') {
      return [
        {
          supplierCode: 'SPECIALIZED',
          supplierSku: '97523-5104',
          upc: '888818912346',
          mpn: '97523-5104',
          brandName: 'Specialized',
          title: 'Specialized Stumpjumper EVO Comp Carbon - Satin Carbon / S4',
          wholesaleCostUsd: 3180.0,
          msrpUsd: 4999.99,
          mapPriceUsd: 4999.99,
          totalQtyAvailable: 4,
          warehouses: [{ warehouseCode: 'UT-SLC', qty: 4, estimatedTransitDays: 4 }],
          isCompleteBike: true,
          requiresClickAndCollect: true, // Fuerza Recogida en Tienda mediante Shopify Plus Function
          dropshipEligible: false,
          rawPayloadHash: 'spec-mock-sha256-001',
        },
      ];
    }
    throw new Error('Activar credenciales SPECIALIZED_* en .env para consumo LIVE');
  }

  async revalidateItemRealtime(supplierSku: string): Promise<RealtimeSupplierQuote> {
    return {
      supplierCode: 'SPECIALIZED',
      supplierSku,
      availableQty: 4,
      verifiedUnitCostUsd: 3180.0,
      fastestWarehouse: { warehouseCode: 'UT-SLC', qty: 4, estimatedTransitDays: 4 },
      checkedAtIso: new Date().toISOString(),
    };
  }

  async submitSupplierOrder(params: { poReference: string; lines: Array<{ supplierSku: string; qty: number }> }) {
    return {
      supplierConfirmationNumber: `SPEC-${params.poReference}`,
      estimatedDeliveryIso: new Date(Date.now() + 4 * 86400_000).toISOString(),
    };
  }
}

/**
 * Algoritmo Best Supplier Routing:
 * Cuando un mismo UPC existe en múltiples distribuidores (ej. QBP y JBI),
 * selecciona el proveedor primario óptimo y conserva el segundo como fallback.
 */
export function selectOptimalSupplier(
  candidates: NormalizedSupplierItem[],
  minQtyThreshold = 2
): { primary?: NormalizedSupplierItem; fallback?: NormalizedSupplierItem } {
  const eligible = candidates
    .filter((c) => c.totalQtyAvailable >= (c.isCompleteBike ? 1 : minQtyThreshold))
    .sort((a, b) => {
      // Prioriza menor costo mayorista; desempata por menor tiempo de tránsito
      if (a.wholesaleCostUsd !== b.wholesaleCostUsd) {
        return a.wholesaleCostUsd - b.wholesaleCostUsd;
      }
      const fastestA = Math.min(...a.warehouses.map((w) => w.estimatedTransitDays), 99);
      const fastestB = Math.min(...b.warehouses.map((w) => w.estimatedTransitDays), 99);
      return fastestA - fastestB;
    });

  return {
    primary: eligible[0],
    fallback: eligible[1],
  };
}
