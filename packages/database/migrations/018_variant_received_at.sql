-- Store Lightspeed Item createTime / inventory received timestamp on variants
-- so Days Without Sales reflects real Lightspeed inventory age even before first sale sync.
ALTER TABLE variants ADD COLUMN IF NOT EXISTS received_at timestamptz;
