# Arquitectura

```
 Clientes ──► Shopify (tema UBC + Checkout de Shopify)          ← pagos SOLO en Shopify
                 │  webhooks orders/create (HMAC)   ▲ Admin GraphQL (precios, descuentos, estado)
                 ▼                                   │
           ┌──────────── UBC Integration Engine (apps/api) ────────────┐
           │ Fastify REST · auth/roles · cola de trabajos (Postgres)    │
           │ reglas (packages/business-rules) · conectores              │
           └───────┬───────────────┬───────────────┬───────────────────┘
                   │ PostgreSQL     │ Lightspeed     │ QBP / JBI / Specialized
                   │ (por empresa)  │ R-Series (RO)  │ (feeds / APIs autorizadas)
                   ▼
           UBC Admin (apps/admin) — panel de Carlos, Vanilla JS, mismo origen que la API
```

## Decisiones clave

| Decisión | Motivo |
|---|---|
| Reglas de negocio en un paquete TS puro, compilado a ES2020 | La misma lógica corre en la API y en la demo estática del navegador; se prueba una sola vez. |
| Dinero en centavos enteros | Evita errores de coma flotante en miles de recálculos. |
| Disponibilidad = físico vs. ofertas, nunca sumados | Requisito: no prometer stock que UBC no posee. En Shopify se publica solo stock físico; las ofertas frescas habilitan "seguir vendiendo" + metafield `ubc.availability=special_order`. |
| MAP como bloqueo duro | Restricción contractual. Solo se levanta con `map_exceptions` (aprobador del proveedor + referencia + vigencia), registrada por owner/admin. Carlos (rol `purchasing`) no puede registrarlas solo. |
| Token de vista previa al aprobar campañas | Si cambian precios/costos/MAP entre la vista previa y la aprobación, la API responde 409 `PREVIEW_STALE`. |
| Aplicación con guardas optimistas | `UPDATE … WHERE price_cents = <precio evaluado>`: un cambio concurrente no se pisa. |
| Restauración segura | Solo se restaura si el precio actual sigue siendo el que puso la campaña; si alguien lo cambió después, `skipped_changed`. |
| Descuento nativo de Shopify cuando alcanza | Campaña solo online + % o importe uniforme sin recortes por margen → `discountAutomaticBasicCreate`; no se reescriben precios. Si no, `productVariantsBulkUpdate` con precio anterior guardado. |
| Cola de trabajos en PostgreSQL (`FOR UPDATE SKIP LOCKED`) | Persistente, sin servicio extra; reintentos exponenciales, `dead` + `error_log` al agotar intentos. |
| Idempotencia | `sync_events(company, source, idempotency_key)` para webhooks; `orders(store, shopify_order_id)`; `purchase_orders.idempotency_key` también enviado al proveedor; claves en jobs. |
| Multiempresa preparado | `company_id` en todas las tablas; tiendas, ubicaciones, proveedores y reglas por empresa; sesión ligada a una empresa. |
| DEMO/LIVE en el servidor | `APP_MODE=live` exige `LIVE_MODE_ACK` exacto y secretos; el navegador solo muestra el modo. |
| Sin frameworks de frontend | Requisito del cliente; SPA con router por hash (funciona en hosting estático sin reescrituras). |

## Modelo de datos (resumen)
`companies` → `stores` → `locations(physical)`; `users` + `memberships(role)` + `sessions`;
`products` → `variants` (+ `external_ids` por sistema) ; `inventory_levels(variant, location)`;
`suppliers` → `supplier_offers(variant?)` + `match_reviews`; `company_settings`, `map_exceptions`;
`campaigns` → `campaign_lines`, `price_history`; `orders` → `order_lines`, `order_events`;
`purchase_orders` → `purchase_order_lines`; `sync_events`, `jobs`, `integration_connections`, `error_log`, `audit_log`.
Vista `catalog_items`: artículo + stock físico agregado + ofertas (JSON).

## Seguridad
- Contraseñas scrypt (N=16384), sesiones con token aleatorio (solo se guarda su SHA-256), cookie `httpOnly; SameSite=Strict; Secure` en producción.
- CSRF por cabecera `X-CSRF-Token` en toda escritura. Bloqueo de login por IP+email (5 intentos / 15 min, en memoria).
- Permisos por rol (`packages/shared` → `ROLE_PERMISSIONS`), verificados en cada ruta.
- Validación estricta con zod; SQL siempre parametrizado.
- Webhooks: HMAC-SHA256 sobre el cuerpo crudo, comparación en tiempo constante.
- Cabeceras: CSP `self`, `X-Frame-Options: DENY`, `nosniff`, `X-Robots-Tag: noindex`.
- Ningún token de Shopify/Lightspeed/proveedor llega al navegador. No se guardan datos de tarjeta.
