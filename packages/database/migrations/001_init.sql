-- UBC Commerce Hub — initial schema.
-- Multi-tenant by company_id from day one: every business table carries it,
-- and every query in the API is scoped by the session's company.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE companies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE stores (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name                text NOT NULL,
  shopify_shop_domain text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);

CREATE TABLE locations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  store_id              uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name                  text NOT NULL,
  -- physical = stock owned by the shop. Supplier availability is NEVER stored here.
  kind                  text NOT NULL CHECK (kind IN ('physical')),
  lightspeed_shop_id    text,
  shopify_location_id   text,
  UNIQUE (company_id, name)
);

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL,
  name           text NOT NULL,
  password_hash  text NOT NULL,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TABLE memberships (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('owner','admin','purchasing','staff','viewer')),
  PRIMARY KEY (user_id, company_id)
);

CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   text NOT NULL UNIQUE,
  csrf_token   text NOT NULL,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  ip           text,
  user_agent   text
);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE products (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  ref          text NOT NULL,           -- stable human reference, e.g. p0001
  brand        text NOT NULL,
  model        text NOT NULL,
  category     text NOT NULL,
  title        text NOT NULL,
  description  text NOT NULL DEFAULT '',
  images       jsonb NOT NULL DEFAULT '[]',
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('published','hidden','draft')),
  map_policy   text NOT NULL DEFAULT 'none' CHECK (map_policy IN ('none','map','umap')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, ref)
);
CREATE INDEX products_company_cat_idx ON products (company_id, category);
CREATE INDEX products_company_brand_idx ON products (company_id, brand);

CREATE TABLE variants (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id        uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  ref               text NOT NULL,
  title             text NOT NULL,
  sku               text NOT NULL,
  upc               text,
  mpn               text,
  option_values     jsonb NOT NULL DEFAULT '{}',
  price_cents       integer NOT NULL CHECK (price_cents > 0),
  compare_at_cents  integer CHECK (compare_at_cents IS NULL OR compare_at_cents > 0),
  cost_cents        integer CHECK (cost_cents IS NULL OR cost_cents >= 0),
  map_cents         integer CHECK (map_cents IS NULL OR map_cents > 0),
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('published','hidden','draft')),
  version           integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, sku),
  UNIQUE (company_id, ref)
);
CREATE INDEX variants_product_idx ON variants (product_id);
CREATE INDEX variants_upc_idx ON variants (company_id, upc) WHERE upc IS NOT NULL;
CREATE INDEX variants_mpn_idx ON variants (company_id, mpn) WHERE mpn IS NOT NULL;
CREATE INDEX variants_price_idx ON variants (company_id, price_cents);

-- External identities (Shopify GIDs, Lightspeed itemIDs, supplier SKUs mapped to our variants).
CREATE TABLE external_ids (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  entity_type  text NOT NULL CHECK (entity_type IN ('product','variant','order','location')),
  entity_id    uuid NOT NULL,
  system       text NOT NULL,
  external_id  text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, system, entity_type, external_id),
  UNIQUE (company_id, system, entity_type, entity_id)
);

-- Physical stock owned by the company, per physical location.
CREATE TABLE inventory_levels (
  variant_id   uuid NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  location_id  uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  on_hand      integer NOT NULL DEFAULT 0,
  reserved     integer NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  source       text NOT NULL DEFAULT 'manual',  -- lightspeed_r | manual | demo
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (variant_id, location_id)
);

CREATE TABLE suppliers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code        text NOT NULL,
  name        text NOT NULL,
  connector   text NOT NULL,
  methods     text[] NOT NULL DEFAULT '{}',
  notes       text NOT NULL DEFAULT '',
  is_active   boolean NOT NULL DEFAULT true,
  -- Non-secret settings only (lead-time defaults, column mappings...). Secrets live in env/secret manager.
  settings    jsonb NOT NULL DEFAULT '{}',
  UNIQUE (company_id, code)
);

