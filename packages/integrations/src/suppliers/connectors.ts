import type { IntegrationSystem } from '@ubc/shared';
import {
  NotConfiguredError, PendingVerificationError,
  type AvailabilityQuote, type ConnectorHealth, type PurchaseOrderRequest, type PurchaseOrderResult,
  type SupplierCatalogRecord, type SupplierConnector, type SupplierMethod,
} from '../types.js';

/**
 * DEMO supplier adapter. Deterministic, in-memory, clearly labelled.
 * Used in DEMO mode and in tests. It simulates latency, partial stock,
 * cost drift and connection failures so the workflows can be exercised.
 */
export class MockSupplierConnector implements SupplierConnector {
  readonly capabilities = { catalog: true, availability: true, purchaseOrders: true };
  private readonly submitted = new Map<string, PurchaseOrderResult>();
  failNext = 0;

  constructor(
    readonly code: string,
    readonly methods: readonly SupplierMethod[],
    private readonly catalog: SupplierCatalogRecord[] = [],
  ) {}

  async health(): Promise<ConnectorHealth> {
    return {
      system: this.code.toLowerCase() as IntegrationSystem,
      status: 'demo_adapter',
      detail: 'Simulated DEMO adapter — no real connection to the supplier',
      missing: ['Real supplier credentials and dealer authorisation'],
      checkedAt: new Date().toISOString(),
      writesEnabled: false,
    };
  }

  async fetchCatalog(cursor?: string) {
    const start = Number(cursor ?? 0);
    const page = this.catalog.slice(start, start + 500);
    return { records: page, nextCursor: start + 500 < this.catalog.length ? String(start + 500) : null };
  }

  async checkAvailability(skus: string[]): Promise<AvailabilityQuote[]> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error(`${this.code} demo adapter: simulated connection error`);
    }
    const now = new Date().toISOString();
    return skus.map((s) => {
      const rec = this.catalog.find((r) => r.supplierSku === s);
      return { supplierSku: s, qtyAvailable: rec?.qtyAvailable ?? 0, costCents: rec?.costCents ?? null, reportedAt: now };
    });
  }

  async submitPurchaseOrder(req: PurchaseOrderRequest): Promise<PurchaseOrderResult> {
    // Idempotent: the same key always returns the same result and never creates a second PO.
    const prev = this.submitted.get(req.idempotencyKey);
    if (prev) return prev;
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error(`${this.code} demo adapter: simulated connection error`);
    }
    const result = { accepted: true, externalRef: `${this.code}-DEMO-${req.poNumber}`, message: 'Simulated acceptance (DEMO — nothing was ordered)' };
    this.submitted.set(req.idempotencyKey, result);
    return result;
  }

  submittedCount() {
    return this.submitted.size;
  }
}

interface LiveSupplierConfig {
  code: 'QBP' | 'JBI' | 'SPECIALIZED';
  system: IntegrationSystem;
  methods: SupplierMethod[];
  required: Record<string, string | undefined>;
  /** What is still unknown about the official interface. */
  pendingVerification: string[];
}

/**
 * LIVE supplier connector skeleton. It refuses to run until credentials are
 * configured AND the endpoint contract has been verified with the supplier.
 * We deliberately do not hard-code endpoints from unofficial sources.
 */
export class LiveSupplierConnector implements SupplierConnector {
  readonly capabilities = { catalog: true, availability: true, purchaseOrders: false };
  constructor(private readonly cfg: LiveSupplierConfig) {}

  get code() { return this.cfg.code; }
  get methods() { return this.cfg.methods; }

  private missing() {
    return Object.entries(this.cfg.required).filter(([, v]) => !v).map(([k]) => k);
  }

  async health(): Promise<ConnectorHealth> {
    const missing = this.missing();
    return {
      system: this.cfg.system,
      status: missing.length ? 'not_connected' : 'configured',
      detail: missing.length
        ? 'Not connected — supplier credentials not provided'
        : 'Credentials present; endpoint contract pending verification with supplier',
      missing: [...missing, ...this.cfg.pendingVerification],
      checkedAt: new Date().toISOString(),
      writesEnabled: false,
    };
  }

  private guard(what: string): never {
    const missing = this.missing();
    if (missing.length) throw new NotConfiguredError(this.cfg.code, missing);
    throw new PendingVerificationError(this.cfg.code, what);
  }

  async fetchCatalog(): Promise<{ records: SupplierCatalogRecord[]; nextCursor: string | null }> { return this.guard('catalog endpoint'); }
  async checkAvailability(): Promise<AvailabilityQuote[]> { return this.guard('availability endpoint'); }
  async submitPurchaseOrder(): Promise<PurchaseOrderResult> { return this.guard('purchase order endpoint'); }
}

export function liveQbp(env: Record<string, string | undefined>) {
  return new LiveSupplierConnector({
    code: 'QBP', system: 'qbp', methods: ['api', 'catalog_feed'],
    required: { QBP_API_KEY: env.QBP_API_KEY, QBP_API_BASE_URL: env.QBP_API_BASE_URL, QBP_ACCOUNT_NUMBER: env.QBP_ACCOUNT_NUMBER },
    pendingVerification: ['QBP API documentation from QBP (not publicly published)', 'Content/image licence terms for republishing'],
  });
}

export function liveJbi(env: Record<string, string | undefined>) {
  return new LiveSupplierConnector({
    code: 'JBI', system: 'jbi', methods: ['catalog_feed', 'dealer_portal'],
    required: { JBI_ACCOUNT_NUMBER: env.JBI_ACCOUNT_NUMBER, JBI_FEED_URL: env.JBI_FEED_URL, JBI_FEED_CREDENTIAL: env.JBI_FEED_CREDENTIAL },
    pendingVerification: ['J&B data feed / API access method and format', 'Content licence terms'],
  });
}

export function liveSpecialized(env: Record<string, string | undefined>) {
  return new LiveSupplierConnector({
    code: 'SPECIALIZED', system: 'specialized', methods: ['dealer_portal'],
    required: { SPECIALIZED_DEALER_ID: env.SPECIALIZED_DEALER_ID, SPECIALIZED_API_CREDENTIAL: env.SPECIALIZED_API_CREDENTIAL },
    pendingVerification: ['Specialized authorised-dealer data access program', 'Online sale rules for bikes/e-bikes, MAP and image usage'],
  });
}
