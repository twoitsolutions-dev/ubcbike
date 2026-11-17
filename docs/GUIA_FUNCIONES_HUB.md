# UBC Commerce Hub — Qué hace cada sección

Hub: https://ubc-hub.twoitsolutions.com · Tienda: https://ubcbike.myshopify.com
Actualizado: 17-nov-2026

## Cómo está conectado hoy

```
Lightspeed (inventario real de Carlos)  ──►  Hub  ──►  Shopify (tienda de Carlos)
   precio Default, SALE PRICE,               ▲         el catálogo (fotos, descripciones,
   stock de Tampa y de Alafia                │         productos y variantes) lo sube
                                             │         la app Workstand
                     se empareja por UPC ────┘
```

- **La fuente de verdad es Lightspeed** para el precio, la oferta y el stock de lo que Carlos tiene.
- **Workstand es dueño del catálogo en Shopify:** crea los productos, las fotos y las variantes. El Hub **no crea ni borra productos** en la tienda de Carlos. Esto es el modo "solo actualizar" (`update_only`).
- El Hub une un artículo de Lightspeed con una variante de Shopify **por UPC**, solo después de que Carlos lo aprueba en **UPC Matches**.

### Procesos automáticos

| Proceso | Cada cuánto | Qué hace |
|---|---|---|
| Leer Lightspeed | 5 min | Trae solo lo que cambió (precio, oferta, stock por tienda) y lo manda a Shopify en segundos |
| Revisar Shopify | 30 min | Si Workstand (u otro) cambió un precio o stock de un artículo de Lightspeed, lo vuelve a poner |
| Buscar coincidencias de UPC | 1 hora | **Solo propone.** Las propuestas quedan en UPC Matches para que Carlos las apruebe |
| Promociones programadas | 30 s | Inician o terminan las promociones según su fecha |

### Cuánto tarda en verse en Shopify

| Acción | Tiempo (medido el 17-nov) |
|---|---|
| Cambio en Lightspeed (precio, SALE PRICE, stock) | hasta 5 min |
| Cambiar un precio en el Hub | ~2 segundos |
| Publicar u ocultar en el Hub | ~2 segundos |
| Aprobar una coincidencia en UPC Matches | segundos |
| Aplicar o terminar una promoción | segundos o minutos, según cuántos artículos tenga |

> Los cambios de precio **permanentes** hazlos en **Lightspeed**. Un precio cambiado en el Hub se reemplaza por el de Lightspeed la próxima vez que ese artículo cambie allá (por ejemplo, cuando se vende uno). Las promociones del Hub **no** se pierden: mientras están activas, Lightspeed no las pisa.

Estado de cada sección: ✅ funciona · ⚠️ funciona con límites · ⛔ no aplica hoy

---

## Overview

### Dashboard ✅
- **Lightspeed ↔ Shopify (matched by UPC):** qué parte del inventario de Carlos ya se vende online.
  - % de artículos con stock que ya están en Shopify.
  - Cuántos artículos de Lightspeed ya coinciden con lo que subió Workstand.
  - Cuántas variantes tiene la tienda.
  - En stock con UPC pero **no** en Shopify (Workstand no los ha subido, o el UPC es distinto).
  - En stock **sin UPC** en Lightspeed (no se pueden sincronizar hasta que se les ponga UPC).
  - Unidades en stock que ya están online.
  - Precios y stock que Workstand pisó y el Hub corrigió en las últimas 24 h. Debería bajar a 0 cuando Carlos lo arregle con Workstand.
  - Hora de la última lectura de Lightspeed, de la última revisión y de la última búsqueda de UPC.
- **Needs your attention:** propuestas de UPC por aprobar, pedidos especiales pendientes, errores de sincronización y trabajos fallidos.
- **Online store:** abre la tienda real.
- **Indicadores:** en stock, solo en catálogo de proveedor, agotados, pedidos y promociones activas.

