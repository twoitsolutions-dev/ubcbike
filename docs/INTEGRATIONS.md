# Integraciones: estado técnico y preparación Plug-and-Play

Estado actual de ejecución: **`APP_MODE=demo`** (datos simulados deterministas; todo el cableado técnico queda listo para conectar credenciales reales en `.env`).

## 1. Shopify Plus (Admin GraphQL + OS 2.0 + Functions)
- **Confirmado:** UBC operará sobre **Shopify Plus** (`SHOPIFY_PLAN=plus`).
- **Listo en código (`packages/integrations/src/shopify/`):**
  - Cliente GraphQL con versión fijada (`SHOPIFY_API_VERSION=2026-10`), reintentos exponenciales ante `THROTTLED`/429/5xx, soporte de cuota Plus (1,000 pts/seg) e interruptor global `SHOPIFY_WRITES_ENABLED`.
  - Operaciones implementadas: `listVariants`, `updateVariantPrices` (`productVariantsBulkUpdate`), `createAutomaticDiscount` / `deactivateAutomaticDiscount`, `setProductsStatus`, y `setVariantFulfillmentMetafields` (`ubc.availability`, `ubc.lead_time_days`, `ubc.click_and_collect_only`).
  - El metafield `ubc.click_and_collect_only` alimenta la *Shopify Plus Delivery Customization Function* para exigir recogida en tienda en bicicletas con restricción del fabricante (ej. Specialized).
  - Verificación criptográfica HMAC-SHA256 en tiempo constante sobre el cuerpo crudo para `POST /webhooks/shopify`.

## 2. Lightspeed Retail R-Series (POS, Stock Físico y Precios de Evento)
- **Listo en código (`packages/integrations/src/lightspeed-r/client.ts`):**
  - OAuth2 con refresh token automático, lectura paginada de `Item.json` (`@attributes.next`), exclusión de `shopID=0` (total global) y control adaptativo del *leaky bucket* (`X-LS-API-Bucket-Level`).
  - **Sincronización de precios POS solo para eventos especiales:** Las promociones regulares corren únicamente en web (`channel = 'online'`). Solo cuando se lanza un evento omnicanal autorizado (`channel = 'online_and_pos'`, con `posEventType` como `black_friday` o `christmas`) y `LIGHTSPEED_R_POS_EVENT_WRITES_ENABLED=true`, `updateEventPosPrices()` iguala y luego restaura los precios `Default` en Lightspeed respetando el *leaky bucket*.

## 3. Proveedores con Acceso Confirmado por UBC (Listos para Conectar)
UBC ya cuenta con relación y acceso de distribuidor para **QBP**, **JBI** y **Specialized**:
- **QBP (`liveQbp`):** Preparado para API B2B / SFTP / importador CSV (`packages/integrations/src/suppliers/csv.ts`), deduplicación por UPC/GTIN + MPN y revalidación previa a la compra.
- **JBI — J&B Importers (`liveJbi`):** Preparado para feed automatizado CSV/SFTP, normalización de costos en centavos y cola de curación `match_reviews`.
- **Specialized (`liveSpecialized`):** Preparado para feed de distribuidor autorizado, bloqueo duro de piso MAP (`map_policy`) y política `SPECIALIZED_BIKES_PICKUP_ONLY=true` (Click & Collect en tienda).

Todos los conectores LIVE permanecen en guardia segura (`NotConfiguredError` / `PendingVerificationError`) mientras no se carguen las llaves en `.env`, evitando llamadas accidentales.
