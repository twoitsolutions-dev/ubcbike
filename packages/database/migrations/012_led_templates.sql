-- LED Sign Studio: templates the team saves from the Hub (214x112 street sign).
-- Built-in templates live in the admin code; this table only holds the ones users create.
CREATE TABLE IF NOT EXISTS led_templates (
  id          bigserial PRIMARY KEY,
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        text NOT NULL,
  slides      jsonb NOT NULL,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS led_templates_company_idx ON led_templates (company_id, updated_at DESC);
