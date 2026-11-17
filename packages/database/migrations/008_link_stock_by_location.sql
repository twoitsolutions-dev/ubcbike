-- Last on-hand quantity written/seen per Shopify location for each linked variant
-- ({"gid://shopify/Location/...": 4, ...}), so stock is pushed per physical store
-- (Lightspeed shop 1 Tampa, shop 2 Alafia) and only when it changed.
ALTER TABLE shopify_variant_links ADD COLUMN IF NOT EXISTS last_qty_by_location jsonb NOT NULL DEFAULT '{}'::jsonb;
