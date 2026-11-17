-- ============================================================================
-- UBC COMMERCE HUB - ESQUEMA RELACIONAL DE PRODUCCIÓN (PostgreSQL 16+)
-- Cliente: University Bicycle Center (UBC)
-- Propuesta: TwoIT Solutions LLC
-- Propósito: Catálogo canónico unificado, inventario dual (físico vs virtual),
--            motor masivo de precios/campañas con protección MAP y margen,
--            conectores multi-distribuidor y máquina de estados Special Orders.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Función utilitaria para actualizar updated_at automáticamente
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- 1. SEGURIDAD, USUARIOS INTERNOS Y AUDITORÍA
-- ============================================================================

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(160) NOT NULL UNIQUE,
    full_name VARCHAR(140) NOT NULL,
    role VARCHAR(30) NOT NULL CHECK (role IN ('ADMIN', 'PURCHASING_MANAGER', 'STORE_STAFF', 'VIEWER')),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE audit_logs (
    id BIGSERIAL PRIMARY KEY,
    actor_user_id UUID REFERENCES users(id),
    actor_system VARCHAR(50), -- Ej: 'SHOPIFY_WEBHOOK', 'QBP_SYNC_WORKER', 'PRICE_CRON'
    entity_type VARCHAR(50) NOT NULL,
    entity_id VARCHAR(80) NOT NULL,
    action VARCHAR(60) NOT NULL,
    payload_before JSONB,
    payload_after JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_entity ON audit_logs(entity_type, entity_id, created_at DESC);

-- ============================================================================
-- 2. MARCAS, PROVEEDORES Y REGLAS DE CANAL / DERECHOS DE CATÁLOGO
-- ============================================================================

CREATE TABLE brands (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(120) NOT NULL UNIQUE,
    slug VARCHAR(120) NOT NULL UNIQUE,
    enforce_map BOOLEAN NOT NULL DEFAULT TRUE,
    allow_direct_shipping BOOLEAN NOT NULL DEFAULT TRUE, -- FALSE obliga In-Store Pickup (ej. marcas con restricción de envío)
    min_margin_pct NUMERIC(5,2) NOT NULL DEFAULT 15.00 CHECK (min_margin_pct >= 0 AND min_margin_pct < 100),
    lightspeed_manufacturer_id BIGINT UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE suppliers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(30) NOT NULL UNIQUE, -- 'QBP', 'JBI', 'SPECIALIZED'
    name VARCHAR(120) NOT NULL,
    connector_type VARCHAR(30) NOT NULL CHECK (connector_type IN ('REST_API', 'SFTP_CSV', 'SFTP_XML', 'EDI', 'CSG_B2B_API', 'MANUAL_IMPORT')),
    connection_mode VARCHAR(20) NOT NULL DEFAULT 'MOCK_READY'
        CHECK (connection_mode IN ('MOCK_READY', 'SANDBOX', 'LIVE')), -- Listo para enchufar credenciales reales
    endpoint_config JSONB NOT NULL DEFAULT '{}'::jsonb, -- Metadatos no sensibles (URL base, host SFTP, ruta feed, versión API)
    secret_ref VARCHAR(120),                            -- Referencia a variable/vault cifrado (ej. 'ENV:QBP_API_TOKEN')
    sync_interval_minutes INT NOT NULL DEFAULT 60,
    min_free_freight_usd NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    default_shipping_cost_usd NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    dropship_supported BOOLEAN NOT NULL DEFAULT FALSE,
    dropship_fee_usd NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    min_supplier_qty_threshold INT NOT NULL DEFAULT 2, -- Stock mínimo en proveedor para publicar como disponible online
    lead_time_days_min INT NOT NULL DEFAULT 2,
    lead_time_days_max INT NOT NULL DEFAULT 5,
    lightspeed_vendor_id BIGINT UNIQUE,
    last_healthcheck_at TIMESTAMPTZ,
    last_healthcheck_ok BOOLEAN,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Registro central Plug-and-Play de plataformas conectadas (Shopify Plus y Lightspeed R-Series)
CREATE TABLE platform_connections (
    platform_code VARCHAR(30) PRIMARY KEY CHECK (platform_code IN ('SHOPIFY_PLUS', 'LIGHTSPEED_R_SERIES')),
    display_name VARCHAR(100) NOT NULL,
    connection_mode VARCHAR(20) NOT NULL DEFAULT 'MOCK_READY'
        CHECK (connection_mode IN ('MOCK_READY', 'SANDBOX', 'LIVE')),
    settings JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Ejemplo SHOPIFY_PLUS: {"plan": "PLUS", "store_domain": "ubc.myshopify.com", "api_version": "2026-04", "delivery_customization_enabled": true}
    -- Ejemplo LIGHTSPEED_R_SERIES: {"account_id": null, "shop_id": 1, "leaky_bucket_max": 60}
    secret_ref VARCHAR(120),
    last_connected_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Permisos explícitos por combinación Proveedor + Marca (derechos de fotos, textos y venta web)
CREATE TABLE supplier_brand_permissions (
    supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
    brand_id UUID NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
    authorized_for_ecommerce BOOLEAN NOT NULL DEFAULT TRUE,
    authorized_media_usage BOOLEAN NOT NULL DEFAULT TRUE,
    routing_priority INT NOT NULL DEFAULT 100, -- Menor número = mayor preferencia manual
    PRIMARY KEY (supplier_id, brand_id)
);

-- ============================================================================
-- 3. CATÁLOGO CANÓNICO (PRODUCTOS PADRE Y VARIANTES / SKUS)
-- ============================================================================

CREATE TABLE products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id UUID REFERENCES brands(id),
    title VARCHAR(255) NOT NULL,
    slug VARCHAR(255) NOT NULL UNIQUE,
    description_html TEXT,
    product_type VARCHAR(100),        -- Ej: 'Complete Bike', 'Tire', 'Helmet', 'Drivetrain'
    category_path VARCHAR(255),       -- Ej: 'Bikes > Mountain > Full Suspension'
    tags TEXT[] DEFAULT '{}',
    images JSONB DEFAULT '[]'::jsonb, -- [{url, alt, position, source_supplier}]
    is_complete_bike BOOLEAN NOT NULL DEFAULT FALSE,
    oversized_shipping_fee NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    media_rights_verified BOOLEAN NOT NULL DEFAULT FALSE,
    lightspeed_matrix_id BIGINT UNIQUE,
    shopify_product_id BIGINT UNIQUE,
    status VARCHAR(20) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ACTIVE', 'ARCHIVED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE product_variants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    sku_internal VARCHAR(80) NOT NULL UNIQUE,
    upc VARCHAR(32),                  -- Clave universal de deduplicación (GTIN-12 / EAN-13 / GTIN-14)
    mpn VARCHAR(80),                  -- Manufacturer Part Number (respaldo de deduplicación)
    title VARCHAR(180),               -- Ej: 'Satin Carbon / S4'
    option1_name VARCHAR(50),         -- Ej: 'Size'
    option1_value VARCHAR(80),        -- Ej: 'S4' o '56cm'
    option2_name VARCHAR(50),         -- Ej: 'Color'
    option2_value VARCHAR(80),
    weight_grams INT,
    specs JSONB DEFAULT '{}'::jsonb,  -- {wheel_size: '29', frame_material: 'Carbon', groupset: 'SRAM GX AXS'}

    -- Vínculos con plataformas externas
    lightspeed_item_id BIGINT UNIQUE, -- NULL si es producto exclusivo de distribuidor aún no comprado (JIT)
    shopify_variant_id BIGINT UNIQUE,
    shopify_inventory_item_id BIGINT UNIQUE,

    -- Estructura financiera y de precios (USD)
    local_avg_cost NUMERIC(10,2),                   -- Costo contable proveniente de Lightspeed R-Series
    best_supplier_cost NUMERIC(10,2),               -- Mejor costo mayorista vigente entre distribuidores
    preferred_supplier_id UUID REFERENCES suppliers(id),
    msrp_price NUMERIC(10,2),
    map_price NUMERIC(10,2),                        -- Precio mínimo anunciado obligatorio
    base_price NUMERIC(10,2) NOT NULL,              -- Precio regular configurado en UBC
    effective_price NUMERIC(10,2) NOT NULL,         -- Precio vigente tras motor de campañas/reglas
    compare_at_price NUMERIC(10,2),                 -- Precio tachado en Shopify (si está en oferta)
    manual_price_override BOOLEAN NOT NULL DEFAULT FALSE,

    -- Modo de venta online
    fulfillment_policy VARCHAR(30) NOT NULL DEFAULT 'HYBRID_AUTO'
        CHECK (fulfillment_policy IN (
            'LOCAL_STOCK_ONLY',        -- Solo vende lo que hay físicamente en tienda
            'HYBRID_AUTO',             -- Vende stock local primero; si es 0, vende stock de distribuidor como Pedido Especial
            'SPECIAL_ORDER_ONLY',      -- Siempre genera Pedido Especial
            'IN_STORE_PICKUP_ONLY'     -- Compra online permitida únicamente con recogida en UBC
        )),
    is_published_shopify BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_variants_product_id ON product_variants(product_id);
CREATE INDEX idx_variants_upc ON product_variants(upc) WHERE upc IS NOT NULL;
CREATE INDEX idx_variants_mpn ON product_variants(mpn) WHERE mpn IS NOT NULL;
CREATE INDEX idx_variants_specs_gin ON product_variants USING GIN (specs);

-- ============================================================================
-- 4. INVENTARIO DUAL: STOCK FÍSICO (LIGHTSPEED) VS CATÁLOGOS DE DISTRIBUIDORES
-- ============================================================================

CREATE TABLE inventory_local (
    variant_id UUID PRIMARY KEY REFERENCES product_variants(id) ON DELETE CASCADE,
    qty_on_hand INT NOT NULL DEFAULT 0,
    qty_reserved_web INT NOT NULL DEFAULT 0,
    qty_safety_buffer INT NOT NULL DEFAULT 0,
    qty_sellable INT GENERATED ALWAYS AS (GREATEST(qty_on_hand - qty_reserved_web - qty_safety_buffer, 0)) STORED,
    reorder_point INT NOT NULL DEFAULT 0,
    last_ls_timestamp TIMESTAMPTZ,
    synced_to_shopify_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE supplier_catalog_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
    variant_id UUID REFERENCES product_variants(id) ON DELETE SET NULL,
    match_status VARCHAR(25) NOT NULL DEFAULT 'UNMATCHED'
        CHECK (match_status IN ('MATCHED_UPC', 'MATCHED_MPN', 'MATCHED_MANUAL', 'PENDING_REVIEW', 'UNMATCHED', 'REJECTED')),
    supplier_sku VARCHAR(80) NOT NULL,
    brand_raw VARCHAR(120),
    title_raw VARCHAR(255),
    upc VARCHAR(32),
    mpn VARCHAR(80),
    wholesale_cost NUMERIC(10,2) NOT NULL,
    msrp NUMERIC(10,2),
    map_price NUMERIC(10,2),
    qty_total_available INT NOT NULL DEFAULT 0,
    warehouse_stock JSONB DEFAULT '[]'::jsonb, -- [{warehouse_code: 'PA', qty: 12, transit_days: 2}, ...]
    is_discontinued BOOLEAN NOT NULL DEFAULT FALSE,
    dropship_eligible BOOLEAN NOT NULL DEFAULT FALSE,
    raw_hash CHAR(64) NOT NULL,                -- SHA-256 para procesar solo deltas reales
    last_feed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (supplier_id, supplier_sku)
);

CREATE INDEX idx_supplier_items_variant ON supplier_catalog_items(variant_id) WHERE variant_id IS NOT NULL;
CREATE INDEX idx_supplier_items_upc ON supplier_catalog_items(upc) WHERE upc IS NOT NULL;
CREATE INDEX idx_supplier_items_match_status ON supplier_catalog_items(match_status);

-- ============================================================================
-- 5. MOTOR DE PRECIOS MASIVOS, PROMOCIONES, PROTECCIÓN MAP Y SNAPSHOTS
-- ============================================================================

CREATE TABLE price_campaigns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(160) NOT NULL,
    description TEXT,
    campaign_scope VARCHAR(30) NOT NULL DEFAULT 'WEB_ONLY'
        CHECK (campaign_scope IN ('WEB_ONLY', 'OMNICHANNEL_EVENT')),
    event_tag VARCHAR(50), -- Ej: 'BLACK_FRIDAY', 'CHRISTMAS', 'SEASON_CLEARANCE', 'FLASH_ONLINE'
    status VARCHAR(25) NOT NULL DEFAULT 'DRAFT'
        CHECK (status IN ('DRAFT', 'SIMULATED', 'SCHEDULED', 'APPLYING', 'ACTIVE', 'RESTORING', 'COMPLETED', 'CANCELLED')),
    priority INT NOT NULL DEFAULT 100,
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ NOT NULL,
    -- Por defecto FALSE (solo online); se activa explícitamente (TRUE) para eventos especiales (Black Friday, Navidad, etc.)
    sync_to_lightspeed_pos BOOLEAN NOT NULL DEFAULT FALSE,
    filter_criteria JSONB NOT NULL,
    -- Ejemplo filter_criteria:
    -- {"brand_ids": [...], "categories": ["Helmets", "Tires"], "inventory_source": "LOCAL_IN_STOCK"}
    discount_rule JSONB NOT NULL,
    -- Ejemplo discount_rule:
    -- {"mode": "PERCENT_OFF", "value": 25.0, "respect_map": true, "min_margin_pct": 18.0, "rounding": ".99"}
    total_variants_matched INT NOT NULL DEFAULT 0,
    total_map_clamped INT NOT NULL DEFAULT 0,
    total_margin_clamped INT NOT NULL DEFAULT 0,
    created_by UUID REFERENCES users(id),
    approved_by UUID REFERENCES users(id),
    approved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (ends_at > starts_at)
);

CREATE TABLE price_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id UUID NOT NULL REFERENCES price_campaigns(id) ON DELETE CASCADE,
    variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
    cost_used NUMERIC(10,2) NOT NULL,
    prev_effective_price NUMERIC(10,2) NOT NULL,
    prev_compare_at_price NUMERIC(10,2),
    calculated_raw_price NUMERIC(10,2) NOT NULL,
    applied_effective_price NUMERIC(10,2) NOT NULL,
    applied_compare_at_price NUMERIC(10,2),
    projected_margin_usd NUMERIC(10,2) NOT NULL,
    projected_margin_pct NUMERIC(5,2) NOT NULL,
    clamped_by_map BOOLEAN NOT NULL DEFAULT FALSE,
    clamped_by_margin BOOLEAN NOT NULL DEFAULT FALSE,
    shopify_synced_at TIMESTAMPTZ,
    lightspeed_synced_at TIMESTAMPTZ,
    restored_at TIMESTAMPTZ,
    restore_skipped_reason VARCHAR(120), -- Si un admin editó manualmente el precio base durante la campaña
    UNIQUE (campaign_id, variant_id)
);

CREATE INDEX idx_snapshots_campaign ON price_snapshots(campaign_id);

-- ============================================================================
-- 6. ÓRDENES OMNICANAL Y MÁQUINA DE ESTADOS DE PEDIDOS ESPECIALES
-- ============================================================================

CREATE TABLE hub_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shopify_order_id BIGINT NOT NULL UNIQUE,
    shopify_order_name VARCHAR(32) NOT NULL, -- Ej: '#UBC-10482'
    lightspeed_sale_id BIGINT UNIQUE,
    customer_email VARCHAR(160),
    customer_name VARCHAR(160),
    customer_phone VARCHAR(50),
    delivery_method VARCHAR(30) NOT NULL CHECK (delivery_method IN ('SHIP_TO_HOME', 'IN_STORE_PICKUP')),
    currency CHAR(3) NOT NULL DEFAULT 'USD',
    total_amount NUMERIC(10,2) NOT NULL,
    contains_local_items BOOLEAN NOT NULL DEFAULT FALSE,
    contains_special_orders BOOLEAN NOT NULL DEFAULT FALSE,
    order_status VARCHAR(35) NOT NULL DEFAULT 'RECEIVED',
    raw_shopify_payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE special_order_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hub_order_id UUID NOT NULL REFERENCES hub_orders(id) ON DELETE CASCADE,
    shopify_line_item_id BIGINT NOT NULL UNIQUE,
    variant_id UUID NOT NULL REFERENCES product_variants(id),
    selected_supplier_id UUID NOT NULL REFERENCES suppliers(id),
    fallback_supplier_id UUID REFERENCES suppliers(id),
    quantity INT NOT NULL CHECK (quantity > 0),

    -- Control económico y protección de rentabilidad para Carlos Mirabal
    unit_sale_price NUMERIC(10,2) NOT NULL,
    expected_unit_cost NUMERIC(10,2) NOT NULL,
    verified_unit_cost NUMERIC(10,2),
    verified_supplier_stock INT,
    estimated_margin_pct NUMERIC(5,2) NOT NULL,
    cost_drift_detected BOOLEAN NOT NULL DEFAULT FALSE,

    -- Estado del flujo operativo
    state VARCHAR(35) NOT NULL CHECK (state IN (
        'DETECTED_SPECIAL_ORDER',
        'REVALIDATING_SUPPLIER',
        'PENDING_APPROVAL',
        'EXCEPTION_HOLD',          -- Sin stock en proveedor o subida abrupta de costo
        'APPROVED_PO_CREATED',     -- Item JIT + Purchase Order creados en Lightspeed
        'ORDERED_FROM_SUPPLIER',   -- Orden confirmada en portal/API de QBP/JBI/Specialized
        'IN_TRANSIT_TO_STORE',
        'DROPSHIPPED_TO_CUSTOMER',
        'RECEIVED_IN_LIGHTSPEED',  -- Recepción física confirmada en Lightspeed POS
        'READY_FOR_PICKUP',
        'COMPLETED',
        'CANCELLED_REFUNDED'
    )),

    -- Trazabilidad de compras y logística
    lightspeed_po_id BIGINT,
    supplier_order_number VARCHAR(80),
    carrier_name VARCHAR(60),
    tracking_number VARCHAR(100),
    eta_date DATE,

    -- Aprobación administrativa
    reviewed_by UUID REFERENCES users(id),
    reviewed_at TIMESTAMPTZ,
    internal_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_special_orders_state ON special_order_requests(state, created_at ASC);
CREATE INDEX idx_special_orders_supplier ON special_order_requests(selected_supplier_id, state);

-- Consolidación de compras (PO Batching para alcanzar envío gratis en QBP/JBI)
CREATE TABLE purchase_order_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    supplier_id UUID NOT NULL REFERENCES suppliers(id),
    lightspeed_po_id BIGINT UNIQUE,
    supplier_confirmation_ref VARCHAR(80),
    total_cost_usd NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    qualifies_free_freight BOOLEAN NOT NULL DEFAULT FALSE,
    status VARCHAR(30) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'SUBMITTED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED')),
    created_by UUID REFERENCES users(id),
    submitted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- 7. IDEMPOTENCIA DE WEBHOOKS Y MONITOREO DE INTEGRACIÓN
