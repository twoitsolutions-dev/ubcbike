-- Per-store links between Hub variants (Lightspeed items) and the variants that already exist in a
-- Shopify store whose catalog is owned by another app (UBC's real store: catalog from the Workstand app).
-- In SHOPIFY_SYNC_MODE=update_only the Hub never creates products there: it only updates price,
-- sale price (compare-at) and stock of the variants linked here (matched by barcode).

CREATE TABLE IF NOT EXISTS shopify_variant_links (
  id                         bigserial PRIMARY KEY,
  company_id                 uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  shop_domain                text NOT NULL,
  variant_id                 uuid NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  shopify_product_id         text NOT NULL,
  shopify_variant_id         text NOT NULL,
  shopify_inventory_item_id  text,
  match_method               text NOT NULL DEFAULT 'barcode',
  last_price_cents           integer,
  last_compare_at_cents      integer,
  last_qty                   integer,
  last_pushed_at             timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, shop_domain, shopify_variant_id)
);
CREATE INDEX IF NOT EXISTS shopify_variant_links_variant_idx ON shopify_variant_links (company_id, shop_domain, variant_id);

-- Every price the Hub writes to a Shopify store, with the value it replaced (for audits and rollback).
CREATE TABLE IF NOT EXISTS shopify_price_log (
  id                     bigserial PRIMARY KEY,
  company_id             uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  shop_domain            text NOT NULL,
  variant_id             uuid REFERENCES variants(id) ON DELETE SET NULL,
  shopify_variant_id     text NOT NULL,
  old_price_cents        integer,
  old_compare_at_cents   integer,
  new_price_cents        integer NOT NULL,
  new_compare_at_cents   integer,
  source                 text NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shopify_price_log_variant_idx ON shopify_price_log (company_id, shop_domain, shopify_variant_id, created_at DESC);
