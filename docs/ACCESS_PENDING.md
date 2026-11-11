# Accesos pendientes y funciones no autorizadas

## Accesos que hacen falta (quién los da)
| # | Acceso | Para qué | Quién |
|---|---|---|---|
| 1 | Tienda de desarrollo Shopify (Partner) + app personalizada con alcances mínimos | Probar el tema y el conector Admin GraphQL | TwoIT (cuenta Partner) |
| 2 | Acceso de colaborador a la tienda Shopify real de UBC (cuando exista) | Instalar la app y el tema sin publicar | UBC |
| 3 | Registro de app Lightspeed R-Series + autorización OAuth de UBC + ID de cuenta | Lectura de artículos, precios y stock | Lightspeed / UBC |
| 4 | API key y documentación QBP para la cuenta de UBC; términos de contenido | Catálogo, disponibilidad, costos, POs | QBP / UBC |
| 5 | Método de datos J&B (feed/portal/API) y licencia | Catálogo y disponibilidad | J&B / UBC |
| 6 | Programa de datos Specialized para distribuidores; reglas de venta online | Catálogo, MAP, imágenes | Specialized / UBC |
| 7 | Google Search Console y exportación de Workstand | Plan de migración SEO | UBC |
| 8 | Hosting del backend (ver docs/DEPLOYMENT.md, opción B o A) | Publicar API + PostgreSQL | TwoIT (decisión de compra) |
| 9 | Fotos y textos autorizados de UBC; dirección y horarios confirmados | Tienda real | UBC |

## Funciones construidas pero deshabilitadas hasta autorización
- Escrituras en Shopify (`SHOPIFY_WRITES_ENABLED=false`).
- Cualquier escritura en Lightspeed (precios POS incluidos): bloqueado por código (`WritesDisabledError`).
- Envío real de órdenes de compra a proveedores (conectores LIVE responden *Not Connected* / *Pending verification*).
- Modo LIVE (`APP_MODE=live` exige `LIVE_MODE_ACK`).
- Desactivar `demo_mode` del tema (noindex + aviso demo).

## Pendientes técnicos
- Verificación en iPhone real (las pruebas usaron emulación de iPhone sobre Chromium).
- Notificaciones por email/SMS a Carlos.
- Gestión de usuarios desde el panel (hoy por seed/SQL).
- Límite de intentos de login compartido si hay más de una instancia (hoy en memoria).
- Conciliación periódica Lightspeed ↔ catálogo (cliente listo; falta el job de conciliación contra datos reales).
- Materializar la vista de catálogo si el catálogo supera ~50k variantes.