-- ============================================================================

CREATE TABLE processed_webhooks (
    webhook_id VARCHAR(120) PRIMARY KEY,
    source VARCHAR(30) NOT NULL CHECK (source IN ('SHOPIFY', 'LIGHTSPEED', 'SUPPLIER')),
    topic VARCHAR(80) NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processing_status VARCHAR(25) NOT NULL DEFAULT 'PROCESSED'
);

CREATE TABLE sync_incidents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_system VARCHAR(30) NOT NULL,
    severity VARCHAR(15) NOT NULL CHECK (severity IN ('INFO', 'WARNING', 'ERROR', 'CRITICAL')),
    incident_code VARCHAR(60) NOT NULL, -- Ej: 'LS_RATE_LIMIT_DELAY', 'MAP_CONFLICT', 'SUPPLIER_STOCK_ZERO'
    entity_type VARCHAR(40),
    entity_id VARCHAR(80),
    summary VARCHAR(255) NOT NULL,
    technical_detail JSONB,
    is_resolved BOOLEAN NOT NULL DEFAULT FALSE,
    resolved_by UUID REFERENCES users(id),
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sync_incidents_open ON sync_incidents(severity, created_at DESC) WHERE is_resolved = FALSE;

-- Triggers automáticos de updated_at
CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_brands_updated_at BEFORE UPDATE ON brands FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_suppliers_updated_at BEFORE UPDATE ON suppliers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_products_updated_at BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_variants_updated_at BEFORE UPDATE ON product_variants FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_inv_local_updated_at BEFORE UPDATE ON inventory_local FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_supplier_items_updated_at BEFORE UPDATE ON supplier_catalog_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_campaigns_updated_at BEFORE UPDATE ON price_campaigns FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_hub_orders_updated_at BEFORE UPDATE ON hub_orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_special_orders_updated_at BEFORE UPDATE ON special_order_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_platform_conn_updated_at BEFORE UPDATE ON platform_connections FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- 8. CONFIGURACIÓN INICIAL PLUG-AND-PLAY (LISTO PARA ENCHUFAR CREDENCIALES)
-- ============================================================================

