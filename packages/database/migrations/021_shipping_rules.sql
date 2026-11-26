ALTER TABLE company_settings
  ADD COLUMN IF NOT EXISTS shipping_rules JSONB NOT NULL DEFAULT '{}'::jsonb;
