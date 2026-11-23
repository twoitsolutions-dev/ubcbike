-- LED Sign Studio: UBC's default templates are copied into led_templates once per company,
-- so the team can edit, rename or delete every template (full CRUD). This row records
-- that the copy happened, so deleted defaults do not come back on their own.
CREATE TABLE IF NOT EXISTS led_template_seeds (
  company_id  uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  seeded_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE led_templates ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 1000;
