# Accesos pendientes y funciones listas para conectar

## Decisiones confirmadas con UBC (2026-11-11)
- **Plan de Shopify:** **Shopify Plus** confirmado (`SHOPIFY_PLAN=plus`), habilitando cuotas GraphQL Plus (1,000 pts/s), Bulk Mutations y *Shopify Delivery Customization Functions* (Click & Collect obligatorio en bicicletas restringidas como Specialized).
- **Proveedores autorizados:** UBC **ya cuenta con acceso de distribuidor** al menos para **Specialized, JBI (J&B Importers) y QBP**. Los conectores quedan listos para conectar en cuanto se vuelquen las credenciales/feeds en `.env`.
- **Paridad de precios POS ↔ Web:** Las campañas cotidianas corren **solo online** (`channel = 'online'`). La igualación de precios con la caja de Lightspeed R-Series (`channel = 'online_and_pos'`, con `posEventType`) se reserva **únicamente para eventos especiales** como **Black Friday, Navidad (`christmas`) o Liquidación Anual**.

## Credenciales a cargar en `.env` al pasar a conexión real
| # | Integración | Variables listas en `.env.example` | Estado |
|---|---|---|---|
| 1 | **Shopify Plus** | `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_ADMIN_ACCESS_TOKEN`, `SHOPIFY_WEBHOOK_SECRET`, `SHOPIFY_PHYSICAL_LOCATION_ID` | Listo para conectar |
| 2 | **Lightspeed R-Series** | `LIGHTSPEED_R_CLIENT_ID`, `LIGHTSPEED_R_CLIENT_SECRET`, `LIGHTSPEED_R_REFRESH_TOKEN`, `LIGHTSPEED_R_ACCOUNT_ID` | Listo para conectar (incluye lectura de `/Item.json` y `/SpecialOrder.json`) |

## Verificaciones operativas al conectar la cuenta real de Lightspeed R-Series de UBC
- **Lectura del apartado `Special Orders` (`/API/V3/Account/{id}/SpecialOrder.json`):** Confirmar que el token OAuth de UBC incluya permiso de lectura sobre `SpecialOrder` para detectar automaticamente los cambios de estado `Not Ordered` -> `Ordered` -> `Ready` cuando recepcion escanee los POs, manteniendo asignacion estricta 1-a-1 por `#Orden Shopify` (FIFO).
- **Alta inicial del Special Order en Lightspeed:** Confirmar con UBC si ya usan la integracion nativa de ventas *Shopify -> Lightspeed R-Series* (en cuyo caso el Hub solo lee `SpecialOrder` sin escribir en el POS) o si prefieren habilitar creacion asistida de borradores para que Carlos no digite el *Special Order* manualmente en Lightspeed.
| 3 | **QBP** (acceso UBC confirmado) | `QBP_ACCOUNT_NUMBER`, `QBP_API_KEY`, `QBP_API_BASE_URL` | Listo para conectar |
| 4 | **JBI** (acceso UBC confirmado) | `JBI_ACCOUNT_NUMBER`, `JBI_FEED_URL`, `JBI_FEED_CREDENTIAL` | Listo para conectar |
| 5 | **Specialized** (acceso UBC confirmado) | `SPECIALIZED_DEALER_ID`, `SPECIALIZED_API_CREDENTIAL`, `SPECIALIZED_BIKES_PICKUP_ONLY=true` | Listo para conectar |
| 6 | **Workstand + Search Console** | Exportación de catálogo/URLs actuales para mapa de redirecciones `301` | Pendiente al migrar |

## Compuertas de seguridad activas por defecto
- `APP_MODE=demo` (pasar a `live` exige `LIVE_MODE_ACK=I_UNDERSTAND_THIS_CONNECTS_REAL_SYSTEMS`).
- Escrituras en Shopify Plus deshabilitadas hasta activar `SHOPIFY_WRITES_ENABLED=true`.
- Escrituras de precios en Lightspeed POS deshabilitadas por defecto (`LIGHTSPEED_R_POS_EVENT_WRITES_ENABLED=false`) y acotadas exclusivamente a campañas `online_and_pos` de eventos especiales (Black Friday, Navidad, etc.).
- Órdenes de compra a proveedores siempre requieren aprobación humana registrada (`purchase_orders.approved_by`).
