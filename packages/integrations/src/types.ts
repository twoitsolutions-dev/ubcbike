import type { IntegrationStatus, IntegrationSystem } from '@ubc/shared';

export interface ConnectorHealth {
  system: IntegrationSystem;
  status: IntegrationStatus;
  /** Human readable, safe to show in the admin (never contains secrets). */
  detail: string;
  /** What is still needed before this connector can be used for real. */
  missing: string[];
  checkedAt: string;
  writesEnabled: boolean;
}

export class NotConfiguredError extends Error {
  readonly code = 'NOT_CONFIGURED';
  constructor(system: string, missing: string[]) {
    super(`${system} is not connected. Missing: ${missing.join(', ')}`);
    this.name = 'NotConfiguredError';
  }
}

export class WritesDisabledError extends Error {
  readonly code = 'WRITES_DISABLED';
  constructor(system: string) {
    super(`${system} write operations are disabled until tested and authorised`);
    this.name = 'WritesDisabledError';
  }
}

export class PendingVerificationError extends Error {
  readonly code = 'PENDING_VERIFICATION';
  constructor(system: string, what: string) {
    super(`${system}: ${what} has not been verified against the supplier's official documentation yet`);
    this.name = 'PendingVerificationError';
  }
}

export class RetryableError extends Error {
  readonly retryable = true;
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message);
    this.name = 'RetryableError';
  }
}

export interface SupplierCatalogRecord {
  supplierSku: string;
  brand: string;
  title: string;
  mpn: string | null;
  upc: string | null;
  category: string | null;
  costCents: number | null;
  msrpCents: number | null;
  mapCents: number | null;
  qtyAvailable: number;
  dropShip: boolean;
  leadDays: number;
  /** Whether the supplier licence lets us republish this record's images/descriptions. */
  contentLicensed: boolean;
  description?: string | null;
  images?: string[];
  optionValues?: Record<string, string>;
  matrixRef?: string | null;
}

export interface AvailabilityQuote {
  supplierSku: string;
  qtyAvailable: number;
  costCents: number | null;
  reportedAt: string;
}

export interface PurchaseOrderRequest {
  poNumber: string;
  idempotencyKey: string;
  shipTo: 'ubc_store' | 'customer';
  lines: { supplierSku: string; qty: number; expectedCostCents: number }[];
}

export interface PurchaseOrderResult {
  accepted: boolean;
  externalRef: string | null;
  message: string;
}

export type SupplierMethod = 'api' | 'catalog_feed' | 'csv' | 'xml' | 'sftp' | 'content_service' | 'via_lightspeed' | 'dealer_portal';

export interface SupplierConnector {
  readonly code: string;
  readonly methods: readonly SupplierMethod[];
  readonly capabilities: { catalog: boolean; availability: boolean; purchaseOrders: boolean };
  health(): Promise<ConnectorHealth>;
  fetchCatalog(cursor?: string): Promise<{ records: SupplierCatalogRecord[]; nextCursor: string | null }>;
  checkAvailability(skus: string[]): Promise<AvailabilityQuote[]>;
  /** Never called automatically: only after an explicit human approval. */
  submitPurchaseOrder(req: PurchaseOrderRequest): Promise<PurchaseOrderResult>;
}
