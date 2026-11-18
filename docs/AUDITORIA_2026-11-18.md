# Auditoría completa — UBC Commerce Hub + tienda Shopify

Fecha: 18-nov-2026 · Alcance: servidor del Hub (Hostinger), base de datos (Supabase), conexión con Lightspeed, tienda de Carlos (ubcbike.myshopify.com), tema "UBC Dawn V34", panel del Hub y código.

Método: pruebas reales contra el sistema en vivo, sin modificar nada:
- **Seguridad:** login, API sin sesión, webhooks, cabeceras, tamaño de los envíos, inyección de código en las páginas de OAuth.
- **Base de datos:** consultas de consistencia.
- **Tienda:** lectura completa de los 36,723 productos y 205,860 variantes.
- **Tema:** errores de consola en portada, colección y producto, y revisión de los dos idiomas.
- **Panel del Hub:** tiempos de carga de cada pantalla.
- **Código:** dependencias, git y tamaño del proyecto.

---

## Lo que está bien ✅
- **API protegida:** todas las rutas piden sesión (401 sin login). Los webhooks sin firma o con firma falsa se rechazan (401). Los envíos de más de 2 MB se rechazan (413).
- **Cabeceras de seguridad** (CSP, X-Frame-Options, nosniff, noindex). Las páginas de OAuth no reflejan código inyectado.
- **Servidor estable:** 294 trabajos correctos en 24 h, ninguno trabado, 0 errores abiertos.
- **Lightspeed:** el token se renueva bien con el candado y la sincronización corre cada 5 min.
- **Datos consistentes:**
  - 7,697 variantes emparejadas, todas con su inventario.
  - Ninguna por debajo del MAP.
  - Ninguna con precio 0.
  - El precio que tiene Shopify coincide con el de Lightspeed en todas.
- **Tema:** 0 errores de JavaScript en portada, colección y producto; la portada carga en ~2 s; inglés por defecto y español completo.
- **Panel:** UPC Matches carga en menos de 1 s con 1,000 filas.

---

## 🔴 Corregir ya

| # | Problema | Evidencia | Arreglo propuesto |
|---|---|---|---|
| 1 | **Las etiquetas de stock por tienda no se actualizan** (`ubc-tampa-stock`, `ubc-alafia-stock`). De ellas dependen el filtro "Shop Location", la colección In-Stock y la etiqueta de disponibilidad de la tarjeta. | 196 productos con stock en Tampa y 35 en Alafia **no tienen la etiqueta**, así que no aparecen en esos filtros y dicen "At Warehouse · Available to Order" (caso Jupiter). Las etiquetas de precio (`price-*`) y de marca (`brand-*`) están igual de desactualizadas. | Que el Hub **mantenga esas etiquetas** en cada sincronización, según el stock y el precio de Lightspeed. Corrige a la vez el filtro, la colección y la etiqueta "At Warehouse". |
| 2 | **Se puede probar contraseñas sin límite** en el login. | Tras 5 intentos responde 429, pero cambiando la cabecera `X-Forwarded-For` vuelve a responder 401 (sigue dejando probar). | Limitar los intentos **por correo** (no solo por IP), guardar el contador en la base de datos (hay 2 procesos) y no confiar en la IP que manda el cliente. |
| 3 | **Claves expuestas en esta conversación** (contraseña de Supabase, token `shpat_`, secret `shpss_`). | — | Regenerarlas y volver a subirlas al servidor. |
| 4 | **Cuentas de demostración con rol de dueño en el sistema real.** | `admin@twoit.sandbox` (owner), `carlos@twoit.sandbox`, `ubcbike@ubc.com` y `ubcbike` (sin formato de correo), todas activas. | Desactivar las de demostración y dejar una cuenta real por persona (Carlos, tú), con el rol adecuado. |

## 🟠 Importante

