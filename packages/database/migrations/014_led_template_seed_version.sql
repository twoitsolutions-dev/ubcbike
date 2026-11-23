-- LED Sign Studio: version of UBC's default templates last copied for the company.
-- When the Hub ships a newer version, defaults nobody has edited (created_at = updated_at)
-- are refreshed to the new design; edited or deleted ones are left alone.
ALTER TABLE led_template_seeds ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
