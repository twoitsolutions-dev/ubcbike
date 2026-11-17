# UBC Commerce Hub — Architecture, Storefront (Dawn) & Operations Guide

> **Prepared by:** TwoIT Solutions LLC  
> **Primary Client:** University Bicycle Center (UBC) — Omnichannel Physical Store (Lightspeed R-Series POS) + Online Storefront (Shopify)  
> **Platform Scope:** Multi-tenant by `company_id` (`companies.slug`) so TwoIT Solutions can onboard future retail stores on the same core engine.

---

## 1. Core Architectural Principle: The Intermediary Engine

Shopify **never** communicates directly with cycling distributors and never sees distributor-specific schemas. All external feeds and APIs converge into **UBC Commerce Hub**:

```text
QBP (API / CSV: item_number) ──┐
JBI (FTP / CSV: sku, gtin)   ──┼─► UBC Commerce Hub (Node.js + Fastify + PostgreSQL) ──► Shopify Storefront
Specialized (B2B: partNumber)──┘     1. Import & Normalize                                 (Clean prices, qty,
Lightspeed R-Series POS      ──┘     2. Deduplicate (GS1 GTIN + Review Queue)               ubc.* metafields)
                                     3. Version Deltas (supplier_offer_history)
                                     4. Processing Buffer (MAP & Margin Gate)
                                     5. Tiered Cadence & Feed Watchdog
```

### Non-Negotiable Commercial & Inventory Rules
1. **Physical Stock vs. Distributor Offers Are Never Summed:**
   - Physical units owned by UBC (`inventory_levels.on_hand - reserved`) drive `in_stock` status.
   - Distributor availability (`supplier_offers.qty_available`) drives `special_order` (`publishedQty = 0`, `inventoryPolicy = CONTINUE`, `ubc.availability = 'special_order'`, `ubc.lead_time_days = N`).
2. **Processing Buffer ("Margen de Procesamiento" — `outbound_sync_staging`):**
   - Every supplier cost, MAP, or availability update is evaluated before touching Shopify.
   - If a supplier raises MAP above Shopify's published price (`map_above_published_price`) or cost erodes minimum margin (`margin_below_minimum`), the item is quarantined (`decision = 'held_for_review'`, `status = 'held'`) until an operator resolves it in **`#/pipeline`**.
3. **Versioned Supplier History (`supplier_offer_history`):**
   - Tracks every cost, MAP, MSRP, and quantity delta alongside the exact price published on Shopify at that moment (`shopify_published_price_cents`) and resulting margin (`resulting_margin_bps`).
4. **Differentiated Sync Cadences & Dead-Man's-Switch Watchdog:**
   - `availability`: every **15–30 minutes** (target 20m)
   - `costs`: every **6–12 hours** (target 9h)
   - `content`: **daily** (24h, only when `content_licensed = true`)
   - `full_catalog`: **event / manual**
   - **Feed Watchdog:** Raises deduplicated alerts in `error_log` (`source = 'watchdog:supplier_feed'`) if an active supplier stops reporting beyond `max_silence_hours` (default **48h**).
5. **Omnichannel Promotion Scope (`online` vs. `online_and_pos`):**
   - Everyday promotions apply strictly to the online store (`channel = 'online'`).
   - Physical store POS price synchronization (`channel = 'online_and_pos'` via `LightspeedRClient.updateEventPosPrices`) is opt-in **exclusively** for major storewide events (`black_friday`, `christmas`, `holiday_sale`, `annual_clearance`, `special_event`).
6. **Specialized Complete-Bike Click & Collect Rule:**
   - Complete bicycles under restricted brand policies automatically set `ubc.click_and_collect_only = true` so customers see *In-Store Pickup Only* on the product page and shipping is restricted at checkout.

---

## 2. Storefront Strategy: Shopify Dawn Base + Modern Custom Redesign

For UBC's production ecommerce site, TwoIT Solutions will build upon **Shopify Dawn (OS 2.0)** as the base theme and progressively customize its layout, typography, and components into a modern cycling storefront.

