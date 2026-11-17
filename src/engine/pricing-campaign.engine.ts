import {
  CampaignScope,
  ILightspeedRSeriesPort,
  IShopifyPlusPort,
} from '../contracts/integrations';

export interface VariantPricingInput {
  variantId: string;
  skuInternal: string;
  shopifyProductId: string;
  shopifyVariantId: string;
  lightspeedItemId?: number;
  basePriceUsd: number;
  localAvgCostUsd?: number;
  bestSupplierCostUsd?: number;
  hasLocalStock: boolean;
  mapPriceUsd?: number;
  brandEnforcesMap: boolean;
  brandMinMarginPct: number;
  manualPriceOverride: boolean;
}

export interface CampaignDefinition {
  campaignId: string;
  name: string;
  campaignScope: CampaignScope; // 'WEB_ONLY' por defecto; 'OMNICHANNEL_EVENT' en Black Friday, Navidad, etc.
  eventTag?: 'BLACK_FRIDAY' | 'CHRISTMAS' | 'SEASON_CLEARANCE' | string;
  syncToLightspeedPos: boolean; // Solo permitido/activado en eventos especiales omnicanal
  discountMode: 'PERCENT_OFF' | 'FIXED_AMOUNT_OFF';
  discountValue: number;
  campaignMinMarginPct?: number;
  respectMap: boolean;
  endingCentsRounding?: '.99' | '.95' | 'NONE';
}

export interface SimulatedVariantPrice {
  variantId: string;
  skuInternal: string;
  costUsedUsd: number;
  prevPriceUsd: number;
  rawCandidatePriceUsd: number;
  appliedPriceUsd: number;
  compareAtPriceUsd: number | null;
  projectedMarginUsd: number;
  projectedMarginPct: number;
  clampedByMap: boolean;
  clampedByMargin: boolean;
  willSyncToPos: boolean;
}

/**
 * Motor Central de Precios Masivos, Protección MAP y Control de Rentabilidad
 */
export class PricingCampaignEngine {
  constructor(
    private readonly shopifyPlus: IShopifyPlusPort,
    private readonly lightspeedPos: ILightspeedRSeriesPort
  ) {}

  /**
   * Fase 1 obligatoria antes de publicar: Simula precios, detecta topes MAP
   * y alerta márgenes comprometidos para revisión de Carlos Mirabal.
   */
  public simulateCampaign(
    campaign: CampaignDefinition,
    variants: VariantPricingInput[]
  ): SimulatedVariantPrice[] {
    const syncPos =
      campaign.campaignScope === 'OMNICHANNEL_EVENT' && campaign.syncToLightspeedPos === true;

    return variants.map((v) => {
      const costRef =
        v.hasLocalStock && v.localAvgCostUsd != null
          ? v.localAvgCostUsd
          : (v.bestSupplierCostUsd ?? v.localAvgCostUsd ?? 0);

      let candidate =
        campaign.discountMode === 'PERCENT_OFF'
          ? v.basePriceUsd * (1 - campaign.discountValue / 100)
          : v.basePriceUsd - campaign.discountValue;

      candidate = Math.max(0.01, candidate);

      if (campaign.endingCentsRounding === '.99') {
        candidate = Math.floor(candidate) + 0.99;
      } else if (campaign.endingCentsRounding === '.95') {
        candidate = Math.floor(candidate) + 0.95;
      }

      const effectiveMinMarginPct = Math.max(
        v.brandMinMarginPct,
        campaign.campaignMinMarginPct ?? 0
      );
      const marginFloor =
        effectiveMinMarginPct > 0 && effectiveMinMarginPct < 100
          ? costRef / (1 - effectiveMinMarginPct / 100)
          : costRef;

      const mapFloor =
        campaign.respectMap && v.brandEnforcesMap && v.mapPriceUsd != null ? v.mapPriceUsd : 0;

      const clampedByMargin = candidate < marginFloor;
      const clampedByMap = candidate < mapFloor && mapFloor >= marginFloor;

      const finalPrice = Number(Math.max(candidate, marginFloor, mapFloor).toFixed(2));
      const compareAt = finalPrice < v.basePriceUsd ? v.basePriceUsd : null;
      const marginUsd = Number((finalPrice - costRef).toFixed(2));
      const marginPct =
        finalPrice > 0 ? Number(((marginUsd / finalPrice) * 100).toFixed(2)) : 0;

      return {
        variantId: v.variantId,
        skuInternal: v.skuInternal,
        costUsedUsd: Number(costRef.toFixed(2)),
        prevPriceUsd: v.basePriceUsd,
        rawCandidatePriceUsd: Number(candidate.toFixed(2)),
        appliedPriceUsd: finalPrice,
        compareAtPriceUsd: compareAt,
        projectedMarginUsd: marginUsd,
        projectedMarginPct: marginPct,
        clampedByMap,
        clampedByMargin,
        willSyncToPos: syncPos && v.lightspeedItemId != null,
      };
    });
  }

  /**
   * Fase 2: Aplica masivamente en Shopify Plus (Bulk JSONL) y, SOLO si se trata de un
   * evento especial omnicanal (ej. Black Friday, Navidad) con syncToLightspeedPos=true,
   * iguala los precios en el POS de Lightspeed R-Series.
   */
  public async executeApprovedCampaign(
    campaign: CampaignDefinition,
    variants: VariantPricingInput[],
    simulation: SimulatedVariantPrice[]
  ): Promise<{
    shopifyBulkOperationId: string;
    posItemsUpdated: number;
    posSyncTriggered: boolean;
  }> {
    const byId = new Map(variants.map((v) => [v.variantId, v]));

    const shopifyItems = simulation.map((sim) => {
      const v = byId.get(sim.variantId)!;
      return {
        shopifyProductId: v.shopifyProductId,
        shopifyVariantId: v.shopifyVariantId,
        priceUsd: sim.appliedPriceUsd.toFixed(2),
        compareAtPriceUsd: sim.compareAtPriceUsd ? sim.compareAtPriceUsd.toFixed(2) : null,
      };
    });

    const { bulkOperationId } = await this.shopifyPlus.runBulkPriceUpdate(shopifyItems);

    const shouldSyncPos =
      campaign.campaignScope === 'OMNICHANNEL_EVENT' && campaign.syncToLightspeedPos === true;

    let posItemsUpdated = 0;
    if (shouldSyncPos) {
      const posUpdates = simulation
        .filter((s) => s.willSyncToPos)
        .map((s) => ({
          lightspeedItemId: byId.get(s.variantId)!.lightspeedItemId!,
          effectivePriceUsd: s.appliedPriceUsd,
        }));

      if (posUpdates.length > 0) {
        const res = await this.lightspeedPos.syncPosEventPrices(posUpdates);
        posItemsUpdated = res.updatedCount;
      }
    }

    return {
      shopifyBulkOperationId: bulkOperationId,
      posItemsUpdated,
      posSyncTriggered: shouldSyncPos,
    };
  }
}
