import { describe, expect, it } from 'vitest';
import {
  LightspeedRClient, liveQbp, mapFeed, mapLsItem, MockSupplierConnector, NotConfiguredError, parseCsv,
  priceToCents, ShopifyAdminApi, ShopifyAdminClient, signShopifyWebhook, verifyShopifyWebhook, WritesDisabledError,
} from './index.js';

describe('shopify webhook HMAC', () => {
  const secret = 'test_secret';
  const body = JSON.stringify({ id: 1, name: '#1001' });
  it('accepts a valid signature and rejects tampering', () => {
    const sig = signShopifyWebhook(body, secret);
    expect(verifyShopifyWebhook(body, sig, secret)).toBe(true);
    expect(verifyShopifyWebhook(body + ' ', sig, secret)).toBe(false);
    expect(verifyShopifyWebhook(body, sig, 'other')).toBe(false);
    expect(verifyShopifyWebhook(body, undefined, secret)).toBe(false);
    expect(verifyShopifyWebhook(body, 'short', secret)).toBe(false);
  });
  it('parses money strings without float error', () => {
    expect(priceToCents('19.99')).toBe(1999);
    expect(priceToCents('1250')).toBe(125000);
    expect(priceToCents('0.1')).toBe(10);
  });
});

describe('shopify client', () => {
  it('reports not_connected without credentials and never calls the network', async () => {
    const c = new ShopifyAdminClient({ fetchImpl: () => { throw new Error('network!'); } });
    expect((await c.health()).status).toBe('not_connected');
    await expect(c.query('{ shop { name } }')).rejects.toBeInstanceOf(NotConfiguredError);
  });

  it('blocks mutations while writes are disabled', async () => {
    const c = new ShopifyAdminClient({ shopDomain: 'x.myshopify.com', accessToken: 't', fetchImpl: async () => new Response('{}') });
    const api = new ShopifyAdminApi(c);
    await expect(api.updateVariantPrices('gid://shopify/Product/1', [{ variantId: 'v', priceCents: 100, compareAtCents: null }]))
      .rejects.toBeInstanceOf(WritesDisabledError);
  });

  it('retries on THROTTLED and sends the pinned version', async () => {
    let calls = 0;
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      calls++;
      if (calls === 1) return new Response(JSON.stringify({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] }));
      return new Response(JSON.stringify({ data: { shop: { name: 'Dev Store' } } }));
    }) as unknown as typeof fetch;
    const c = new ShopifyAdminClient({ shopDomain: 'x.myshopify.com', accessToken: 't', apiVersion: '2026-10', fetchImpl });
    const h = await c.health();
    expect(h.status).toBe('connected');
    expect(urls[0]).toBe('https://x.myshopify.com/admin/api/2026-10/graphql.json');
  }, 10000);
});

describe('lightspeed R-Series', () => {
  it('is not connected without OAuth authorisation', async () => {
    const c = new LightspeedRClient({});
    const h = await c.health();
    expect(h.status).toBe('not_connected');
    expect(h.missing.join(' ')).toMatch(/REFRESH_TOKEN/);
    await expect(c.put()).rejects.toBeInstanceOf(WritesDisabledError);
  });

  it('refreshes the token, paginates with @attributes.next and maps items', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push(url);
      if (url.includes('token')) {
        expect(String(init?.body)).toContain('grant_type=refresh_token');
        return new Response(JSON.stringify({ access_token: 'abc', expires_in: 3600 }));
      }
      if (url.includes('page2')) return new Response(JSON.stringify({ '@attributes': {}, Item: { itemID: '2', description: 'Tube', ItemShops: { ItemShop: { shopID: '1', qoh: '4' } } } }));
      return new Response(JSON.stringify({
        '@attributes': { next: 'https://api.example/page2' },
        Item: [{ itemID: '1', description: 'Helmet', upc: '036000291452', customSku: 'UBC-1', manufacturerSku: 'BL-1', defaultCost: '50.00',
          Prices: { ItemPrice: [{ amount: '99.99', useType: 'Default' }, { amount: '89.99', useType: 'MSRP' }] },
          ItemShops: { ItemShop: [{ shopID: '0', qoh: '7' }, { shopID: '1', qoh: '3' }, { shopID: '2', qoh: '4' }] } }],
      }));
    }) as unknown as typeof fetch;
    const c = new LightspeedRClient({ clientId: 'id', clientSecret: 's', refreshToken: 'r', accountId: '123', fetchImpl });
    const pages = [];
    for await (const p of c.iterateItems()) pages.push(p);
    expect(pages).toHaveLength(2);
    expect(seen[1]).toContain('/Account/123/Item.json');
    const m = mapLsItem(pages[0]![0]!);
    expect(m).toMatchObject({ lightspeedItemId: '1', priceCents: 9999, costCents: 5000, physicalQty: 7, sku: 'UBC-1', mpn: 'BL-1' });
    expect(mapLsItem(pages[0]![0]!, ['1']).physicalQty).toBe(3);
  });
});

describe('supplier feeds and connectors', () => {
  it('parses quoted CSV', () => {
    expect(parseCsv('a,b\r\n"x, y","he said ""hi"""\n')).toEqual([['a', 'b'], ['x, y', 'he said "hi"']]);
  });

  it('maps a feed and reports bad rows', () => {
    const csv = 'Item,Brand,Description,UPC,Cost,Qty\nQ1,Bell,"Helmet, M",036000291452,$45.50,10\n,Bell,No sku,,1,1\nQ3,Giro,Bad,,2,-4\n';
    const { records, errors } = mapFeed(csv, { supplierSku: 'Item', brand: 'Brand', title: 'Description', upc: 'UPC', cost: 'Cost', qty: 'Qty' }, { contentLicensed: false, defaultLeadDays: 4 });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ supplierSku: 'Q1', costCents: 4550, qtyAvailable: 10, leadDays: 4, contentLicensed: false });
    expect(errors.map((e) => e.line)).toEqual([3, 4]);
    expect(() => mapFeed('x,y\n1,2', { supplierSku: 'Item', brand: 'Brand', title: 'Description' }, { contentLicensed: false, defaultLeadDays: 1 })).toThrow(/missing required/);
  });

  it('demo connector purchase orders are idempotent', async () => {
    const m = new MockSupplierConnector('QBP', ['api']);
    const req = { poNumber: 'PO-1', idempotencyKey: 'k1', shipTo: 'ubc_store' as const, lines: [] };
    const a = await m.submitPurchaseOrder(req);
    const b = await m.submitPurchaseOrder(req);
    expect(a).toEqual(b);
    expect(m.submittedCount()).toBe(1);
    expect((await m.health()).status).toBe('demo_adapter');
  });

  it('live QBP stays Not Connected and refuses to call unverified endpoints', async () => {
    const q = liveQbp({});
    expect((await q.health()).status).toBe('not_connected');
    await expect(q.checkAvailability()).rejects.toBeInstanceOf(NotConfiguredError);
    const configured = liveQbp({ QBP_API_KEY: 'k', QBP_API_BASE_URL: 'https://x', QBP_ACCOUNT_NUMBER: '1' });
    expect((await configured.health()).status).toBe('configured');
    await expect(configured.fetchCatalog()).rejects.toThrow(/not been verified/);
  });
});
