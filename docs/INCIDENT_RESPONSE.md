# Security Incident Response Policy — BikeShop Sync (TwoIT Solutions LLC)

**Effective Date:** November 24, 2026  
**Owner:** TwoIT Solutions LLC

## 1. Purpose
Define the steps TwoIT Solutions LLC follows to detect, contain, investigate, and notify merchants in the event of a suspected or confirmed security incident affecting BikeShop Sync.

## 2. Roles & Responsibilities
- **Incident Lead (TwoIT Solutions LLC):** Triages alerts, revokes compromised credentials, patches vulnerabilities, and coordinates merchant communication.
- **Merchant Contact:** Receives timely notification if their `company_id` data or Shopify/Lightspeed tokens are affected.

## 3. Response Phases
1. **Detection & Triage:** Monitor `error_log`, `audit_logs`, Hostinger runtime logs, and Supabase auth/DB logs for unauthorized access, webhook signature failures, or anomalous API activity.
2. **Containment:** Immediately rotate affected API credentials (`CLIENT_SECRET`, Lightspeed refresh tokens, `DATABASE_URL`), invalidate active sessions, and set `SHOPIFY_WRITES_ENABLED=false` / `LIGHTSPEED_WRITES_ENABLED=false` if write integrity is at risk.
3. **Eradication & Recovery:** Patch the root cause, verify data integrity from encrypted Supabase backups if needed, and re-enable services after verification.
4. **Notification:** Notify affected merchants (and Shopify Partner Support if Shopify Protected Customer Data is impacted) within **72 hours** of confirming a breach, detailing what happened, affected data, and remediation steps.
5. **Post-Incident Review:** Document root cause and preventive controls in the repository/audit trail.
