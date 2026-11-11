# CLAUDE.md — guía para agentes que trabajen en este repositorio

## Reglas no negociables
- Frontend: HTML, CSS y Vanilla JS. **No** React/Next/Vue/Angular/Base44.
- El código de navegador debe pasar `npm run lint` (ES2020 en `apps/admin/js`, ES5 en `apps/shopify-theme/assets`).
  Motivo: la primera versión se veía en blanco en iPhone; no usar sintaxis nueva ni import maps.
- Todo acceso a `localStorage`/`sessionStorage` pasa por `safeStorage` (`apps/admin/js/ui/dom.js`) o try/catch.
- Dinero siempre en **centavos enteros**. Porcentajes como fracción (0.2 = 20 %).
- **Inventario físico y ofertas de proveedores nunca se suman.** Ver `packages/business-rules/src/availability.ts`.
- MAP es un piso contractual: nada lo salta salvo un `map_exception` registrado por owner/admin.
- Nunca emitir compras a proveedores sin aprobación humana registrada (`purchase_orders.approved_by`).
- No escribir en Lightspeed (writes deshabilitados) ni en Shopify sin `SHOPIFY_WRITES_ENABLED=true` autorizado.
- DEMO vs LIVE lo decide el servidor (`APP_MODE` + `LIVE_MODE_ACK`). El navegador nunca puede cambiarlo.
- No inventar endpoints de proveedores. Si no hay documentación oficial verificada, el conector lanza `PendingVerificationError`.
- Sin secretos en el repo ni en el frontend. Solo `.env` (ignorado) o el gestor de secretos del hosting.
- Todo dato de negocio lleva `company_id`; toda consulta de la API filtra por la empresa de la sesión.

## Mapa
- `packages/business-rules` — precios/MAP/margen, disponibilidad, equivalencias, máquina de estados de pedidos. Puro, testeado.
- `packages/integrations` — clientes Shopify/Lightspeed R, conectores de proveedor, HMAC de webhooks, parser CSV.
- `packages/database` — migraciones (`migrations/*.sql`), runner, seed DEMO, hashing scrypt.
- `apps/api` — Fastify: rutas (`routes/`), servicios (`services/`), cola de trabajos Postgres (`services/jobs.ts`, `workers/`).
- `apps/admin` — SPA con router por hash; drivers `http` (API) y `demo` (navegador). `js/vendor` se genera con `npm run build`.
- `apps/shopify-theme` — tema OS 2.0. Disponibilidad vía metafields `ubc.availability` / `ubc.lead_time_days`.

## Flujo de trabajo
1. `npm run build && npm test && npm run lint && npm run theme:check`
2. Cambios de UI: `npm run test:e2e` (escritorio + iPhone 390px).
3. Actualizar `PROJECT_STATUS.md` al terminar una fase.
4. Nuevas tablas: nueva migración numerada; nunca editar una ya aplicada.
