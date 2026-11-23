-- LED Sign Studio: per-template sign fit (margins in px) so the ad can be nudged away
-- from edges the physical sign crops, or given more breathing room.
ALTER TABLE led_templates ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}'::jsonb;
