# PROJECT_STATUS — UBC Commerce Hub

Última actualización: 2026-11-11 · Modo: **DEMO** · Ninguna integración real conectada.

Leyenda: ✅ hecho y probado · 🟡 parcial · ⛔ bloqueado por acceso/autorización externa · ⬜ pendiente

| Fase | Estado | Detalle |
|---|---|---|
| 1. Investigación y configuración | ✅ | Monorepo, TS, PostgreSQL 16, Fastify 5, Vitest, Playwright, Theme Check. CLAUDE.md. Docs oficiales consultadas (ver docs/INTEGRATIONS.md). |
| 2. Aplicación DEMO completa | ✅ | Panel de 12 secciones; flujos reales sobre datos simulados; publicado en https://ubc-demo.twoitsolutions.com |
| 3. Backend y base de datos | ✅ | 2 migraciones, auth con sesiones + CSRF + roles, cola de trabajos con reintentos, auditoría, errores. |
| 4. Shopify | 🟡 / ⛔ | Tema OS 2.0 (0 errores Theme Check) + cliente Admin GraphQL + HMAC de webhooks probados con mocks. **Falta tienda de desarrollo y app** para prueba autenticada. |
| 5. Lightspeed R-Series | 🟡 / ⛔ | Cliente OAuth (refresh), paginación por cursor, rate limit, mapeo de Item: probados con respuestas simuladas. **Falta registro de app y autorización de UBC.** Escrituras deshabilitadas. |
| 6. Motor de promociones | ✅ | Selección combinada, %/importe/subida/precio fijo, redondeo, margen mínimo, MAP, excepciones MAP, programación, token de vista previa, aplicación por lotes, restauración segura, CSV, historial. |
| 7. Catálogos virtuales | 🟡 / ⛔ | Importación CSV de feeds + equivalencias GTIN/MPN + cola de revisión. Adaptadores demo para QBP/JBI/Specialized. **Conectores reales: Not Connected** (sin credenciales ni documentación oficial). |
| 8. Pedidos especiales | ✅ (demo) | Webhook idempotente → planificación stock/proveedor → revalidación → solicitud de compra → aprobación de Carlos → envío PO (job) → seguimiento → excepciones. |
| 9. Pruebas y publicación | ✅ | 52 tests unit/integración, 55 checks e2e (escritorio + iPhone 390px) en local **y en el sitio publicado**, 16 checks e2e en modo API. |
| 10. Documentación | ✅ | README, arquitectura, API, manual de Carlos, despliegue, respaldo, migración Workstand, accesos pendientes. |

## Pruebas (último resultado)
- `npm test`: 52/52 ✅ (reglas 23, integraciones 11, API+PostgreSQL 18)
- `npm run test:e2e`: 55/55 ✅ local; 55/55 ✅ contra https://ubc-demo.twoitsolutions.com
- `npm run test:e2e:api`: 16/16 ✅
- `npm run lint`: 0 errores · `npm run theme:check`: 39 archivos, 0 problemas

## Limitaciones conocidas
- La prueba "iPhone" usa Chromium con emulación de iPhone 13 (390px, táctil, UA de Safari). **No es WebKit real**:
  no estaba instalado en el entorno. Pendiente: verificación manual en un iPhone real.
- El backend (API + PostgreSQL) no está desplegado: el plan Hostinger Business ofrece Node.js pero solo MySQL.
  Ver opciones en docs/DEPLOYMENT.md.
- Notificaciones a Carlos: hoy aparecen en el dashboard y la auditoría; email/SMS pendiente.
- Dashboard calcula disponibilidad en memoria (bien hasta ~50k SKUs); a mayor escala, materializar.