-- What a supplier says it can sell us. Separate from physical inventory by design.
CREATE TABLE supplier_offers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  supplier_id      uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  variant_id       uuid REFERENCES variants(id) ON DELETE SET NULL,
  supplier_sku     text NOT NULL,
  brand            text NOT NULL DEFAULT '',
  title            text NOT NULL DEFAULT '',
  upc              text,
  mpn              text,
  cost_cents       integer,
  msrp_cents       integer,
  map_cents        integer,
  qty_available    integer NOT NULL DEFAULT 0,
  drop_ship        boolean NOT NULL DEFAULT false,
  lead_days        integer NOT NULL DEFAULT 5,
  content_licensed boolean NOT NULL DEFAULT false,
  reported_at      timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, supplier_id, supplier_sku)
);
CREATE INDEX supplier_offers_variant_idx ON supplier_offers (variant_id);

CREATE TABLE match_reviews (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  offer_id              uuid NOT NULL REFERENCES supplier_offers(id) ON DELETE CASCADE,
  candidate_variant_id  uuid REFERENCES variants(id) ON DELETE CASCADE,
  score                 numeric(4,3) NOT NULL,
  reasons               jsonb NOT NULL DEFAULT '[]',
  status                text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  resolved_by           uuid REFERENCES users(id),
  resolved_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (offer_id, candidate_variant_id)
);

CREATE TABLE company_settings (
  company_id   uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  campaign_rules      jsonb NOT NULL,
  availability_rules  jsonb NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE map_exceptions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  variant_id   uuid NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  approved_by  text NOT NULL,      -- vendor representative / document owner
  reference    text NOT NULL,      -- e.g. email or agreement id
  valid_until  timestamptz NOT NULL,
  note         text NOT NULL DEFAULT '',
  recorded_by  uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE campaigns (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name          text NOT NULL,
  status        text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','scheduled','applying','active','restoring','restored','cancelled','failed')),
  channel       text NOT NULL DEFAULT 'online' CHECK (channel IN ('online','online_and_pos')),
  selection     jsonb NOT NULL,
  adjustment    jsonb NOT NULL,
  rules         jsonb NOT NULL,
  strategy      text CHECK (strategy IN ('shopify_automatic_discount','variant_price_update')),
  starts_at     timestamptz,
  ends_at       timestamptz,
  summary       jsonb,
  shopify_discount_id text,
  created_by    uuid NOT NULL REFERENCES users(id),
  approved_by   uuid REFERENCES users(id),
  approved_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX campaigns_schedule_idx ON campaigns (status, starts_at, ends_at);

CREATE TABLE campaign_lines (
  campaign_id      uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  variant_id       uuid NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  old_price_cents  integer NOT NULL,
  new_price_cents  integer NOT NULL,
  cost_cents       integer,
  map_cents        integer,
  status           text NOT NULL CHECK (status IN ('ok','warning','blocked','excluded')),
  reasons          jsonb NOT NULL DEFAULT '[]',
  applied_at       timestamptz,
  restore_result   text CHECK (restore_result IN ('restored','skipped_changed','skipped_not_applied')),
  restored_at      timestamptz,
  PRIMARY KEY (campaign_id, variant_id)
);

CREATE TABLE price_history (
  id               bigserial PRIMARY KEY,
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  variant_id       uuid NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  old_price_cents  integer NOT NULL,
  new_price_cents  integer NOT NULL,
  source           text NOT NULL CHECK (source IN ('manual','campaign','restore','sync')),
  campaign_id      uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  actor_user_id    uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX price_history_variant_idx ON price_history (variant_id, created_at DESC);

CREATE TABLE orders (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  store_id              uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  shopify_order_id      text,
  number                text NOT NULL,
  customer_name         text NOT NULL DEFAULT '',  -- minimal PII; card data never touches us
  fulfillment_method    text NOT NULL CHECK (fulfillment_method IN ('pickup','ship')),
  financial_status      text NOT NULL DEFAULT 'pending',
  shopify_fulfillment_status text NOT NULL DEFAULT 'unfulfilled',
  internal_status       text NOT NULL DEFAULT 'new_order',
  is_special_order      boolean NOT NULL DEFAULT false,
  exception_reason      text,
  total_cents           integer NOT NULL DEFAULT 0,
  tracking              text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, shopify_order_id)
);
CREATE INDEX orders_company_status_idx ON orders (company_id, internal_status);

CREATE TABLE order_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  variant_id    uuid REFERENCES variants(id) ON DELETE SET NULL,
  sku           text NOT NULL,
  title         text NOT NULL,
  qty           integer NOT NULL CHECK (qty > 0),
  price_cents   integer NOT NULL,
  source        text NOT NULL CHECK (source IN ('ubc_stock','supplier','unfulfillable')),
  supplier_id   uuid REFERENCES suppliers(id),
  quoted_cost_cents integer
);

CREATE TABLE order_events (
  id           bigserial PRIMARY KEY,
  order_id     uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_status  text,
  to_status    text NOT NULL,
  actor        text NOT NULL,
  note         text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE purchase_orders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  supplier_id      uuid NOT NULL REFERENCES suppliers(id),
  order_id         uuid REFERENCES orders(id) ON DELETE SET NULL,
  po_number        text NOT NULL,
  status           text NOT NULL DEFAULT 'awaiting_approval'
                   CHECK (status IN ('awaiting_approval','approved','submitted','confirmed','in_transit','received','cancelled','exception')),
  ship_to          text NOT NULL DEFAULT 'ubc_store' CHECK (ship_to IN ('ubc_store','customer')),
  total_cents      integer NOT NULL DEFAULT 0,
  idempotency_key  text NOT NULL,
  external_ref     text,
  tracking         text,
  approved_by      uuid REFERENCES users(id),
  approved_at      timestamptz,
  submitted_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, po_number),
  UNIQUE (company_id, idempotency_key)
);

