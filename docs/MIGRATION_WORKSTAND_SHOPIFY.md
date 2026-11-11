# Plan de migración Workstand (SmartEtailing) → Shopify

No se desactiva Workstand ni se cambia el dominio de UBC sin autorización escrita de UBC.

## 1. Inventario (sin tocar nada en producción)
- Rastrear ubcbike.com (respetando robots.txt) y exportar: URLs, títulos, meta descriptions, H1, canonical, estado HTTP.
- Obtener de Google Search Console de UBC (acceso pendiente) las páginas con tráfico y enlaces externos.
- Exportar de Workstand: catálogo, categorías, marcas, páginas de servicio/alquiler, formularios, políticas.
- Identificar qué contenido/imágenes pertenecen a UBC y cuáles son de catálogos de proveedores (licencia).

## 2. Correspondencia de URLs
| Workstand (ejemplo de patrón) | Shopify |
|---|---|
| páginas de producto | `/products/<handle>` |
| categorías / listados | `/collections/<handle>` (Bikes, Electric Bikes, Parts, Accessories, Deals…) |
| marcas | `/collections/<marca>` o `/collections/vendors?q=<marca>` |
| servicio, alquiler, sobre UBC, contacto, FAQ | `/pages/<handle>` |
Los patrones reales se confirman en el paso 1; se genera un CSV `old_path,new_path`.

## 3. Redirecciones 301
- Importar el CSV en Shopify (*Navigation → URL redirects → Import*) antes del cambio de DNS.
- Probar cada redirección con un script (código 301 y destino 200).

## 4. SEO
- Títulos y descripciones por producto/colección (metafields SEO), `canonical` del tema, datos estructurados
  `Product` (filtro `structured_data`) y `BikeStore` en la portada (ya en el tema).
- Sitemap: Shopify lo genera en `/sitemap.xml`; enviarlo a Search Console tras el cambio.
- Imágenes: solo las propias de UBC o con licencia del proveedor; `alt` descriptivo.

## 5. Corte
1. Tienda Shopify completa con contenido aprobado (tema `demo_mode` desactivado).
2. Congelar cambios en Workstand 24 h antes.
3. Cambiar DNS del dominio comercial **solo con autorización** y conservando correo (MX/SPF/DKIM/DMARC).
4. Verificar redirecciones, checkout, pedidos y webhooks hacia el Integration Engine.
5. Monitorear Search Console (cobertura e indexación) 4–6 semanas; mantener Workstand accesible hasta confirmar.
