# Despliegue

## Demo estática en Hostinger (estado actual)

| Dato | Valor |
|---|---|
| URL | https://ubc-demo.twoitsolutions.com |
| Sitio Hostinger | sitio independiente `ubc-demo.twoitsolutions.com` en el plan Business (orden 1010126240), usuario `u673103289` |
| Carpeta pública | `/home/u673103289/domains/ubc-demo.twoitsolutions.com/public_html` (no está dentro del sitio principal) |
| Credenciales de acceso | `/home/u673103289/domains/ubc-demo.twoitsolutions.com/.htpasswd` (fuera de `public_html`), usuario `ubcdemo` |
| SSL | Let's Encrypt gestionado por Hostinger, redirección HTTPS activada por Hostinger, CDN de Hostinger activa |
| DNS | Hostinger agregó `ubc-demo` (ALIAS a CDN), `www.ubc-demo` (CNAME), `ftp.ubc-demo` (A). Ningún registro existente cambió. |

### Publicar una nueva versión
```bash
npm run build && npm test && npm run lint
npm run build:static-demo          # genera build/static-demo y build/ubc-demo-static.zip
npm run test:e2e                   # navegador local, escritorio + iPhone
```
Subir y desplegar con Hostinger (MCP "Hostinger Connector" o hPanel):
1. `hosting_files_generate-upload-url` (usuario `u673103289`, dominio `ubc-demo.twoitsolutions.com`).
2. Subir `build/ubc-demo-static.zip` por TUS a `public_html/ubc-demo-static.zip` (ver ejemplo `curl` en la descripción de la operación).
   Las credenciales TUS caducan: si da 403, generar otra URL.
3. `hosting_websites_deploy-static-site-archive` con `archive_path: ubc-demo-static.zip` (reemplaza el contenido de ese sitio solamente).
4. Verificar: `E2E_URL="https://ubcdemo:<contraseña>@ubc-demo.twoitsolutions.com/" node tests/e2e/run.mjs`
   y que sin contraseña `/` y `/js/main.js` respondan 401.

Alternativa sin Hostinger Connector: hPanel → Archivos → Administrador de archivos → subir el ZIP en
`public_html` del sitio `ubc-demo` y extraerlo (los archivos deben quedar en la raíz, no dentro de una carpeta).

### Cambiar la contraseña de la demo
```bash
openssl passwd -apr1 'NUEVA-CONTRASEÑA'      # copiar el hash
# contenido del archivo: ubcdemo:<hash>
```
Subirlo como `../.htpasswd` con la URL TUS (queda fuera de `public_html`).

## Backend (API + PostgreSQL) — pendiente de decisión
El plan Hostinger Business admite apps Node.js, pero su base de datos es **MySQL**, no PostgreSQL. Opciones:

| Opción | Costo | Comentario |
|---|---|---|
| A. Hostinger VPS (Node + PostgreSQL) | compra adicional | Control total; requiere administración del servidor. |
| B. Node.js en Hostinger Business + PostgreSQL gestionado externo (Neon/Supabase, plan gratuito para DEMO) | 0 en demo | Mínimo cambio; dos proveedores; latencia entre ambos. |
| C. Portar a MySQL para usar el plan actual | 0 | Reescribe migraciones y consultas (JSONB, `SKIP LOCKED` existen en MySQL 8, pero hay que adaptarlas). No recomendado ahora. |

Recomendación: **B para la etapa DEMO/piloto**, A cuando haya integraciones LIVE. Requiere tu autorización (cuentas nuevas).

Ejecución en cualquier servidor:
```bash
npm ci && npm run build
APP_MODE=demo DATABASE_URL=... COOKIE_SECURE=true npm run db:migrate
npm run db:seed            # solo DEMO
RUN_WORKER=true npm run dev   # o RUN_WORKER=false + `npm run worker` en otro proceso
```
Poner detrás de HTTPS. El panel se sirve desde la misma API (`ADMIN_DIR`, por defecto `apps/admin`).

## Tema Shopify
```bash
shopify theme dev --path apps/shopify-theme --store <tienda-dev>.myshopify.com
shopify theme push --unpublished --path apps/shopify-theme
```
Nunca publicar sobre el tema activo de una tienda real sin autorización.
