// HTTP driver: talks to the UBC Integration Engine API on the same origin.
// Authentication is an httpOnly session cookie; writes carry the CSRF token.

export class ApiError extends Error {
  constructor(status, body) {
    super((body && body.message) || 'Request failed (' + status + ')');
    this.status = status;
    this.code = body && body.error;
    this.details = body && body.details;
  }
}

function qs(params) {
  const out = [];
  Object.keys(params || {}).forEach((k) => {
    const v = params[k];
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) return;
    out.push(encodeURIComponent(k) + '=' + encodeURIComponent(Array.isArray(v) ? v.join(',') : String(v)));
  });
  return out.length ? '?' + out.join('&') : '';
}

export function createHttpDriver() {
  let csrf = null;

  async function req(method, url, body) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && csrf) headers['X-CSRF-Token'] = csrf;
    const res = await fetch(url, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
    const type = res.headers.get('content-type') || '';
    const data = type.includes('application/json') ? await res.json() : await res.text();
    if (!res.ok) throw new ApiError(res.status, typeof data === 'object' ? data : { message: data });
    return data;
  }

  return {
    kind: 'http',
    async login(email, password) { const r = await req('POST', '/api/auth/login', { email, password }); csrf = r.csrfToken; return r; },
    async me() { const r = await req('GET', '/api/auth/me'); csrf = r.csrfToken; return r; },
    logout: () => req('POST', '/api/auth/logout', {}),
    system: () => req('GET', '/api/system'),
    dashboard: () => req('GET', '/api/dashboard'),
    reportsCollectionGap: (refresh) => req('GET', '/api/reports/collections-gap' + (refresh ? '?refresh=1' : '')),
    reportsNoUpc: () => req('GET', '/api/reports/no-upc'),
    reportsMarginIssues: () => req('GET', '/api/reports/margin-issues'),
    reportsSalesProfitability: (days) => req('GET', '/api/reports/sales-profitability' + qs({ days })),
    refreshSkuIndex: () => req('POST', '/api/shopify/refresh-sku-index', {}),
    items: (q) => req('GET', '/api/items' + qs(q)),
    lightspeedSheet: (q) => req('GET', '/api/lightspeed/sheet' + qs(q)),
    lightspeedSetMode: (paused) => req('POST', '/api/lightspeed/mode', { paused }),
    lightspeedBulkUpdate: (changes) => req('POST', '/api/lightspeed/bulk-update', { changes }),
    facets: () => req('GET', '/api/items/facets'),
    item: (id) => req('GET', '/api/items/' + id),
    setPrice: (id, priceCents, version) => req('PATCH', '/api/items/' + id + '/price', { priceCents, version }),
    bulkStatus: (filter, status) => req('POST', '/api/items/bulk-status', { filter, status }),
    locations: () => req('GET', '/api/inventory/locations'),
    job: (id) => req('GET', '/api/jobs/' + id),
    jobs: (status) => req('GET', '/api/jobs' + qs({ status })),
    retryJob: (id) => req('POST', '/api/jobs/' + id + '/retry', {}),
    upcReview: (status, kind) => req('GET', '/api/upc-review' + qs({ status, kind })),
    decideUpc: (ids, decision) => req('POST', '/api/upc-review/decide', { ids, decision }),
    decideAllUpc: (decision, kind) => req('POST', '/api/upc-review/decide', { all: true, decision, kind: kind || undefined }),
    runUpcMatch: () => req('POST', '/api/upc-review/run', {}),
    createShopifyProduct: (input) => req('POST', '/api/shopify/products/from-items', input),
    errors: () => req('GET', '/api/errors'),
    resolveError: (id) => req('POST', '/api/errors/' + id + '/resolve', {}),
    audit: () => req('GET', '/api/audit'),
    settings: () => req('GET', '/api/settings'),
    saveSettings: (s) => req('PUT', '/api/settings', s),
    ledTemplates: () => req('GET', '/api/led-templates'),
    createLedTemplate: (t) => req('POST', '/api/led-templates', t),
    updateLedTemplate: (id, t) => req('PUT', '/api/led-templates/' + id, t),
    deleteLedTemplate: (id) => req('DELETE', '/api/led-templates/' + id),
    campaigns: () => req('GET', '/api/campaigns'),
    createCampaign: (input) => req('POST', '/api/campaigns', input),
    updateCampaign: (id, input) => req('PATCH', '/api/campaigns/' + id, input),
    campaign: (id) => req('GET', '/api/campaigns/' + id),
    campaignLines: (id, status, offset, limit) => req('GET', '/api/campaigns/' + id + '/lines' + qs({ status, offset, limit })),
    previewCampaign: (id) => req('POST', '/api/campaigns/' + id + '/preview', {}),
    approveCampaign: (id, previewToken) => req('POST', '/api/campaigns/' + id + '/approve', { previewToken }),
    restoreCampaign: (id) => req('POST', '/api/campaigns/' + id + '/restore', {}),
    cancelCampaign: (id) => req('POST', '/api/campaigns/' + id + '/cancel', {}),
    exportCampaign: (id) => req('GET', '/api/campaigns/' + id + '/export.csv'),
    mapException: (body) => req('POST', '/api/map-exceptions', body),
    orders: (q) => req('GET', '/api/orders' + qs(q)),
    order: (id) => req('GET', '/api/orders/' + id),
    transition: (id, body) => req('POST', '/api/orders/' + id + '/transition', body),
    purchaseOrders: () => req('GET', '/api/purchase-orders'),
    checkout: (body) => req('POST', '/api/demo/checkout', body),
    suppliers: () => req('GET', '/api/suppliers'),
    supplierOffers: (code, q) => req('GET', '/api/suppliers/' + encodeURIComponent(code) + '/offers' + qs(q)),
    importFeed: (code, body) => req('POST', '/api/suppliers/' + encodeURIComponent(code) + '/import', body),
    importFeedChunk: (code, body) => req('POST', '/api/suppliers/' + encodeURIComponent(code) + '/import-chunk', body),
    promoteSupplierOffers: (code, body) => req('POST', '/api/suppliers/' + encodeURIComponent(code) + '/promote', body || {}),
    matchReviews: (q) => req('GET', '/api/match-reviews' + qs(q)),
    resolveReview: (id, decision) => req('POST', '/api/match-reviews/' + id + '/resolve', { decision }),
    pipelineStatus: () => req('GET', '/api/pipeline/status'),
    pipelineStaging: (q) => req('GET', '/api/pipeline/staging' + qs(q)),
    pipelineHistory: (q) => req('GET', '/api/pipeline/offer-history' + qs(q)),
    resolveStaging: (id, action, note) => req('POST', '/api/pipeline/staging/' + id + '/resolve', { action, note }),
    flushPipeline: () => req('POST', '/api/pipeline/flush', {}),
    runWatchdog: () => req('POST', '/api/pipeline/watchdog', {}),
    syncShopify: () => req('POST', '/api/shopify/sync', {}),
    setupShopifyMetafields: () => req('POST', '/api/shopify/setup-metafields', {}),
    setupShopifyCollections: () => req('POST', '/api/shopify/setup-collections', {}),
    syncLightspeed: (body) => req('POST', '/api/lightspeed/sync', body || {}),
    lightspeedOAuthUrl: (write) => req('GET', '/api/lightspeed/oauth/url' + (write ? '?write=1' : '')),
    integrations: () => req('GET', '/api/integrations'),
    resetDemo: null,
  };
}