### How Dawn Connects to UBC Commerce Hub
UBC Commerce Hub writes three clean variant metafields in namespace `ubc`:
- `ubc.availability`: `'in_stock' | 'special_order' | 'unavailable'` (`single_line_text_field`)
- `ubc.lead_time_days`: integer estimated business days (`number_integer`)
- `ubc.click_and_collect_only`: boolean (`boolean`)

### Installing the Dawn Integration Kit (`dawn-integration/`)
Run `npm run theme:pack` to generate `build/ubc-dawn-integration-kit.zip`, or copy directly from `dawn-integration/`:

1. **Instant Zero-Code Test in Dawn (Shopify Theme Editor):**
   - Open **Online Store → Themes → Customize** on Dawn.
   - Navigate to **Products → Default product** → under **Product information**, click **Add block → Custom Liquid**.
   - Paste the contents of `dawn-integration/ubc-dawn-fulfillment.liquid`.
   - Save. Dawn immediately renders real-time *In Stock at UBC*, *Available to Order (3–5 Business Days)*, and *In-Store Pickup Only* badges, updating dynamically whenever the shopper switches frame size or color!

2. **Full Modernized Dawn Codebase Integration (Production):**
   - Copy `dawn-integration/ubc-dawn-fulfillment.liquid` → Dawn's `snippets/ubc-dawn-fulfillment.liquid` and render inside `sections/main-product.liquid`:
     ```liquid
     {% render 'ubc-dawn-fulfillment', product: product %}
     ```
   - Copy `dawn-integration/ubc-dawn-card-badge.liquid` → Dawn's `snippets/ubc-dawn-card-badge.liquid` and render inside `snippets/card-product.liquid`:
     ```liquid
     {% render 'ubc-dawn-card-badge', card_product: card_product %}
     ```

---

## 3. Shopify 2026 Dev Dashboard Authentication (`client_credentials`)

Since January 1, 2026, new Shopify stores authenticate server-to-server apps created in the **Shopify Dev Dashboard** using OAuth 2.0 `client_credentials` rather than legacy static `shpat_...` tokens:
- Set `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_CLIENT_ID`, and `SHOPIFY_CLIENT_SECRET` in `.env` (never commit `.env`).
- `ShopifyAdminClient` exchanges credentials at `POST https://{shop}/admin/oauth/access_token`, caches the ~24h `shpua_...` token in memory, renews it 5 minutes before expiry, and retries once automatically on `HTTP 401`.
- Incoming Shopify webhooks (`POST /webhooks/shopify`) are verified via HMAC-SHA256 using `SHOPIFY_WEBHOOK_SECRET` (automatically defaulting to `SHOPIFY_CLIENT_SECRET` for Dev Dashboard apps).

---

## 4. Operational CLI Commands Reference

| Command | Purpose |
|---|---|
| `npm run build` | Compiles all TypeScript packages (`shared`, `business-rules`, `demo-data`, `integrations`, `database`, `api`) and bundles Admin vendor modules. |
| `npm run test:unit` | Runs the 44 unit & integration tests across `business-rules`, `integrations`, and `database`. |
| `npm run db:check` | Read-only diagnostic against PostgreSQL / Supabase (`DATABASE_URL`). |
| `npm run shopify:check` | Read-only diagnostic against Shopify (`SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET`), reporting granted OAuth scopes, locations, and catalog sample. |
| `npm run shopify:bootstrap` | Applies migrations `001`–`003`, creates isolated tenant (`twoit-sandbox` for sandbox stores, `ubc` for UBC production), schedules, users, and imports Shopify's catalog in read-only mode. |
| `npm run pipeline:verify` | End-to-end verification of normalization, GS1 matching, cost versioning, MAP staging quarantine, and +52h feed watchdog in Supabase. |
| `npm run order:verify` | Simulates a signed Shopify `orders/create` webhook splitting UBC stock + distributor Special Order into Carlos Mirabal's PO approval queue. |
| `npm run theme:check` | Runs `@shopify/theme-check-node` against `apps/shopify-theme`. |
| `npm run theme:pack` | Builds `build/ubc-shopify-theme.zip` and `build/ubc-dawn-integration-kit.zip` with POSIX `/` paths. |
| `npm run dev` | Starts the Fastify API + Admin UI (`http://127.0.0.1:8787`) + background Worker loop. |
