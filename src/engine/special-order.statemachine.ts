import {
  ILightspeedRSeriesPort,
  ISupplierConnectorPort,
  SpecialOrderState,
  SupplierCode,
} from '../contracts/integrations';

export interface SpecialOrderRecord {
  id: string;
  shopifyOrderName: string;
  variantTitle: string;
  upc?: string;
  mpn?: string;
  qty: number;
  unitSalePriceUsd: number;
  expectedUnitCostUsd: number;
  verifiedUnitCostUsd?: number;
  verifiedSupplierStock?: number;
  selectedSupplier: SupplierCode;
  selectedSupplierSku: string;
  fallbackSupplier?: SupplierCode;
  fallbackSupplierSku?: string;
  lightspeedVendorId: number;
  state: SpecialOrderState;
  costDriftDetected: boolean;
  lightspeedPoId?: number;
  supplierOrderNumber?: string;
  holdReason?: string;
}

const VALID_TRANSITIONS: Record<SpecialOrderState, SpecialOrderState[]> = {
  DETECTED_SPECIAL_ORDER: ['REVALIDATING_SUPPLIER', 'CANCELLED_REFUNDED'],
  REVALIDATING_SUPPLIER: ['PENDING_APPROVAL', 'EXCEPTION_HOLD'],
  EXCEPTION_HOLD: ['PENDING_APPROVAL', 'CANCELLED_REFUNDED'],
  PENDING_APPROVAL: ['APPROVED_PO_CREATED', 'EXCEPTION_HOLD', 'CANCELLED_REFUNDED'],
  APPROVED_PO_CREATED: ['ORDERED_FROM_SUPPLIER', 'EXCEPTION_HOLD'],
  ORDERED_FROM_SUPPLIER: ['IN_TRANSIT_TO_STORE', 'DROPSHIPPED_TO_CUSTOMER', 'EXCEPTION_HOLD'],
  IN_TRANSIT_TO_STORE: ['RECEIVED_IN_LIGHTSPEED'],
  RECEIVED_IN_LIGHTSPEED: ['READY_FOR_PICKUP'],
  READY_FOR_PICKUP: ['COMPLETED'],
  DROPSHIPPED_TO_CUSTOMER: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED_REFUNDED: [],
};

/**
 * Orquestador y Máquina de Estados de Pedidos Especiales (QBP, JBI, Specialized)
 * Protege márgenes antes de que Carlos Mirabal emita la compra al distribuidor.
 */
export class SpecialOrderStateMachine {
  constructor(
    private readonly suppliers: Map<SupplierCode, ISupplierConnectorPort>,
    private readonly lightspeed: ILightspeedRSeriesPort,
    private readonly maxAllowedCostDriftPct = 3.0
  ) {}

  public assertTransition(from: SpecialOrderState, to: SpecialOrderState): void {
    const allowed = VALID_TRANSITIONS[from] || [];
    if (!allowed.includes(to)) {
      throw new Error(`Transición inválida en Pedido Especial: ${from} -> ${to}`);
    }
  }

  /**
   * Paso automático tras recibir webhook orders/paid sin stock físico en UBC:
   * Revalida inventario y costo mayorista en vivo con el proveedor seleccionado.
   */
  public async revalidateWithSupplier(record: SpecialOrderRecord): Promise<SpecialOrderRecord> {
    this.assertTransition(record.state, 'REVALIDATING_SUPPLIER');
    const connector = this.suppliers.get(record.selectedSupplier);
    if (!connector) {
      throw new Error(`Conector no registrado para proveedor ${record.selectedSupplier}`);
    }

    const quote = await connector.revalidateItemRealtime(record.selectedSupplierSku);
    const driftPct =
      record.expectedUnitCostUsd > 0
        ? ((quote.verifiedUnitCostUsd - record.expectedUnitCostUsd) / record.expectedUnitCostUsd) *
          100
        : 0;

    if (quote.availableQty < record.qty) {
      return {
        ...record,
        state: 'EXCEPTION_HOLD',
        verifiedSupplierStock: quote.availableQty,
        verifiedUnitCostUsd: quote.verifiedUnitCostUsd,
        holdReason: `Stock insuficiente en ${record.selectedSupplier} (${quote.availableQty} disp. vs ${record.qty} req.). Fallback disponible: ${record.fallbackSupplier ?? 'Ninguno'}`,
      };
    }

    if (driftPct > this.maxAllowedCostDriftPct) {
      return {
        ...record,
        state: 'EXCEPTION_HOLD',
        costDriftDetected: true,
        verifiedSupplierStock: quote.availableQty,
        verifiedUnitCostUsd: quote.verifiedUnitCostUsd,
        holdReason: `El costo mayorista subió ${driftPct.toFixed(1)}% (de USD ${record.expectedUnitCostUsd.toFixed(2)} a USD ${quote.verifiedUnitCostUsd.toFixed(2)}). Requiere autorización explícita de Carlos.`,
      };
    }

    return {
      ...record,
      state: 'PENDING_APPROVAL',
      costDriftDetected: false,
      verifiedSupplierStock: quote.availableQty,
      verifiedUnitCostUsd: quote.verifiedUnitCostUsd,
      holdReason: undefined,
    };
  }

  /**
   * Ejecutado cuando Carlos Mirabal aprueba la compra desde el Panel Administrativo:
   * 1. Crea el ítem Just-In-Time en Lightspeed R-Series (si no existía) y lo agrega a la PO abierta.
   * 2. Registra/envía el pedido al distribuidor correspondiente.
   */
  public async approveAndGeneratePurchaseOrder(
    record: SpecialOrderRecord,
    existingOpenLightspeedPoId?: number
  ): Promise<SpecialOrderRecord> {
    if (record.state === 'EXCEPTION_HOLD') {
      this.assertTransition('EXCEPTION_HOLD', 'PENDING_APPROVAL');
      record = { ...record, state: 'PENDING_APPROVAL' };
    }
    this.assertTransition(record.state, 'APPROVED_PO_CREATED');

    const unitCost = record.verifiedUnitCostUsd ?? record.expectedUnitCostUsd;

    const { lightspeedPoId } = await this.lightspeed.ensureJitItemAndAttachToPurchaseOrder({
      upc: record.upc,
      mpn: record.mpn,
      title: record.variantTitle,
      vendorId: record.lightspeedVendorId,
      wholesaleCostUsd: unitCost,
      retailPriceUsd: record.unitSalePriceUsd,
      qty: record.qty,
      existingOpenPoId: existingOpenLightspeedPoId,
    });

    const connector = this.suppliers.get(record.selectedSupplier)!;
    const supplierOrder = await connector.submitSupplierOrder({
      poReference: `LS-PO-${lightspeedPoId}`,
      lines: [{ supplierSku: record.selectedSupplierSku, qty: record.qty }],
    });

    return {
      ...record,
      state: 'ORDERED_FROM_SUPPLIER',
      lightspeedPoId,
      supplierOrderNumber: supplierOrder.supplierConfirmationNumber,
    };
  }
}
