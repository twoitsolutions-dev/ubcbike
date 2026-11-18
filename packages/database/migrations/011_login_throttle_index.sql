-- Fast per-account failed-login count (login throttle shared by every server process).
CREATE INDEX IF NOT EXISTS audit_log_login_failed_idx ON audit_log ((lower(detail->>'email')), created_at DESC) WHERE action = 'auth.login_failed';
