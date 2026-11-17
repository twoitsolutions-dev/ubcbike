-- UBC Commerce Hub — 40K+ SKU Scale Indexing, Universal Catalog Metadata & Incremental POS Cursor.
-- Strictly additive migration (never edits 001–003).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 1. Rich universal catalog fields on supplier_offers (category, description, images, options, matrix grouping)
ALTER TABLE supplier_offers ADD COLUMN IF NOT EXISTS category text;
ALTER TABLE supplier_offers ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
ALTER TABLE supplier_offers ADD COLUMN IF NOT EXISTS images jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE supplier_offers ADD COLUMN IF NOT EXISTS option_values jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE supplier_offers ADD COLUMN IF NOT EXISTS matrix_ref text;

-- 2. Incremental sync cursor & telemetry on integration_connections (for Lightspeed R-Series delta syncs)
ALTER TABLE integration_connections ADD COLUMN IF NOT EXISTS sync_cursor text;
ALTER TABLE integration_connections ADD COLUMN IF NOT EXISTS last_synced_at timestamptz;
ALTER TABLE integration_connections ADD COLUMN IF NOT EXISTS records_synced integer NOT NULL DEFAULT 0;

-- 3. Functional B-tree indexes for O(log N) normalized GTIN & MPN matching across 40,000+ SKUs
CREATE INDEX IF NOT EXISTS variants_norm_upc_idx
  ON variants (company_id, ltrim(upc, '0'))
  WHERE upc IS NOT NULL AND upc <> '';

CREATE INDEX IF NOT EXISTS variants_norm_mpn_idx
  ON variants (company_id, upper(regexp_replace(mpn, '[^A-Za-z0-9]', '', 'g')))
  WHERE mpn IS NOT NULL AND mpn <> '';

CREATE INDEX IF NOT EXISTS supplier_offers_unmatched_idx
  ON supplier_offers (company_id, supplier_id)
  WHERE variant_id IS NULL;

CREATE INDEX IF NOT EXISTS match_reviews_pending_idx
  ON match_reviews (company_id, score DESC, id)
  WHERE status = 'pending';

-- 4. GIN Trigram indexes for <15ms substring search across 40,000+ titles, brands, SKUs & MPNs
CREATE INDEX IF NOT EXISTS products_title_trgm_idx
  ON products USING gin (lower(title) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS products_brand_trgm_idx
  ON products USING gin (lower(brand) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS variants_title_trgm_idx
  ON variants USING gin (lower(title) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS variants_sku_trgm_idx
  ON variants USING gin (lower(sku) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS variants_mpn_trgm_idx
  ON variants USING gin (lower(mpn) gin_trgm_ops)
  WHERE mpn IS NOT NULL;

CREATE INDEX IF NOT EXISTS supplier_offers_title_trgm_idx
  ON supplier_offers USING gin (lower(title) gin_trgm_ops);
