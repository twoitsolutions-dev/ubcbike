-- Server-only OAuth token vault for providers with rotating refresh tokens (Lightspeed Retail R-Series V3).
-- Never exposed via any public or admin HTTP endpoint; read/written exclusively by backend workers & CLI.

CREATE TABLE IF NOT EXISTS integration_oauth_tokens (
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  system         text NOT NULL,
  client_id      text,
  client_secret  text,
  account_id     text,
  refresh_token  text NOT NULL,
  access_token   text,
  expires_at     timestamptz,
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, system)
);