## Inventory

### Item Search ✅
Buscador de artículos. **Por defecto muestra solo los que tienen stock.** Pestañas:
- **In Stock** (por defecto)
- **All Items**: todo
- **Out of Stock**: agotados
- **Vendor Catalog Only**: no hay en tienda, pero el proveedor los tiene
- **Stock by Store**: stock de Tampa y de Alafia por separado
- **Margins & MAP**: ordenado por menor margen

Acciones:
- **Price:** cambia el precio de un artículo. Llega a Shopify en ~2 s si el artículo está emparejado por UPC. No deja poner un precio que rompa el MAP o el margen mínimo.
- **Publish / Hide** (con varios seleccionados): publica u oculta el producto en Shopify (~2 s). Ojo: en Shopify un producto agrupa varias tallas o colores, así que se publica u oculta **el producto entero**.
- **Create promotion…:** crea una promoción con los artículos seleccionados.

### Special Orders ⚠️
Pedidos de clientes que llegan de Shopify. Separa lo que sale del stock de la tienda de lo que hay que pedir al proveedor, y lleva el flujo: revisión → aprobación → orden de compra → recibido → entregado.
- **Hoy no recibe pedidos de la tienda de Carlos:** los avisos de pedidos (webhooks) no están registrados en su tienda. Lo que aparece son pedidos de prueba. Activarlo es un paso aparte que hay que decidir con Carlos.

### Purchase Orders ⚠️
Órdenes de compra a proveedores (QBP, J&B, Specialized), una por cada pedido especial. Botones para copiar el número de parte y abrir el portal B2B del proveedor.
- Nunca se manda una orden de compra sin aprobación de una persona.
- Depende de **Special Orders**, así que hoy no tiene pedidos reales.

### Vendor Catalogs ⚠️
Importa catálogos de proveedores (CSV o TSV, más de 40 mil artículos), empareja por UPC o número de parte y deja en revisión lo dudoso.
- **Feed Sync:** estado de la sincronización con cada proveedor.
- No hay conexión automática con los proveedores (faltan las credenciales de distribuidor de UBC). Se carga a mano con CSV.
- En la tienda de Carlos el catálogo lo pone **Workstand**. Lo que se importe aquí sirve para la disponibilidad de pedido especial dentro del Hub, **no crea productos en Shopify**.

### UPC Matches ✅ (nuevo)
Aquí Carlos decide qué artículos de Lightspeed se conectan con qué variante de Shopify.
- **To review:** propuestas nuevas. Se buscan cada hora.
  - **New match:** artículo de Lightspeed con el mismo UPC que una variante de Shopify.
  - **Changed:** el UPC ahora corresponde a otro artículo de Lightspeed.
  - **No longer match:** el UPC ya no coincide, o la variante ya no existe en Shopify.
- Cada propuesta muestra el artículo de Lightspeed (nombre, UPC, stock), la variante de Shopify y los dos precios (el de Shopify hoy y el de Lightspeed que se pondría).
- **Approve:** desde ese momento Shopify toma el precio, la oferta y el stock de Lightspeed (segundos).
- **Reject:** se descarta y no se vuelve a proponer.
- **Approved → Unlink:** deja de sincronizar ese artículo. Shopify se queda con el precio que tenga.
- **Find matches now:** busca sin esperar la hora.
- Nunca propone quitar más del 20 % de las coincidencias de golpe; si pasara, deja una alerta.

## Pricing & System

### Promotions / Price Rules ✅ (falta una prueba en vivo)
Promociones en 3 pasos: elegir artículos, elegir descuento y revisar. Plantillas: Online Promo, Black Friday, Christmas, Clearance.
- Respeta el MAP y el margen mínimo; muestra el precio, el margen y el resultado del MAP de cada artículo antes de aprobar.
- Requiere aprobación de un owner o admin.
- **% o $ de descuento solo online:** crea un descuento automático en Shopify **solo para las variantes exactas** emparejadas por UPC.
- **Otras promociones:** cambian el precio en Shopify y muestran **tachado el precio normal**.
- **Restore:** vuelve cada artículo al precio actual de Lightspeed.
- Si la promoción incluye artículos que no están en Shopify, esos no se tocan.
- **Recomendación:** hacer primero una promoción de prueba con 1 o 2 artículos.

