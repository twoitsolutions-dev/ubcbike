-- UPC matches between Lightspeed items and the Shopify store are PROPOSED by the nightly job and
-- only take effect when someone (Carlos) approves them in the Hub ("UPC Matches" section).
--   add     = new Lightspeed item ↔ Shopify variant with the same UPC
--   repoint = an existing link whose UPC now belongs to a different Lightspeed item
--   remove  = an existing link whose UPC no longer matches (or the Shopify variant is gone)
CREATE TABLE IF NOT EXISTS upc_link_proposals (
  id                         bigserial PRIMARY KEY,
  company_id                 uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  shop_domain                text NOT NULL,
  kind                       text NOT NULL CHECK (kind IN ('add', 'repoint', 'remove')),
  variant_id                 uuid REFERENCES variants(id) ON DELETE CASCADE,
  old_variant_id             uuid REFERENCES variants(id) ON DELETE SET NULL,
  link_id                    bigint,
  shopify_variant_id         text NOT NULL,
  shopify_product_id         text,
  shopify_inventory_item_id  text,
  shopify_title              text,
  shopify_barcode            text,
  shopify_price_cents        integer,
  shopify_compare_at_cents   integer,
  status                     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'unlinked')),
  note                       text,
  decided_by                 uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at                 timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);
-- One open proposal per Shopify variant.
CREATE UNIQUE INDEX IF NOT EXISTS upc_link_proposals_pending_uq ON upc_link_proposals (company_id, shop_domain, shopify_variant_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS upc_link_proposals_status_idx ON upc_link_proposals (company_id, shop_domain, status, created_at DESC);
