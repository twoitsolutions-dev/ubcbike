# Backup — Configuración Actual de Shipping & Delivery en Shopify (`ubcbike`)

Snapshot capturado el **2026-11-26** antes de cualquier cambio de perfiles o CarrierService del Hub, para poder restaurar exactamente la configuración que dejó Carlos Mirabal.

---

## 1. Modo de Envío Activo
- **Vista:** *Shipping has moved to Markets* (`/store/ubcbike/settings/shipping` → **Markets → United States** `/store/ubcbike/markets/96112181565#shipping`)
- **Botón para volver a perfiles clásicos:** En **Settings → Shipping and delivery**, dentro del banner superior de **Shipping options** → **Switch back** (*"Switch back from Markets to shipping profiles"*).
- **Aviso pendiente detectado:** *"1 app may need updated data access to keep working with Markets"* → **Pirate Ship: CheapARR Shipping** (`/store/ubcbike/apps/pirate-ship`).

---

## 2. Tarifas de Envío — Market: United States (All products)
Ambas opciones aplican a **All products** y a **3 de 4 ubicaciones** (`University Bicycle Center`, `UBC at Alafia River State Park`, `Warehouse`). **`Workstand Supplier Stock` NO está marcada.**

### A. UPS (Carrier or app calculated)
- **Servicios activos (4):**
  - `UPS 2nd Day Air`
  - `UPS Next Day Air Saver`
  - `UPS Ground`
  - `UPS Standard`
- **Handling fee:** `10%`
- **Offer free shipping:** `OFF`

### B. USPS (Carrier or app calculated)
- **Servicios activos (3):**
  - `USPS Ground Advantage`
  - `USPS Priority Mail`
  - `USPS Priority Mail Express`
- **Handling fee:** `10%`
- **Offer free shipping:** `OFF`

---

## 3. Cajas (`Packages`)
1. `Medium Box` — `12 × 12 × 12`, `15 lb` (**Default**)
2. `Bicycles` — `40 × 12 × 26`, `50 lb`
3. `E-Bike` — `63 × 12 × 34`, `86 lb`

- **Delivery estimates:** Automated dates
- **Shipping labels:** USPS (`1/10`), UPS (`1/14`)
- **Carrier accounts:** None (*plan upgrade required*)

---

## 4. Order Routing (2 reglas activas, de arriba a abajo)
Ruta: `/store/ubcbike/settings/shipping/order_routing`
1. **Minimize split fulfillments** — *Check if any locations can fulfill the entire order*
2. **Ship from the closest location** — *Pick locations closest to the delivery address*

---

## 5. Local Delivery y Pickup in Store por Ubicación

### University Bicycle Center (`1220 E Fletcher Ave, Tampa FL 33612`)
- **Local Delivery:** **ON** (Radius-based, miles, USD, neighboring states/regions unchecked)
  - Hasta `6.0 mi`: **$10.00** (mínimo de orden `$100.00`)
  - `6.0 mi` a `15.0 mi`: **$25.00** (mínimo de orden `$100.00`)
  - `15.0 mi` a `20.0 mi`: **$35.00** (mínimo de orden `$100.00`)
- **Pickup in store:** **ON (FREE)** — *Usually ready in 24 hours*
  - Store transfers desde: **UBC at Alafia River State Park** y **Warehouse** (`Usually ready in 5+ days`; excluye `Workstand Supplier Stock`).

### UBC at Alafia River State Park (`14326 S County Rd 39, Lithia FL 33547`)
- **Local Delivery:** **OFF**
- **Pickup in store:** **ON (FREE)** — *Usually ready in 24 hours*
  - Store transfers desde: **University Bicycle Center** y **Warehouse** (`Usually ready in 5+ days`; excluye `Workstand Supplier Stock`).

### Warehouse (`1220 E. Fletcher Ave, Tampa FL 33612`)
- **Local Delivery:** **OFF**
- **Pickup in store:** **OFF**

### Workstand Supplier Stock (`1220 E. Fletcher Ave, Tampa FL 33612`)
- **Local Delivery:** **OFF**
- **Pickup in store:** **OFF**
- **No marcada en UPS/USPS ni en transferencias.**

---

## 6. Cómo volver exactamente a este estado si se cambia algo
1. Si se activó *Shipping profiles* con **Switch back**, volver a activar *Shipping in Markets* (o recrear en *General profile* → zona `United States` las opciones **UPS** 4 servicios + 10% y **USPS** 3 servicios + 10% sobre las 3 ubicaciones).
2. Si se agregó el **CarrierService del Hub**, desactivarlo o eliminarlo en *Shipping options* y dejar únicamente **UPS** y **USPS** nativos.
3. Verificar en **Order routing** que sigan activas en orden: `1. Minimize split fulfillments` → `2. Ship from the closest location`.
