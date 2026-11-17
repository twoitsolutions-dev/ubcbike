-- UBC Commerce Hub — Intermediary Engine (Middleware Core).
-- Multi-tenant by company_id from day one so TwoIT Solutions can operate
-- multiple independent bike/retail stores on the same platform.
--
-- Implements:
--  1. supplier_offer_history : Versioned history of supplier cost/MAP/MSRP/qty
--     changes alongside the exact retail price published on Shopify at that moment.
--  2. outbound_sync_staging  : Processing buffer ("margen de procesamiento")
--     that validates MAP, margin floors and content rights before pushing to Shopify.
--  3. supplier_sync_schedules: Differentiated sync frequencies per supplier and
--     stream (15–30m availability, 6–12h costs, 24h content, event full_catalog).
--  4. supplier_sync_runs     : Observability log + feed watchdog heartbeat state.

CREATE TABLE supplier_offer_history (
  id                            bigserial PRIMARY KEY,
  company_id                    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  supplier_id                   uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  offer_id                      uuid REFERENCES supplier_offers(id) ON DELETE SET NULL,
  variant_id                    uuid REFERENCES variants(id) ON DELETE SET NULL,
  supplier_sku                  text NOT NULL,
  change_types                  jsonb NOT NULL DEFAULT '[]',
  old_cost_cents                integer,
  new_cost_cents                integer,
  old_map_cents                 integer,
  new_map_cents                 integer,
  old_msrp_cents                integer,
  new_msrp_cents                integer,
  old_qty                       integer,
  new_qty                       integer NOT NULL,
  shopify_published_price_cents integer,
  resulting_margin_bps          integer,
  recorded_at                   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX supplier_offer_history_company_idx ON supplier_offer_history (company_id, recorded_at DESC);
CREATE INDEX supplier_offer_history_variant_idx ON supplier_offer_history (variant_id, recorded_at DESC) WHERE variant_id IS NOT NULL;
CREATE INDEX supplier_offer_history_supplier_idx ON supplier_offer_history (supplier_id, recorded_at DESC);

CREATE TABLE outbound_sync_staging (
  id              bigserial PRIMARY KEY,
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  store_id        uuid REFERENCES stores(id) ON DELETE CASCADE,
  variant_id      uuid NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  stream          text NOT NULL CHECK (stream IN ('availability','costs','content','full_catalog')),
  decision        text NOT NULL CHECK (decision IN ('ready_for_shopify','held_for_review')),
  hold_reasons    jsonb NOT NULL DEFAULT '[]',
  shopify_payload jsonb NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','pushed','held','dismissed')),
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  pushed_at       timestamptz,
  UNIQUE (company_id, variant_id, stream)
);
CREATE INDEX outbound_sync_staging_ready_idx ON outbound_sync_staging (company_id, status, decision) WHERE status IN ('pending','held');

CREATE TABLE supplier_sync_schedules (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  supplier_id       uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  stream            text NOT NULL CHECK (stream IN ('availability','costs','content','full_catalog')),
  interval_minutes  integer CHECK (interval_minutes IS NULL OR interval_minutes > 0),
  max_silence_hours integer NOT NULL DEFAULT 48 CHECK (max_silence_hours > 0),
  enabled           boolean NOT NULL DEFAULT true,
  last_run_at       timestamptz,
  last_success_at   timestamptz,
  last_status       text NOT NULL DEFAULT 'idle' CHECK (last_status IN ('idle','running','succeeded','failed','stalled')),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, supplier_id, stream)
);

CREATE TABLE supplier_sync_runs (
  id              bigserial PRIMARY KEY,
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  supplier_id     uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  stream          text NOT NULL CHECK (stream IN ('availability','costs','content','full_catalog')),
  status          text NOT NULL CHECK (status IN ('running','succeeded','failed')),
  records_seen    integer NOT NULL DEFAULT 0,
  records_changed integer NOT NULL DEFAULT 0,
  staged_ready    integer NOT NULL DEFAULT 0,
  staged_held     integer NOT NULL DEFAULT 0,
  error           text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);
CREATE INDEX supplier_sync_runs_company_idx ON supplier_sync_runs (company_id, started_at DESC);

-- Backfill default differentiated sync cadences for any existing suppliers.
INSERT INTO supplier_sync_schedules (company_id, supplier_id, stream, interval_minutes, max_silence_hours)
SELECT s.company_id, s.id, c.stream, c.interval_minutes, c.max_silence_hours
FROM suppliers s
CROSS JOIN (
  VALUES
    ('availability', 20,   2),
    ('costs',        540,  24),
    ('content',      1440, 48),
    ('full_catalog', NULL, 48)
) AS c(stream, interval_minutes, max_silence_hours)
ON CONFLICT (company_id, supplier_id, stream) DO NOTHING;