INSERT INTO platform_connections (platform_code, display_name, connection_mode, settings, secret_ref)
VALUES
    ('SHOPIFY_PLUS', 'Shopify Plus Storefront & Functions', 'MOCK_READY',
     '{"plan": "PLUS", "api_version": "2026-04", "graphql_restore_pts_per_sec": 1000, "delivery_customization_function": true, "cart_validation_function": true}'::jsonb,
     'ENV:SHOPIFY_ADMIN_ACCESS_TOKEN'),
    ('LIGHTSPEED_R_SERIES', 'Lightspeed Retail R-Series POS', 'MOCK_READY',
     '{"api_version": "v3", "leaky_bucket_capacity": 60, "pos_price_sync_mode": "EVENT_OPT_IN"}'::jsonb,
     'ENV:LIGHTSPEED_OAUTH_REFRESH_TOKEN')
ON CONFLICT (platform_code) DO NOTHING;

INSERT INTO suppliers (code, name, connector_type, connection_mode, endpoint_config, secret_ref, sync_interval_minutes, min_free_freight_usd, dropship_supported, min_supplier_qty_threshold, lead_time_days_min, lead_time_days_max)
VALUES
    ('QBP', 'Quality Bicycle Products (QBP)', 'REST_API', 'MOCK_READY',
     '{"api_base_url": "https://api.qbp.com/v2", "supports_realtime_stock_check": true, "supports_automated_po": true}'::jsonb,
     'ENV:QBP_API_CREDENTIALS', 30, 500.00, TRUE, 2, 2, 4),
    ('JBI', 'J&B Importers (JBI)', 'SFTP_CSV', 'MOCK_READY',
     '{"sftp_host": "ftp.jbi.bike", "inventory_feed_path": "/feeds/inventory.csv", "catalog_feed_path": "/feeds/catalog_full.csv"}'::jsonb,
     'ENV:JBI_SFTP_CREDENTIALS', 60, 450.00, FALSE, 2, 2, 5),
    ('SPECIALIZED', 'Specialized Bicycle Components', 'CSG_B2B_API', 'MOCK_READY',
     '{"b2b_portal": "specialized-b2b", "click_and_collect_required_for_bikes": true, "enforce_strict_map": true}'::jsonb,
     'ENV:SPECIALIZED_B2B_CREDENTIALS', 60, 1000.00, FALSE, 1, 3, 6)
ON CONFLICT (code) DO NOTHING;