CREATE TABLE purchase_order_lines (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id    uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  order_line_id        uuid REFERENCES order_lines(id) ON DELETE SET NULL,
  supplier_sku         text NOT NULL,
  qty                  integer NOT NULL CHECK (qty > 0),
  expected_cost_cents  integer NOT NULL
);

-- Inbound events (webhooks, sync pulls). idempotency_key prevents double processing.
CREATE TABLE sync_events (
  id               bigserial PRIMARY KEY,
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source           text NOT NULL,
  topic            text NOT NULL,
  idempotency_key  text NOT NULL,
  payload          jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'received' CHECK (status IN ('received','processed','failed','ignored')),
  error            text,
  received_at      timestamptz NOT NULL DEFAULT now(),
  processed_at     timestamptz,
  UNIQUE (company_id, source, idempotency_key)
);

-- Durable job queue (Postgres, FOR UPDATE SKIP LOCKED).
CREATE TABLE jobs (
  id               bigserial PRIMARY KEY,
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  type             text NOT NULL,
  payload          jsonb NOT NULL DEFAULT '{}',
  status           text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','dead')),
  attempts         integer NOT NULL DEFAULT 0,
  max_attempts     integer NOT NULL DEFAULT 5,
  run_at           timestamptz NOT NULL DEFAULT now(),
  locked_at        timestamptz,
  locked_by        text,
  progress         jsonb,
  result           jsonb,
  last_error       text,
  idempotency_key  text,
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  UNIQUE (company_id, idempotency_key)
);
CREATE INDEX jobs_ready_idx ON jobs (status, run_at) WHERE status = 'queued';

CREATE TABLE integration_connections (
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  system          text NOT NULL,
  status          text NOT NULL DEFAULT 'not_connected',
  detail          text NOT NULL DEFAULT '',
  missing         jsonb NOT NULL DEFAULT '[]',
  writes_enabled  boolean NOT NULL DEFAULT false,
  last_checked_at timestamptz,
  PRIMARY KEY (company_id, system)
);

CREATE TABLE error_log (
  id           bigserial PRIMARY KEY,
  company_id   uuid REFERENCES companies(id) ON DELETE CASCADE,
  source       text NOT NULL,
  message      text NOT NULL,
  context      jsonb NOT NULL DEFAULT '{}',
  job_id       bigint REFERENCES jobs(id) ON DELETE SET NULL,
  resolved_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX error_log_open_idx ON error_log (company_id, created_at DESC) WHERE resolved_at IS NULL;

CREATE TABLE audit_log (
  id              bigserial PRIMARY KEY,
  company_id      uuid REFERENCES companies(id) ON DELETE CASCADE,
  actor_user_id   uuid REFERENCES users(id),
  action          text NOT NULL,
  entity_type     text,
  entity_id       text,
  detail          jsonb NOT NULL DEFAULT '{}',
  ip              text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_company_idx ON audit_log (company_id, created_at DESC);