### Settings & Sync
- **Guardrails** ✅: margen mínimo, alerta de margen y reglas de disponibilidad de pedido especial.
- **Connections** ✅: estado de las conexiones con Lightspeed y Shopify. El botón de importar el catálogo de Shopify está **bloqueado** a propósito: con la tienda de Workstand metería 194 mil variantes al Hub.
- **Activity & Logs** ✅: trabajos en segundo plano (con reintento), errores y quién cambió qué (auditoría).
- **Store Simulator** ⛔: simula compras. Solo funciona en modo DEMO.

---

## Matrices (un producto en varios colores o tallas)

**Cómo está hoy:** en la Lightspeed de Carlos casi no hay matrices (3 en 25 mil artículos). Cada color y cada talla es un artículo propio con su UPC. En la web sí tienen que verse juntos: **un producto con selector de color o talla**, como la Jupiter Defiant.

**El Hub no necesita la matriz:** empareja **variante por variante usando el UPC**. Lo que importa es que en Shopify exista el producto con sus variantes, y que **cada variante tenga en el código de barras el mismo UPC** que el artículo de Lightspeed.

### Caso 1 — El producto ya viene en el catálogo de Workstand (la mayoría)
Specialized, Giro, Fox y otras marcas ya vienen con sus colores y tallas armados por Workstand. **No hay que construir nada.** Aparecen solos en UPC Matches, Carlos aprueba, y cada talla y color toma su precio y stock de Lightspeed. Ejemplo: la Epic World Cup Expert, con 4 tallas cada una con su propio precio.

### Caso 2 — El producto no está en Workstand (Jupiter Defiant, Jupiter Journey…)
Tres opciones:
1. **Armarlo a mano en Shopify**, como hizo Carlos con la Jupiter Defiant: un producto, una variante por color o talla, y en cada variante el **UPC exacto** de Lightspeed en el campo "Barcode". En menos de una hora aparece en UPC Matches; Carlos aprueba, y desde ahí precio y stock salen de Lightspeed. *Así funcionó la Jupiter Defiant: los 4 colores se emparejaron por su UPC.*
2. **Pedirle a Workstand que agregue esa marca a su catálogo** (por ejemplo, Jupiter). Así llega con fotos y descripción, y el Hub la empareja sola.
3. **Que el Hub lo arme (todavía no existe; se puede construir):** en el Hub, Carlos selecciona los artículos de Lightspeed que son el mismo producto (por ejemplo, los 4 colores), le pone nombre y el Hub crea en Shopify **un producto con esas variantes y sus UPC**, como borrador. Carlos solo agrega fotos y lo publica.

No hace falta que Carlos empiece a usar matrices en Lightspeed: con el UPC correcto en cada artículo alcanza.

---

## Lo que Carlos tiene que arreglar fuera del Hub
1. **Workstand:** que no cambie precio ni stock de lo que Carlos tiene en Lightspeed. Hoy pisa unos 1,000 precios al día y el Hub los corrige cada 30 min.
2. **Workstand:** que el catálogo que no está en Lightspeed termine en .99, si su configuración lo permite.
3. **Workstand:** que agregue las marcas que faltan (Shimano, SRAM, Sunlite, Troy Lee, Tifosi, Jupiter…). Hay unos 3,000 artículos con stock y UPC que todavía no están en Shopify.
4. **Lightspeed:** ponerle UPC a los ~1,700 artículos con stock que no tienen. La lista está en `build/audit-matrices-upc.csv`.
