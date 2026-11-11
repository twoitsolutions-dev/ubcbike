# UBC Commerce Hub

Plataforma comercial de **TwoIT Solutions LLC** para **University Bicycle Center (UBC)**.
Responsable principal del panel: **Carlos Mirabal** (compras, proveedores, precios y promociones).

> Estado actual: **modo DEMO**. Todos los productos, precios, costos y pedidos son ficticios.
> Ninguna conexión real con Shopify, Lightspeed R-Series ni proveedores está activa.
> Ver [`PROJECT_STATUS.md`](PROJECT_STATUS.md) y [`docs/ACCESS_PENDING.md`](docs/ACCESS_PENDING.md).

## Demo publicada

- URL: https://ubc-demo.twoitsolutions.com (protegida con usuario/contraseña HTTP, `noindex`).
- Es el panel administrativo con el *driver demo*: corre en el navegador con datos simulados y usa el
  mismo motor de reglas que el backend.

## Componentes

| Componente | Carpeta | Tecnología |
|---|---|---|
| A. Tienda pública | `apps/shopify-theme` | Shopify Online Store 2.0, Liquid, CSS, JS ES5 |
| B. UBC Admin (panel de Carlos) | `apps/admin` | HTML, CSS, Vanilla JS (módulos ES2020) |
| C. Integration Engine (API) | `apps/api` | Node.js 22, TypeScript, Fastify, PostgreSQL |
| Reglas de negocio | `packages/business-rules` | TS puro (se usa en servidor y navegador) |
| Conectores | `packages/integrations` | Shopify Admin GraphQL, Lightspeed R-Series, QBP/JBI/Specialized |
| Base de datos | `packages/database` | Migraciones SQL versionadas, seed DEMO |
| Datos demo | `packages/demo-data` | Generador determinista de datos ficticios |

## Requisitos

- Node.js 22 LTS, npm 10
- PostgreSQL 14+ (probado con 16)
- `zip` (para la build estática)

## Inicio rápido (desarrollo)

```bash
npm install
cp .env.example .env            # ajustar DATABASE_URL
npm run build                   # compila TS y prepara apps/admin/js/vendor
npm run db:migrate
npm run db:seed                 # crea usuarios demo e imprime contraseñas generadas
npm run dev                     # API + panel en http://127.0.0.1:8787
```

## Pruebas

```bash
npm test                 # unitarias + integración API contra PostgreSQL (TEST_DATABASE_URL)
npm run lint             # control de sintaxis ES2020/ES5 para código de navegador
npm run theme:check      # Theme Check oficial de Shopify
npm run test:e2e         # navegador: demo estática, escritorio 1440px + iPhone 390px
npm run test:e2e:api     # navegador contra la API real
```

## Publicar la demo

Ver [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Documentación

- [Arquitectura](docs/ARCHITECTURE.md)
- [API](docs/API.md)
- [Integraciones y lo verificado](docs/INTEGRATIONS.md)
- [Manual de Carlos](docs/MANUAL_CARLOS.md)
- [Despliegue](docs/DEPLOYMENT.md) · [Respaldo](docs/BACKUP.md)
- [Migración Workstand → Shopify](docs/MIGRATION_WORKSTAND_SHOPIFY.md)
- [Accesos pendientes y funciones no autorizadas](docs/ACCESS_PENDING.md)
