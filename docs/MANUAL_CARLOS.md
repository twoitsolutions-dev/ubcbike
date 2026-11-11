# Manual de uso — Carlos Mirabal

UBC Commerce Hub es el panel para administrar productos, precios, promociones, proveedores y pedidos especiales.
En la demo **todos los datos son ficticios** y nada se envía a Shopify, Lightspeed ni a los proveedores.

## Entrar
1. Abra https://ubc-demo.twoitsolutions.com e introduzca el usuario y la contraseña del sitio.
2. En la demo, elija **Carlos Mirabal**. (En producción será su correo y contraseña personal.)
3. En el iPhone, el menú está en el botón ☰ arriba a la izquierda.

## Dashboard
Resumen: productos publicados, con stock en UBC, solo de proveedor (pedido especial), sin disponibilidad, pedidos,
pedidos especiales abiertos, promociones activas y errores. "Needs attention" lleva directo a lo que requiere acción
(por ejemplo, compras pendientes de su aprobación).

## Productos, inventario y precios
- **Products**: buscar por nombre, marca, SKU, UPC o número de pieza; filtrar por disponibilidad, estado, categorías,
  proveedores, marcas, rango de precio y de margen (**More filters**).
- Seleccionar filas (o "Select all N matching") → **Publish**, **Hide** o **Create promotion…**. Siempre pide confirmación.
- **Inventory**: el stock físico de UBC se muestra aparte de lo que reportan los proveedores. Nunca se suman.
- **Prices & margins**: ordenado por menor margen; **Edit** muestra el margen nuevo y avisa si queda bajo MAP o bajo costo.

## Crear una promoción (ej. Black Friday)
1. **Promotions → New promotion**.
2. Paso 1: elija categoría (ej. Accessories), marcas, proveedores, rangos… Se muestra cuántos productos coinciden.
3. Paso 2: tipo de cambio (% de descuento, importe fijo, subir %, subir importe o precio fijo), redondeo y canal:
   - *Online only*: solo la tienda Shopify.
   - *Online + POS*: también el precio en tienda (Lightspeed). Hoy está bloqueado para sistemas reales.
4. Paso 3: margen mínimo (las líneas por debajo se bloquean o, si marca la opción, se suben al precio mínimo).
5. Paso 4 (opcional): fecha y hora de inicio y fin.
6. **Preview impact**: verá cada producto con precio anterior y nuevo, costo, márgenes, MAP y el resultado:
   - *Will apply* · *Warning* (margen bajo, precio ajustado) · *Blocked* (bajo MAP o bajo margen mínimo) · *Excluded* (sin costo o sin cambio).
7. **Approve & schedule**. Solo se cambian las líneas permitidas. Si los precios cambiaron desde la vista previa, el
   sistema le muestra la vista actualizada antes de aprobar.
8. **Restore original prices** devuelve cada producto a su precio anterior, excepto los que alguien cambió después
   (quedan con el precio nuevo y se reportan como "skipped changed").
9. **Export CSV** descarga el detalle.

> MAP no se puede saltar con un clic. Si un proveedor autoriza por escrito vender bajo MAP, un administrador registra
> la excepción (quién aprobó, referencia y vigencia).

## Pedidos especiales
1. Un cliente compra algo que UBC no tiene físicamente → el pedido llega como **Special order**.
2. El sistema vuelve a consultar disponibilidad y costo con el proveedor y crea una **solicitud de compra**.
3. Estado **Awaiting Approval**: abra el pedido → **Approve purchase**. Si el costo subió o ya no hay stock, el pedido
   pasa a **Exception** y no se compra nada.
4. **Send PO to supplier**: envía la orden de compra (en la demo es simulada).
5. Actualice: *Supplier confirmed* → *In transit* (número de seguimiento) → *Received at UBC* → *Ready for pickup* o
   *Shipped to customer* → *Completed*.
6. **Report exception** (agotado, cambio de costo, dañado, devolución, reembolso…) exige motivo y nota.
   **Cancel order** también exige nota.
- **Supplier purchasing** lista todas las órdenes de compra.
- **Store (simulated)** permite hacer una compra de prueba para ver el flujo completo.

## Proveedores
- Tarjetas de QBP, JBI y Specialized con ofertas, no vinculadas y estado de conexión.
- **Import feed (CSV)**: suba el archivo autorizado del proveedor y mapee columnas. Coincidencias seguras (mismo UPC
  válido) se vinculan solas; las dudosas van a la **cola de revisión**: *Same product* o *Different*.

## Historial y errores
Trabajos en segundo plano (con reintentos), errores abiertos (**Mark resolved**) y auditoría de quién cambió qué.

## Ajustes
Margen mínimo y de aviso, stock de seguridad, antigüedad máxima de datos de proveedor, días de preparación.
Solo administradores pueden cambiarlos. En la demo: simular caída de proveedor y **Reset demo data**.
