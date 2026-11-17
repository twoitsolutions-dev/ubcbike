# Guia General del Sistema UBC (Explicacion Sencilla)

## 1. Que es este sistema en pocas palabras

Imagina que **University Bike Center (UBC)** tiene tres mundos separados:
1. **La tienda fisica** (caja e inventario local en **Lightspeed POS**).
2. **La tienda en internet** (**Shopify**, donde compran los clientes).
3. **Las bodegas de los proveedores** (**QBP, JBI, Specialized**, con miles de repuestos y bicicletas que UBC no tiene en el local pero si puede pedir).

Antes, conectar esos tres mundos obligaba a hacer trabajo manual, arriesgarse a vender algo agotado o bajar precios por error perdiendo dinero.

**UBC Commerce Hub** (https://ubc-hub.twoitsolutions.com) es el **panel central ("el cerebro intermedio")** que se sienta en medio de los tres para poner orden, proteger las ganancias y ahorrar trabajo operativo.

---

## 2. Las 4 piezas del sistema

```
[ Clientes en Internet ]
          |
          v
[ 1. Tienda Online Shopify ]  <--- Tema visual UBC Dawn v24 (normal + temporadas)
          |
          |  (Envia pedidos y recibe precios/stock automaticamente)
          v
[ 2. UBC Commerce Hub ]       <--- Panel de control en ubc-hub.twoitsolutions.com
     /            \
    v              v
[ 3. Lightspeed ] [ 4. Portales B2B de Marcas ]
 (Stock fisico     (QBP.com, JBI.bike, Specialized B2B
  en tiendas UBC)   donde Carlos hace los pedidos)
```

1. **Tienda Online (Shopify + Tema UBC v24):** Es donde ocurre la venta real. El cliente compra y paga en **Shopify**, y el pedido queda registrado en el panel normal de Shopify (cobros, datos del cliente, etiquetas de envio y notificaciones).
2. **UBC Commerce Hub (`ubc-hub.twoitsolutions.com`):** Es el asistente operativo interno de UBC. Un segundo despues de que entra una venta en Shopify, Shopify le envia una **copia automatica** al Hub para resolver lo que Shopify por si solo no sabe hacer: separar que productos salen del stock fisico de UBC y cuales debe pedir Carlos en los portales B2B de los proveedores, ademas de cuidar margenes y promociones.
3. **Sistema de Tienda Fisica (Lightspeed POS):** Informa cuantas unidades reales hay colgadas o guardadas fisicamente en UBC.
4. **Proveedores / Marcas (QBP, JBI, Specialized):** Aportan su catalogo y disponibilidad para vender bajo modalidad de **Pedido Especial (Special Order)**, y sus portales B2B son donde Carlos concreta las compras.

---

## 3. Como funciona en el dia a dia (los 4 flujos principales)

### Flujo A: Inventario claro (tanto para UBC como para el cliente en la web)
El sistema **nunca suma ni revuelve** el inventario propio de UBC con el de los proveedores, y **le avisa claramente al cliente en la pagina web antes de comprar** mediante etiquetas automaticas (`ubc.availability` y `ubc.lead_time_days`) que el Hub envia a Shopify:
- **En stock UBC (`In Stock at UBC`):** Lo que esta fisicamente en la tienda. En la web aparece con indicador **verde** (*Listo para retiro en tienda o envio rapido*).
- **Pedido Especial (`Available to Order / Special Order`):** Lo que UBC no tiene en el local, pero el distribuidor autorizado si tiene en bodega. En la web aparece con indicador **morado** indicando los **dias habiles estimados** (ej. *3–5 dias habiles*) tanto en el listado de productos, como al elegir talla/color en la ficha del producto, como en el **carrito antes de pagar**.
- **Solo retiro en tienda (`In-Store Pickup Only`):** Para bicicletas completas que por politica de marca (ej. Specialized) se entregan armadas e inspeccionadas en el taller de UBC.
- **Agotado (`Sold Out / Currently Unavailable`):** Cuando no hay ni en UBC ni en proveedores, o cuando el dato del proveedor es demasiado antiguo para confiar en el.

### Flujo B: Cuando entra una venta en Shopify (y como compra Carlos)
Cuando un cliente paga un pedido en la web, Shopify le avisa al instante al Hub y el Hub revisa producto por producto:

1. **Si todo esta en tienda UBC:** Se marca para despacho o retiro local usando el stock propio.
2. **Si falta algo en tienda (o es un pedido mixto):** El Hub separa automaticamente lo que sale de tienda y crea una **Hoja de Compra B2B (Worksheet)** solo por lo que hay que pedirle al proveedor.
3. **Revision y compra en el portal B2B:**
   - El sistema **no manda compras automaticas a espaldas de Carlos**.
   - Carlos entra a **B2B purchasing** en el Hub, ve que proveedor tiene mejor opcion y revisa que el costo no haya subido.
   - Con un clic en **Copy SKU** copia el codigo del proveedor y con **Open JBI / QBP / Specialized B2B** abre el portal oficial de la marca.
   - Carlos arma su carrito en el portal B2B (asi puede juntar el encargo del cliente con reposicion de tienda para alcanzar envio gratis) y pega en el Hub el **numero de confirmacion B2B**.
4. **Seguimiento, recepcion en Lightspeed (`Special Orders`) y regla cuando varios clientes piden el mismo producto:**
   - **Recepcion sin cambiar la rutina de tienda:** Cuando llega la caja del proveedor, recepcion escanea el PO en **Lightspeed R-Series** como siempre. Lightspeed tiene un apartado nativo llamado **`Special Orders`** (`/SpecialOrder.json`) que detecta si esa pieza pertenece a un pedido especial (`Not Ordered` -> `Ordered` -> `Ready`), apartandola para que nadie la venda en mostrador. El Hub lee esos estados en modo solo-lectura para saber cuando Carlos ya ordeno y cuando la pieza ya llego fisicamente a UBC, notificando al cliente desde **Shopify** (correo de *Listo para recoger* o *Guia de rastreo UPS/USPS*).
   - **Trazabilidad estricta 1 a 1 por `#Orden + Cliente` (jamas por SKU suelto):** Si dos clientes distintos (**Juan `#1051`** y **Maria `#1068`**) piden exactamente el mismo SKU en *Special Order*:
     - En el Hub aparece una etiqueta amarilla **`Shared SKU: also in #1051`** para avisar que hay otro cliente esperando ese mismo producto.
     - Si hoy llega **1 sola unidad**, el sistema asigna **unicamente 1 unidad** (al pedido referenciado en la nota de Lightspeed o al cliente mas antiguo por regla **FIFO: primero en comprar, primero en recibir**) y mantiene al segundo cliente esperando la siguiente caja. Nunca avisa a dos clientes por una sola pieza.
5. **Cancelaciones en Shopify (proteccion a prueba de olvidos):**
   - El Hub escucha automaticamente el aviso de cancelacion de Shopify (`orders/cancelled` y `orders/updated`):
     - **Si Carlos aun no lo ha marcado como comprado en B2B:** El Hub cierra automaticamente la hoja de compra, libera cualquier stock local reservado y deja un aviso en el Dashboard (*"Verificar que el SKU no haya quedado en el carrito B2B de JBI/QBP"*) por si Carlos lo habia agregado a su carrito externo sin darle clic aun en el Hub.
     - **Si Carlos ya lo habia marcado como comprado en B2B:** El Hub **no lo borra en silencio**; pasa el pedido a **Excepcion Urgente** y levanta una alerta roja en el Dashboard para frenarlo en el portal B2B de la marca o recibirlo para inventario de tienda.
     - **Proteccion de SKU compartido:** Si Maria (`#1068`) cancela pero Juan (`#1051`) sigue esperando el mismo SKU, la alerta indica expresamente mantener activa la unidad de `#1051`.
6. **Como se cobran los envios al cliente sin perder margen:**
   - Se separan el flete B2B (Proveedor -> UBC) del envio final (UBC -> Cliente en Shopify):
     - **Retiro en tienda UBC (In-Store Pickup):** Gratis en accesorios/repuestos normales porque Carlos agrupa los encargos con reposicion semanal de tienda para alcanzar el envio gratis B2B del distribuidor.
     - **Envio a domicilio:** Lo cobra Shopify en el checkout segun monto o peso (ej. envio gratis sobre cierto monto y tarifa fija/transportista debajo de ese umbral).
     - **Articulos pesados/voluminosos y bicicletas completas:** En Shopify se aplican *Shipping Profiles* con recargo fijo para cajas *Oversize/Heavy* y la regla automatica **`In-Store Pickup Only`** (`ubc.click_and_collect_only`) en bicicletas completas.

### Flujo C: Promociones y descuentos con "freno de seguridad"
Hacer un descuento masivo en cientos de productos a mano es peligroso porque muchas marcas de ciclismo exigen un **precio minimo anunciado (MAP)** y ciertos productos tienen poco margen.

En el Hub:
1. Eliges que quieres rebajar (por ejemplo: *20% de descuento en Cascos y Luces para Black Friday*).
2. Antes de cambiar nada en Shopify, el Hub simula el impacto producto por producto:
   - **Permitido (Will apply):** Tiene buen margen y respeta las reglas de la marca.
   - **Ajustado / Aviso (Warning):** Baja hasta el limite seguro sin perder dinero.
   - **Bloqueado (Blocked):** No se rebaja porque violaria el precio minimo MAP de la marca o dejaria el margen por debajo del minimo permitido.
3. Apruebas la promocion y el Hub actualiza los precios permitidos en Shopify.
4. Cuando termina la campana, con un clic en **Restore original prices** todos los productos vuelven a su precio original (respetando si alguien cambio un precio manualmente entre tanto).

### Flujo D: Carga de catalogos de proveedores sin duplicados
Los proveedores manejan decenas de miles de articulos en archivos CSV. Cuando se sube un archivo de proveedor al Hub:
- Si el codigo universal (**UPC**) coincide exactamente con un producto de UBC, el sistema los vincula solo.
- Si el nombre se parece pero hay duda, **no adivina**: lo envia a una bandeja de revision rapida para que una persona confirme con un clic si es el mismo producto o uno nuevo.

---

## 4. Guia exacta del menu lateral del Hub (tal como se ve en pantalla)

Al entrar en https://ubc-hub.twoitsolutions.com veras a la izquierda estos **5 bloques y 13 pantallas exactas**:

### OVERVIEW (Vista general y tuberia de datos)
- **Dashboard:** Resumen del dia, metricas generales y alertas de lo que requiere atencion inmediata (*Needs attention*).
- **Pipeline & staging:** Monitor del motor intermedio: muestra si los feeds de QBP/JBI/Specialized estan al dia (*Watchdog*), el historial de cambios de costos y la **bandeja de retencion (*Staging buffer*)** donde quedan frenados los productos cuyo MAP o margen cambiaron antes de tocar Shopify.

### CATALOG (Catalogo, stock y proveedores)
- **Products:** Lista maestra de productos para buscar, filtrar, publicar u ocultar en Shopify.
- **Inventory:** Comparativa clara entre unidades fisicas en tiendas UBC vs. unidades reportadas por cada proveedor (nunca mezcladas).
- **Suppliers:** Tarjetas de QBP, JBI y Specialized, boton para subir catalogos CSV (*Import feed*) y cola para aprobar vinculaciones dudosas.

### PRICING (Precios, margenes y campanas)
- **Prices & margins:** Productos ordenados de menor a mayor ganancia para detectar de inmediato articulos con poco margen o bajo MAP.
- **Promotions:** Creador de ofertas (ej. Black Friday) con vista previa de impacto (*Will apply*, *With warnings*, *Blocked*, *Excluded* — por ejemplo excluyendo *Gift Cards* o productos sin costo registrado), aprobacion hacia Shopify y boton para restaurar precios originales.

### OPERATIONS (Pedidos y compras diarias)
- **Orders:** Todos los pedidos recibidos desde Shopify (el globo naranja indica cuantos esperan accion), su division entre stock UBC vs. proveedor y su linea de tiempo.
- **B2B purchasing:** La cola directa de Carlos con el SKU del distribuidor, aviso **`Shared SKU`** si varios clientes pidieron lo mismo, boton **`Copy SKU`** y boton **`Open JBI / QBP / Specialized B2B`**.
- **Store (simulated):** Vista previa interna de como se ven las reglas de *In Stock*, *Special Order* y *Pickup Only* de cara al cliente (las compras simuladas con un clic solo estan activas en el entorno `DEMO`; en `LIVE` las ventas reales entran desde Shopify).

### SYSTEM (Conexiones, historial y reglas)
- **Integrations:** Estado en vivo de la conexion con Shopify, Lightspeed R-Series y los conectores de proveedores, mas botones de sincronizacion manual.
- **History & errors:** Centro de control con **3 pestanas internas** (el globo naranja muestra errores abiertos por revisar):
  1. *Background jobs* (tareas automaticas en segundo plano).
  2. *Errors* (errores de sincronizacion y avisos de pedidos cancelados desde Shopify, con boton *Mark resolved*).
  3. *Audit trail* (bitacora completa de quien aprobo, edito precios o cambio estados).
- **Settings:** Reglas globales de negocio (margen minimo permitido, margen de advertencia, stock de seguridad y dias estimados de preparacion).

---

## 5. Donde vive todo hoy y estado actual

| Componente | Donde funciona hoy | Estado |
| :--- | :--- | :--- |
| **UBC Commerce Hub (Panel + API + Motor)** | Hostinger (`https://ubc-hub.twoitsolutions.com`) | **Activo en vivo** |
| **Base de datos central** | Supabase PostgreSQL | **Activa y conectada** |
| **Tienda Shopify conectada (entorno de pruebas)** | `ubcbike-hub.myshopify.com` | **Conectada en vivo** (webhooks de pedidos, 10 productos PNG transparentes y 4 temas `v28` instalados) |
| **Temas visuales de tienda (Dawn v28)** | Publicado + 3 temporadas en `ubcbike-hub.myshopify.com` y carpeta `build/` | **Instalados en vivo** (`Classic` activo + `Black Friday`, `Christmas` y `July 4th`) |
| **Conexion final a cuentas definitivas de UBC** | Shopify Plus UBC + Lightspeed POS UBC + CSVs reales | **Pendiente solo de credenciales del cliente** (ver `docs/ACCESS_PENDING.md`) |

Cuando UBC entregue las llaves de su tienda Shopify definitiva y de su Lightspeed POS, **no hay que reconstruir el sistema**: unicamente se reemplazan las llaves de conexion en el servidor y todo el circuito pasa a operar sobre la tienda oficial de UBC.
