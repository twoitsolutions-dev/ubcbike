# Integraciones: qué está hecho, qué está verificado y qué falta

**Ninguna integración real está conectada.** "Probado" abajo significa probado con respuestas simuladas, no contra el servicio real.

## Shopify (Admin GraphQL)
- Hecho: cliente con versión fijada (`SHOPIFY_API_VERSION`, por defecto `2026-10`), reintentos ante `THROTTLED`/429/5xx,
  interruptor global de escritura, operaciones `productVariants` (lectura), `productVariantsBulkUpdate`,
  `discountAutomaticBasicCreate`/`discountAutomaticDeactivate`, `productUpdate(status)`. Verificación HMAC de webhooks.
- Verificado con fuentes oficiales: política de versiones trimestrales (shopify.dev/docs/api/usage/versioning). Las notas
  consultadas no confirmaban si 2026-10 ya estaba marcada estable: **confirmar antes de LIVE**.
- Falta: tienda de desarrollo, app personalizada con alcances mínimos (`read_products`, `write_products` solo cuando se
  autorice, `read_inventory`, `read_orders`, `write_discounts` solo cuando se autorice), secreto de webhooks, y
  validar las operaciones contra el esquema con Shopify CLI / AI Toolkit. Tema: `shopify theme dev` contra la tienda dev.

## Lightspeed Retail R-Series (no X-Series)
- Hecho: OAuth con refresh token, `GET /Account.json`, iteración de `Item.json` con `load_relations=["ItemShops"]` y
  cursor `@attributes.next`, control del *leaky bucket* (`X-LS-API-Bucket-Level`), mapeo de precio Default, costo y
  existencias por tienda (excluye la fila `shopID=0`). Escrituras: deshabilitadas por código.
- Fuentes: las URLs de token publicadas por terceros no coinciden (`/auth/oauth/token` vs `/oauth/access_token.php`).
  Por eso son configurables. **Confirmar en la documentación oficial al registrar la app.**
- Falta: registro de la app en Lightspeed, autorización de UBC (refresh token), ID de cuenta, mapear `shopID` de la
  tienda física, y una conciliación de prueba en solo lectura.

## QBP
- Hecho: conector LIVE que reporta *Not Connected* y se niega a llamar a endpoints no verificados; importación de feeds CSV
  con mapeo de columnas, validación por fila, equivalencias GTIN/MPN y cola de revisión; adaptador DEMO.
- Investigado: la documentación de la API de QBP no es pública. Integradores (Flxpoint, Ascend) indican una API key
  emitida por QBP al distribuidor + código de almacén, y feeds diarios; Lightspeed tiene integración QBP propia para
  stock en tiempo real. **No se inventaron endpoints.**
- Falta: solicitar a QBP la API key y la documentación para la cuenta de UBC; confirmar términos de uso de imágenes y
  descripciones; decidir si las órdenes de compra se envían por API de QBP o por la integración de Lightspeed.

## JBI (J&B Importers)
- Igual que QBP: conector *Not Connected*, importación CSV operativa, adaptador DEMO.
- Falta: confirmar con J&B el método de acceso de datos para distribuidores (feed/portal/API), formato y licencia de contenido.

## Specialized
- Conector *Not Connected* + adaptador DEMO.
- Falta: programa de datos para distribuidores autorizados, reglas de venta online de bicicletas/e-bikes, MAP e imágenes.

## Nuevo proveedor
Implementar `SupplierConnector` (`packages/integrations/src/types.ts`) o reutilizar `mapFeed` con un mapeo de columnas,
registrarlo en `apps/api/src/services/connectors.ts` y crear la fila en `suppliers`. Sin cambios en el resto de la app.
