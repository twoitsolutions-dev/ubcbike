# Privacy Policy — BikeShop Sync (TwoIT Solutions LLC)

**Effective Date:** November 24, 2026  
**Provider:** TwoIT Solutions LLC ([https://www.twoitsolutions.com](https://www.twoitsolutions.com))  
**Public URL:** `https://ubc-hub.twoitsolutions.com/privacy`

## 1. Scope & Purpose
BikeShop Sync connects a merchant's Shopify store with Lightspeed R-Series POS and cycling supplier catalogs to manage inventory, MAP/margin rules, promotions, and special-order fulfillment.

## 2. Personal Data Processed
- **Customer Name (`first_name`, `last_name`):** Collected from Shopify order webhooks exclusively to identify special-order and in-store pickup tickets in the merchant's Hub.
- **Not Collected:** The Hub does not store customer emails, phone numbers, physical addresses, or payment credentials from Shopify orders.

## 3. Data Usage & No Third-Party Sharing
Customer names are used solely for store operations and order fulfillment. TwoIT Solutions LLC does not sell, rent, track, or use customer data for marketing or automated profiling.

## 4. Security Controls
- **Encryption:** TLS/HTTPS in transit; AES-256 encryption at rest and encrypted backups via Supabase PostgreSQL.
- **Access Control:** Mandatory login (`scrypt` hashing, minimum 12-character passwords), `httpOnly` session cookies, CSRF tokens, RBAC permissions, and strict `company_id` tenant isolation.
- **Auditability:** Order accesses (`order.viewed`) and order/catalog mutations are recorded in `audit_logs`.
- **Webhook Verification:** Shopify webhooks are verified via HMAC-SHA256.

## 5. Retention & Deletion
Data is retained while the merchant remains active on BikeShop Sync and is deleted upon merchant request or disconnection.
