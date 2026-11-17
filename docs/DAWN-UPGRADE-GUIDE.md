# Guía de Mantenimiento y Actualización — Tema UBC sobre Shopify Dawn 16.1.1 (`v23`)

Este documento detalla cómo está construido el tema de **University Bicycle Center (`apps/dawn-ubc-fable-theme`)** sobre **Shopify Dawn 16.1.1 (Online Store 2.0)**, qué archivos nativos de Dawn tienen puntos de conexión y cómo actualizar Dawn en el futuro sin perder personalizaciones.

---

## 1. Archivos nativos de Dawn modificados (3 archivos en total)

Todo el código visual e interactivo de UBC vive en archivos propios con prefijo `fable-*` y `ubc-*` (`sections/`, `snippets/`, `assets/`). Solo **3 archivos nativos de Dawn** contienen puntos de conexión mínimos marcados con `{%- comment -%} [UBC-MOD] ... {%- endcomment -%}`:

| Archivo de Dawn | Cambio exacto (`[UBC-MOD]`) | Snippet propio invocado |
| --- | --- | --- |
| `layout/theme.liquid` | 1) Condiciona la precarga/`@font-face` de `Assistant` con `{%- unless settings.ubc_use_custom_brand_fonts != false -%}` para no descargar fuentes innecesarias cuando están activas `Anton` y `Barlow`.<br>2) Renderiza el puente de estilos/variables en `<head>`.<br>3) Renderiza el atributo `data-ubc-edition` y widgets globales (Ikeono + Modal de Reels) al final de `<body>`. | `snippets/ubc-head-bridge.liquid`<br>`snippets/ubc-body-bridge.liquid` |
| `sections/header.liquid` | Fallback del logo UBC cuando `settings.logo == blank` (solo aplica si algún día se activa el header nativo de Dawn en lugar de `fable-header`). | `snippets/ubc-logo-fallback.liquid` |
| `sections/main-product.liquid` | Debajo del bloque `price`, muestra el estado real de inventario (`ubc.availability_status`, pedido especial con días estimados y aviso de retiro en tienda para bicicletas armadas). Dawn vuelve a renderizar este bloque automáticamente al cambiar de talla/variante. | `snippets/ubc-availability.liquid` |

Todo el resto de Dawn (`assets/global.js`, `assets/cart.js`, `assets/cart-drawer.js`, `sections/cart-drawer.liquid`, `sections/main-collection-*.liquid`, `sections/main-cart-*.liquid`, `sections/main-search.liquid`, etc.) permanece **100% idéntico a Dawn 16.1.1**.

### Procedimiento al actualizar a una versión futura de Dawn
1. Reemplazar los archivos base de Dawn conservando intactos todos los archivos `sections/fable-*.liquid`, `sections/ubc-*.liquid`, `snippets/ubc-*.liquid` y `assets/ubc-*` / `assets/fable-*`.
2. Reaplicar los 3 bloques marcados con `[UBC-MOD]` en `layout/theme.liquid`, `sections/header.liquid` y `sections/main-product.liquid`.
3. Verificar que `config/settings_schema.json` conserve el bloque final `"UBC Storefront & Campaigns"` (`ubc_edition`, `ubc_use_custom_brand_fonts`, `ubc_ikeono_*`).
4. Ejecutar `npm run theme:verify-all` antes de empaquetar o subir.

---

## 2. Verificación obligatoria de configuración antes de subir (`settings_schema.json` y `settings_data.json`)

Tanto `scripts/pack-theme.mjs` como `scripts/diagnose-themes.mjs` bloquean cualquier empaquetado si no se cumplen estas condiciones:
- `config/settings_schema.json` existe, es un arreglo JSON válido y pesa **>= 38 KB** (~42.6 KB en Dawn 16.1.1 + bloque UBC).
- `config/settings_data.json` existe y define los 5 esquemas de color **`scheme-1` a `scheme-5`** sincronizados con la paleta de cada edición (`classic`, `black_friday`, `christmas`, `july_4`).

Comando único de validación completa (`Theme Check` + diagnóstico de esquemas/settings + empaquetado ZIP con verificación CRC32):

```bash
npm run theme:verify-all
```

---

## 3. Controles editables desde el Editor de Shopify (sin tocar código)

- **Navegación (`sections/fable-header.liquid` y `sections/fable-footer.liquid`):**
  - El Header incluye selectores `link_list` para **Desktop Navigation Menu** (soporta menús de 1, 2 o 3 niveles como mega-menú automático) y **Mobile Drawer Menu**. Si no se asigna un menú personalizado aún, usa enlaces seguros con `{{ home_anchor }}#...` y verifica automáticamente si existen `pages['our-story']`, `pages['locations']` y las colecciones (`electric-bikes`, `road-bikes`, `mountain-bikes`, `hybrid-bikes`).
  - El Footer incluye 3 selectores `link_list` independientes (`footer_menu_1`, `footer_menu_2`, `footer_menu_3`) con títulos editables.
- **Teléfonos dinámicos (`tel:`):**
  - En `fable-header.liquid`, `fable-workshop-pro.liquid`, `fable-service-rentals-stores.liquid` y `fable-footer.liquid`, el atributo `href="tel:..."` se calcula dinámicamente limpiando caracteres del texto configurado en el editor (agregando `+1` automáticamente si se ingresan 10 dígitos de EE. UU.).
- **Tipografía (`settings.ubc_use_custom_brand_fonts`):**
  - **Activado (por defecto):** Usa `Anton`, `Barlow Condensed` y `Barlow` auto-alojadas en `assets/` (`woff2`), conecta las variables `--font-*` de Dawn a ellas y **omite la descarga de `Assistant`** para ahorrar peso.
  - **Desactivado:** Conecta `--ubc-font-display`, `--ubc-font-label` y `--ubc-font-body` directamente a los selectores nativos **Typography** del Editor de Shopify.
- **Bilingüe SEO (`EN / ES`):**
  - `locales/es.json` contiene todas las traducciones de Dawn y del espacio de nombres `ubc.*` en español.
  - Cuando **Shopify Markets / Translate & Adapt** tiene publicado el idioma Español (`/es`), `fable-header.liquid` renderiza enlaces reales `<a hreflang="es" href="/es...">` indexables por Google y `ubc-fable.js` detecta `<html lang="es">` automáticamente al cargar.
  - Si la tienda aún tiene un solo idioma activo en Shopify Admin, el botón `EN | ES` funciona como conmutador instantáneo de respaldo en el navegador.
