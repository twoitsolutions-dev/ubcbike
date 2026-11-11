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
    items: (q) => req('GET', '/api/items' + qs(q)),
    facets: () => req('GET', '/api/items/facets'),
    item: (id) => req('GET', '/api/items/' + id),
    setPrice: (id, priceCents, version) => req('PATCH', '/api/items/' + id + '/price', { priceCents, version }),
    bulkStatus: (filter, status) => req('POST', '/api/items/bulk-status', { filter, status }),
    locations: () => req('GET', '/api/inventory/locations'),
    job: (id) => req('GET', '/api/jobs/' + id),
    jobs: (status) => req('GET', '/api/jobs' + qs({ status })),
    retryJob: (id) => req('POST', '/api/jobs/' + id + '/retry', {}),
    errors: () => req('GET', '/api/errors'),
    resolveError: (id) => req('POST', '/api/errors/' + id + '/resolve', {}),
    audit: () => req('GET', '/api/audit'),
    settings: () => req('GET', '/api/settings'),
    saveSettings: (s) => req('PUT', '/api/settings', s),
    campaigns: () => req('GET', '/api/campaigns'),
    createCampaign: (input) => req('POST', '/api/campaigns', input),
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
    matchReviews: () => req('GET', '/api/match-reviews'),
    resolveReview: (id, decision) => req('POST', '/api/match-reviews/' + id + '/resolve', { decision }),
    integrations: () => req('GET', '/api/integrations'),
    resetDemo: null,
  };
}
