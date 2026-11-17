import { ShopifyPlusAdapter } from './connectors/platforms/shopify-plus.adapter';
import { LightspeedRSeriesAdapter } from './connectors/platforms/lightspeed-r.adapter';
import {
  JbiConnector,
  QbpConnector,
  SpecializedConnector,
  selectOptimalSupplier,
} from './connectors/suppliers/supplier-registry';
import { ISupplierConnectorPort, SupplierCode } from './contracts/integrations';
import { PricingCampaignEngine } from './engine/pricing-campaign.engine';
import { SpecialOrderStateMachine } from './engine/special-order.statemachine';

/**
 * Contenedor central Plug-and-Play de UBC Commerce Hub.
 * Todos los conectores arrancan en MOCK_READY por defecto y pasan a SANDBOX o LIVE
 * únicamente configurando las credenciales en .env.
 */
export function bootstrapCommerceHub() {
  const shopifyPlus = new ShopifyPlusAdapter();
  const lightspeedPos = new LightspeedRSeriesAdapter();

  const suppliers = new Map<SupplierCode, ISupplierConnectorPort>([
    ['QBP', new QbpConnector()],
    ['JBI', new JbiConnector()],
    ['SPECIALIZED', new SpecializedConnector()],
  ]);

  const pricingEngine = new PricingCampaignEngine(shopifyPlus, lightspeedPos);
  const specialOrderMachine = new SpecialOrderStateMachine(suppliers, lightspeedPos);

  return {
    shopifyPlus,
    lightspeedPos,
    suppliers,
    pricingEngine,
    specialOrderMachine,
    selectOptimalSupplier,
  };
}

export * from './contracts/integrations';
export * from './connectors/platforms/shopify-plus.adapter';
export * from './connectors/platforms/lightspeed-r.adapter';
export * from './connectors/suppliers/supplier-registry';
export * from './engine/pricing-campaign.engine';
export * from './engine/special-order.statemachine';
