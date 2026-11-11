# API del Integration Engine

Base: mismo origen que el panel. JSON. Autenticación por cookie de sesión; toda escritura requiere `X-CSRF-Token`
(lo devuelve `POST /api/auth/login` y `GET /api/auth/me`). Errores: `{ "error": CODE, "message", "details"? }`.

| Método y ruta | Permiso | Descripción |
|---|---|---|
| `GET /api/health`, `GET /api/system` | — | Salud; modo (`demo`/`live`) y aviso demo |
| `POST /api/auth/login` | — | `{email,password}` → cookie + `csrfToken` (429 tras 5 fallos) |
| `GET /api/auth/me`, `POST /api/auth/logout` | sesión | Usuario, rol, permisos |
| `GET /api/dashboard` | catalog.read | Contadores físico/virtual/sin disponibilidad, pedidos, errores, jobs |
| `GET /api/items` | catalog.read | Filtros: `q, categories, brands, suppliers, priceMinCents, priceMaxCents, marginMinPct, marginMaxPct, stock(physical|virtual_only|unavailable), status`; `limit≤200, offset, sort, dir` |
| `GET /api/items/facets` | catalog.read | Categorías, marcas, proveedores |
| `GET /api/items/:id` | catalog.read | Artículo, disponibilidad calculada, historial de precios, IDs externos |
| `PATCH /api/items/:id/price` | pricing.write | `{priceCents, version}` · 409 `VERSION_CONFLICT` · 422 `RULE_VIOLATION` (MAP/margen) |
| `POST /api/items/bulk-status` | catalog.write | `{filter, status}` → 202 `{jobId}` |
| `GET /api/inventory/locations` | catalog.read | Stock físico por ubicación |
| `GET/POST /api/campaigns` | read / pricing.write | Crear = evaluar y guardar vista previa (`previewToken`) |
| `GET /api/campaigns/:id`, `/lines?status&offset&limit`, `/export.csv` | catalog.read | Detalle, líneas, CSV |
| `POST /api/campaigns/:id/preview` | pricing.write | Re-evaluar con datos actuales |
| `POST /api/campaigns/:id/approve` | campaign.approve | `{previewToken}` · 409 `PREVIEW_STALE` · programa o aplica (job) |
| `POST /api/campaigns/:id/restore`, `/cancel` | pricing.write | Restauración segura (job) / cancelar borrador |
| `POST /api/map-exceptions` | map.exception | `{itemId, approvedBy, reference, validUntil, note}` |
| `GET /api/orders?status&special&q`, `GET /api/orders/:id` | orders.read | Pedidos, líneas, eventos, órdenes de compra |
| `POST /api/orders/:id/transition` | orders.write (+ purchasing.approve para aprobar/enviar PO) | `{to, note?, reason?, tracking?}`; `po_submitted` → 202 con jobs |
| `GET /api/purchase-orders` | orders.read | Órdenes de compra |
| `POST /api/demo/checkout` | orders.write, solo DEMO | Simula `orders/create` firmado y lo pasa por el webhook real |
| `GET /api/suppliers`, `/:code/offers?unmatched` | catalog.read | Proveedores con salud del conector, ofertas |
| `POST /api/suppliers/:code/import` | catalog.write | `{csv, mapping, contentLicensed}` → job |
| `GET /api/match-reviews`, `POST /api/match-reviews/:id/resolve` | read / catalog.write | Cola de equivalencias dudosas |
| `GET /api/integrations` | catalog.read | Estado real de cada conector + llamadas simuladas |
| `GET /api/jobs`, `/:id`, `POST /api/jobs/:id/retry` | read / integrations.manage | Cola de trabajos |
| `GET /api/errors`, `POST /api/errors/:id/resolve`, `GET /api/audit` | audit.read | Errores y auditoría |
| `GET/PUT /api/settings` | read / settings.manage | Reglas de margen y disponibilidad |
| `POST /webhooks/shopify` | HMAC | `orders/create` (otros temas se registran como `ignored`) |

Roles: `owner`, `admin` (todo), `purchasing` (Carlos: catálogo, precios, campañas, pedidos, aprobar compras, auditoría;
**no** excepciones MAP ni ajustes globales), `staff` (leer catálogo, gestionar pedidos sin aprobar compras), `viewer`.
