CREATE TABLE IF NOT EXISTS shopify_unlinked_upc_reports (
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  shop_domain TEXT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  report JSONB NOT NULL,
  PRIMARY KEY (company_id, shop_domain)
);