| # | Problema | Evidencia | Arreglo propuesto |
|---|---|---|---|
| 5 | **Workstand sigue pisando precios.** | 121 precios en la última media hora; unos 1,750 en 24 h. El Hub los corrige cada 30 min. | Que Carlos hable con Workstand (la solución de fondo). Mientras tanto se puede bajar la revisión a cada 10–15 min. |
| 6 | **1,283 coincidencias esperando aprobación.** Esas variantes no reciben precio ni stock de Lightspeed. | UPC Matches → To review. | Botón **"Approve all"**, que apruebe todas las de un tipo, no solo las 1,000 visibles. Ordenarlas por stock (ya lo están). |
| 7 | **El 97.6 % de los productos de la tienda están agotados y no se pueden comprar**, pero están activos y salen en la búsqueda. | 35,853 de 36,723 productos activos con inventario 0 y sin pedido especial. | Decidir con Carlos y Workstand: ocultarlos de la búsqueda, o permitir el **pedido especial** (vender sin stock) en el catálogo de proveedores. |
| 8 | **Productos duplicados en la tienda.** | 657 UPC repetidos en más de una variante; unos 2,700 grupos de productos activos con el mismo nombre y marca (ej. "Roll 3.0 Low Entry" ×4). | Lo arregla Workstand. Puedo sacar la lista para mandársela. |
| 9 | **El Dashboard del Hub es lento.** | `/api/dashboard` tarda 3.5–5.7 s y se pide **dos veces** al abrir (pantalla y contador del menú). | Hacer que el resumen no recorra los 25 mil artículos, guardarlo unos segundos y pedirlo una sola vez. |
| 10 | **Dependencias con vulnerabilidades conocidas.** | `npm audit`: 4 (2 altas: `zod` y `minimatch` / `@fastify/static`). | Actualizarlas y probar (algunas son cambios de versión mayor). |
| 11 | **Nada está subido a GitHub.** | 10 commits solo en esta PC. | Hacer `git push` a la rama. |

## 🟡 Mejoras

| # | Mejora | Detalle |
|---|---|---|
| 12 | SEO de producto | La página de producto no tiene meta description; 5 de 14 imágenes sin texto alternativo; 10,157 productos activos sin foto (los sube Workstand). |
| 13 | Precio tachado "falso" | 174,435 variantes tienen el precio de comparación igual al precio. No se ve, pero ensucia los datos (viene de Workstand). |
| 14 | Pedidos reales | Todavía no ha entrado ninguno. Revisar el primero cuando llegue. |
| 15 | Promociones | Falta una prueba en vivo con 1–2 artículos. |
| 16 | Aviso de "producto creado" | Haría que los productos hechos a mano se emparejen en ~10 min en vez de hasta 1 hora (el código está listo, sin registrar). |
| 17 | Filtros en celular | Abrir la columna de filtros desde un botón "Filtros" para ganar espacio. |
| 18 | Limpieza de sesiones | 37 sesiones guardadas, 3 activas; borrar las vencidas automáticamente. |

## 🗑️ Eliminar

| # | Qué | Por qué |
|---|---|---|
| 19 | **5,091 artículos del Hub que no vienen de Lightspeed** (pruebas con la tienda de prueba y catálogos demo) | Ensucian Item Search y los conteos. |
| 20 | **Scripts de una sola vez que escriben en la tienda real** (`sync-all-prices-carlos`, `master-reconcile-carlos-shopify`, `tag-carlos-*`, `publish-carlos-instock`, `align-hub-exact-1to1`, `reclassify-all-categories`, `deploy-draft-theme-carlos`…) | Ya hicieron su trabajo, se pueden correr por error y ninguno tiene modo de prueba. Moverlos a un archivo o borrarlos. |
| 21 | **Carpeta vieja `ubcbike/ubcbike`** (176 MB, con su propio git) | Copia antigua que confunde. |
| 22 | **`build/` con 89 zips de temas viejos** (891 MB) | Versiones v10–v34 que ya no se usan. |
| 23 | **Temas y código viejos:** `apps/dawn-ubc-theme`, `apps/shopify-theme`, `src/`, `dawn-integration/` | El tema real es `apps/dawn-ubc-fable-theme`. |
| 24 | **Documentación desactualizada:** `README.md` dice "modo DEMO, sin conexiones reales"; `PROJECT_STATUS.md` habla de la tienda de prueba | Actualizar para que coincidan con la realidad (la guía correcta es `docs/GUIA_FUNCIONES_HUB.md`). |
| 25 | **Nombre de la empresa "University Bicycle Center (Sandbox)"** y slug `twoit-sandbox` en producción | Cambiar el nombre visible a "University Bicycle Center". |
