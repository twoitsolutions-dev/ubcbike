-- Track the most recent sale timestamp (from Lightspeed POS SaleLines and/or Hub orders)
-- per variant so Days Without Sales and the Lightspeed Bulk Sheet show real POS aging.
ALTER TABLE variants
  ADD COLUMN IF NOT EXISTS last_sold_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_variants_company_last_sold_at
  ON variants (company_id, last_sold_at);
