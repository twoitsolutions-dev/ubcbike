-- Read model used by listings, campaigns and the storefront feed.
-- Physical quantities come only from inventory_levels; supplier offers are a separate JSON array.
CREATE VIEW catalog_items AS
SELECT
  v.id,
  v.company_id,
  v.ref,
  v.product_id,
  p.ref                         AS product_ref,
  v.title,
  p.brand,
  p.model,
  p.category,
  v.sku,
  v.upc,
  v.mpn,
  v.price_cents,
  v.compare_at_cents,
  v.cost_cents,
  v.map_cents,
  p.map_policy,
  v.status,
  v.version,
  v.updated_at,
  COALESCE(inv.on_hand, 0)::int  AS physical_qty,
  COALESCE(inv.reserved, 0)::int AS reserved_qty,
  COALESCE(off.offers, '[]'::jsonb) AS offers,
  (SELECT e.external_id FROM external_ids e WHERE e.entity_type = 'variant' AND e.entity_id = v.id AND e.system = 'shopify') AS shopify_variant_id,
  (SELECT e.external_id FROM external_ids e WHERE e.entity_type = 'variant' AND e.entity_id = v.id AND e.system = 'lightspeed_r') AS lightspeed_item_id
FROM variants v
JOIN products p ON p.id = v.product_id
LEFT JOIN LATERAL (
  SELECT sum(il.on_hand) AS on_hand, sum(il.reserved) AS reserved
  FROM inventory_levels il WHERE il.variant_id = v.id
) inv ON true
LEFT JOIN LATERAL (
  SELECT jsonb_agg(jsonb_build_object(
    'supplierCode', s.code, 'supplierSku', so.supplier_sku, 'costCents', so.cost_cents,
    'qtyAvailable', so.qty_available, 'reportedAt', so.reported_at, 'dropShip', so.drop_ship, 'leadDays', so.lead_days
  ) ORDER BY so.cost_cents) AS offers
  FROM supplier_offers so JOIN suppliers s ON s.id = so.supplier_id AND s.is_active
  WHERE so.variant_id = v.id
) off ON true;

CREATE INDEX IF NOT EXISTS external_ids_entity_idx ON external_ids (entity_id, system);
CREATE INDEX IF NOT EXISTS variants_title_trgm_fallback_idx ON variants (company_id, lower(title));
