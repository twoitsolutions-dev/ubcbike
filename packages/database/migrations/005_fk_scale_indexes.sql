-- UBC Commerce Hub — Complete Foreign-Key & High-Cardinality Scale Indexes (40K+ SKUs).
-- Prevents O(N^2) FK cascade/set-null scans on `supplier_offer_history`, `campaign_lines`,
-- `outbound_sync_staging`, `order_lines`, `match_reviews`, and `inventory_levels`.

CREATE INDEX IF NOT EXISTS supplier_offer_history_offer_idx
  ON supplier_offer_history (offer_id)
  WHERE offer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS outbound_sync_staging_variant_idx
  ON outbound_sync_staging (variant_id);

CREATE INDEX IF NOT EXISTS campaign_lines_variant_idx
  ON campaign_lines (variant_id);

CREATE INDEX IF NOT EXISTS match_reviews_company_all_idx
  ON match_reviews (company_id);

CREATE INDEX IF NOT EXISTS match_reviews_candidate_idx
  ON match_reviews (candidate_variant_id)
  WHERE candidate_variant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS inventory_levels_company_idx
  ON inventory_levels (company_id);

CREATE INDEX IF NOT EXISTS inventory_levels_location_idx
  ON inventory_levels (location_id);

CREATE INDEX IF NOT EXISTS map_exceptions_variant_idx
  ON map_exceptions (company_id, variant_id);

CREATE INDEX IF NOT EXISTS price_history_campaign_idx
  ON price_history (campaign_id)
  WHERE campaign_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS order_lines_order_idx
  ON order_lines (order_id);

CREATE INDEX IF NOT EXISTS order_lines_variant_idx
  ON order_lines (variant_id)
  WHERE variant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS purchase_order_lines_po_idx
  ON purchase_order_lines (purchase_order_id);
