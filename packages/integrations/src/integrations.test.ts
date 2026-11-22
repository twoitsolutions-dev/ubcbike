import { describe, expect, it } from 'vitest';
import {
  detectDelimiter, inferFeedMapping, LightspeedRClient, liveJbi, liveQbp, liveSpecialized, mapFeed,
  mapLsItem, mapLsSpecialOrder, MockShopifyAdmin, MockSupplierConnector, normalizeCyclingCategory,
  NotConfiguredError, parseCsv, priceToCents, ShopifyAdminApi, ShopifyAdminClient, signShopifyWebhook,
  verifyShopifyWebhook, WritesDisabledError, lsOptionValues, lsMatrixBaseTitle,
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

describe('shopify client (2026 Dev Dashboard OAuth + Shopify Plus)', () => {
  it('reports not_connected without credentials and never calls the network', async () => {
    const c = new ShopifyAdminClient({ fetchImpl: () => { throw new Error('network!'); } });
    const h = await c.health();
    expect(h.status).toBe('not_connected');
    expect(h.detail).toContain('Shopify Plus');
    await expect(c.query('{ shop { name } }')).rejects.toBeInstanceOf(NotConfiguredError);
  });

  it('exchanges Dev Dashboard client_credentials, caches 24h token, normalizes shop domain, and auto-refreshes on HTTP 401', async () => {
    let tokenCalls = 0;
    let gqlCalls = 0;
    const seenTokens: string[] = [];

    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.endsWith('/admin/oauth/access_token')) {
        tokenCalls++;
        expect(url).toBe('https://0v2m1m-hh.myshopify.com/admin/oauth/access_token');
        const bodyStr = String(init?.body ?? '');
        expect(bodyStr).toContain('grant_type=client_credentials');
        expect(bodyStr).toContain('client_id=dev_client_id');
        expect(bodyStr).toContain('client_secret=shpss_secret');
        return new Response(JSON.stringify({
          access_token: `shpua_token_${tokenCalls}`,
          expires_in: 86399,
          scope: 'read_products,read_inventory,read_locations,read_orders',
        }));
      }
      gqlCalls++;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seenTokens.push(headers['X-Shopify-Access-Token'] ?? '');

      // Simulate early token revocation on the 3rd GraphQL call to verify 1x 401 auto-refresh
      if (gqlCalls === 3) {
        return new Response('Unauthorized', { status: 401 });
      }
      return new Response(JSON.stringify({
        data: { shop: { name: 'Mi tienda', plan: { displayName: 'Trial', shopifyPlus: false } } },
      }));
    }) as unknown as typeof fetch;

    const c = new ShopifyAdminClient({
      shopDomain: 'https://0v2m1m-hh.myshopify.com/',
      clientId: 'dev_client_id',
      clientSecret: 'shpss_secret',
      plan: 'trial',
      fetchImpl,
    });
    expect(c.shopDomain).toBe('0v2m1m-hh.myshopify.com');

    // Call 1: acquires shpua_token_1 and runs health()
    const h = await c.health();
    expect(h.status).toBe('connected');
    expect(h.detail).toContain('Mi tienda');
    expect(h.detail).toContain('plan: Trial');
    expect(h.detail).toContain('Dev Dashboard OAuth auto-refresh');
    expect(tokenCalls).toBe(1);

    // Call 2: reuses cached shpua_token_1 without hitting /admin/oauth/access_token again
    await c.query('{ shop { name } }');
    expect(tokenCalls).toBe(1);

    // Call 3: receives HTTP 401 -> refreshes to shpua_token_2 and retries automatically
    await c.query('{ shop { name } }');
    expect(tokenCalls).toBe(2);
    expect(seenTokens).toEqual(['shpua_token_1', 'shpua_token_1', 'shpua_token_1', 'shpua_token_2']);
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
    const c = new ShopifyAdminClient({ shopDomain: 'x.myshopify.com', accessToken: 't', apiVersion: '2026-10', plan: 'plus', fetchImpl });
    const h = await c.health();
    expect(h.status).toBe('connected');
    expect(h.detail).toContain('Shopify Plus');
    expect(urls[0]).toBe('https://x.myshopify.com/admin/api/2026-10/graphql.json');
  }, 10000);

  it('writes fulfillment and Click & Collect metafields when writes are enabled', async () => {
    const mock = new MockShopifyAdmin();
    await mock.setVariantFulfillmentMetafields([
      { variantId: 'gid://shopify/ProductVariant/1', availability: 'special_order', leadTimeDays: 5, clickAndCollectOnly: true },
    ]);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toMatchObject({ op: 'setVariantFulfillmentMetafields' });
  });

  it('lists locations & variants (with unitCost, compareAtPrice, inventory) in read-only mode and sets metafield defs when writes enabled', async () => {
    const seenOps: string[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { query: string };
      seenOps.push(body.query.trim().slice(0, 30));
      if (body.query.includes('ListLocations')) {
        return new Response(JSON.stringify({ data: { locations: { nodes: [{ id: 'gid://shopify/Location/1', name: 'UBC Main Store', isActive: true }] } } }));
      }
      if (body.query.includes('ListVariants')) {
        return new Response(JSON.stringify({
          data: {
            productVariants: {
              pageInfo: { hasNextPage: false, endCursor: 'c1' },
              nodes: [{
                id: 'gid://shopify/ProductVariant/100',
                sku: 'UBC-BIKE-1',
                barcode: '036000291452',
                price: '1299.99',
                compareAtPrice: '1499.99',
                displayName: 'Specialized Allez — M',
                inventoryQuantity: 2,
                inventoryPolicy: 'DENY',
                inventoryItem: { id: 'gid://shopify/InventoryItem/200', unitCost: { amount: '780.00' } },
                product: { id: 'gid://shopify/Product/50', title: 'Specialized Allez', status: 'ACTIVE', vendor: 'Specialized', productType: 'Bikes' },
              }],
            },
          },
        }));
      }
      if (body.query.includes('CreateUbcMetafieldDefinition')) {
        return new Response(JSON.stringify({
          data: { metafieldDefinitionCreate: { createdDefinition: null, userErrors: [{ code: 'TAKEN', message: 'Key is in use' }] } },
        }));
      }
      if (body.query.includes('SetOnHandInventory')) {
        return new Response(JSON.stringify({ data: { inventorySetQuantities: { userErrors: [] } } }));
      }
      return new Response(JSON.stringify({ data: {} }));
    }) as unknown as typeof fetch;

    // Read-only client works for catalog & location bootstrap!
    const roClient = new ShopifyAdminClient({ shopDomain: 'ubc.myshopify.com', accessToken: 'shpat_test', writesEnabled: false, fetchImpl });
    const roApi = new ShopifyAdminApi(roClient);
    const locs = await roApi.listLocations();
    expect(locs).toEqual([{ id: 'gid://shopify/Location/1', name: 'UBC Main Store', isActive: true }]);
    const page = await roApi.listVariants(null);
    expect(page.variants[0]).toMatchObject({
      variantId: 'gid://shopify/ProductVariant/100',
      inventoryItemId: 'gid://shopify/InventoryItem/200',
      priceCents: 129999,
      compareAtCents: 149999,
      unitCostCents: 78000,
      inventoryQuantity: 2,
      productStatus: 'ACTIVE',
    });

    // Write-enabled client handles metafield definitions idempotently and sets inventory.
    const rwClient = new ShopifyAdminClient({ shopDomain: 'ubc.myshopify.com', accessToken: 'shpat_test', writesEnabled: true, fetchImpl });
    const rwApi = new ShopifyAdminApi(rwClient);
    const defs = await rwApi.ensureUbcMetafieldDefinitions();
    expect(defs.existing).toEqual(['ubc.availability', 'ubc.lead_time_days', 'ubc.click_and_collect_only']);
    await rwApi.setInventoryOnHand('gid://shopify/Location/1', [{ inventoryItemId: 'gid://shopify/InventoryItem/200', quantity: 2 }]);
    expect(seenOps.length).toBe(6);
  });
});

describe('lightspeed R-Series (Physical Store POS)', () => {
  it('is not connected without OAuth authorisation and blocks generic put()', async () => {
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
        Item: [{ itemID: '1', description: 'Helmet', upc: '036000291452', systemSku: '210000000283', customSku: 'UBC-1', manufacturerSku: 'BL-1', defaultCost: '50.00',
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
    expect(m).toMatchObject({
      lightspeedItemId: '1',
      priceCents: 9999,
      costCents: 5000,
      physicalQty: 7,
      shopQuantities: { '1': 3, '2': 4 },
      sku: '210000000283', // System ID, never the Custom SKU
      mpn: 'BL-1',
    });
    expect(mapLsItem(pages[0]![0]!, ['1']).physicalQty).toBe(3);

    // Real UBC Lightspeed R-Series edge case: Default = regular price, SALE PRICE = active sale price (ignoring stale Online!), $0 cost -> null
    const ubcItem = mapLsItem({
      itemID: '53887',
      description: 'SHOE SPZ SW TORCH RD SHOE BLK 44',
      defaultCost: '0',
      avgCost: '0',
      Manufacturer: { name: 'SPECIALIZED' },
      Category: { fullPathName: 'APPAREL/SHOES' },
      Prices: {
        ItemPrice: [
          { amount: '499.99', useType: 'Default' },
          { amount: '399.99', useType: 'SALE PRICE' },
          { amount: '475', useType: 'Online' },
        ],
      },
      ItemShops: { ItemShop: [{ shopID: '0', qoh: '1' }, { shopID: '1', qoh: '1' }, { shopID: '2', qoh: '0' }] },
    });
    expect(ubcItem).toMatchObject({
      brand: 'SPECIALIZED',
      rawCategory: 'APPAREL/SHOES',
      priceCents: 39999,
      compareAtCents: 49999,
      defaultPriceCents: 49999,
      salePriceCents: 39999,
      costCents: null,
      physicalQty: 1,
      shopQuantities: { '1': 1, '2': 0 },
    });
  });

  it('allows POS price updates strictly for authorised omnichannel events when enabled', async () => {
    const disabledClient = new LightspeedRClient({ clientId: 'id', clientSecret: 's', refreshToken: 'r', accountId: '123' });
    await expect(disabledClient.updateEventPosPrices([{ lightspeedItemId: '10', priceCents: 7999 }]))
      .rejects.toBeInstanceOf(WritesDisabledError);

    const puts: { url: string; body: string }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.includes('token')) return new Response(JSON.stringify({ access_token: 'abc', expires_in: 3600 }));
      puts.push({ url, body: String(init?.body ?? '') });
      return new Response('{}', { status: 200, headers: { 'X-LS-API-Bucket-Level': '5/60' } });
    }) as unknown as typeof fetch;

    const eventClient = new LightspeedRClient({
      clientId: 'id', clientSecret: 's', refreshToken: 'r', accountId: '123',
      posEventWritesEnabled: true, fetchImpl,
    });
    await eventClient.updateEventPosPrices([{ lightspeedItemId: '10', priceCents: 7999, regularPriceCents: 9999 }]);
    expect(puts).toHaveLength(1);
    expect(puts[0]?.url).toContain('/Account/123/Item/10.json');
    expect(puts[0]?.body).toContain('"amount":"79.99"');
    expect(puts[0]?.body).toContain('"useType":"SALE PRICE"');
    expect(puts[0]?.body).toContain('"amount":"99.99"');

    // On restore back to regular price, SALE PRICE is cleared to "0" and Default restored
    await eventClient.updateEventPosPrices([{ lightspeedItemId: '10', priceCents: 9999, regularPriceCents: null }]);
    expect(puts[1]?.body).toContain('"amount":"99.99","useType":"Default"');
    expect(puts[1]?.body).toContain('"amount":"0","useType":"SALE PRICE"');
  });
});

describe('supplier feeds and connectors (QBP, JBI, Specialized)', () => {
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

  it('live QBP, JBI and Specialized stay Not Connected without env vars and refuse unverified endpoints', async () => {
    const q = liveQbp({});
    expect((await q.health()).status).toBe('not_connected');
    await expect(q.checkAvailability()).rejects.toBeInstanceOf(NotConfiguredError);
    const configured = liveQbp({ QBP_API_KEY: 'k', QBP_API_BASE_URL: 'https://x', QBP_ACCOUNT_NUMBER: '1' });
    expect((await configured.health()).status).toBe('configured');
    await expect(configured.fetchCatalog()).rejects.toThrow(/not been verified/);

    expect((await liveJbi({}).health()).status).toBe('not_connected');
    expect((await liveSpecialized({}).health()).status).toBe('not_connected');
  });

  it('auto-detects TSV/semicolon/pipe feeds, infers vendor headers, normalizes cycling categories, and handles $0.00 MAP & 10+ stock', () => {
    const tsv = [
      'Item_Number\tManufacturer\tItem_Description\tMfg_Part_No\tBarcode\tDepartment\tDealer_Net\tMAP_Price\tMSRP\tAvail_Qty\tFrame_Size\tColorway\tModel_Code',
      'QBP-901\tContinental\tGrand Prix 5000 S TR Tire 700x28\t0101866\t4019238054408\tTIRES/CLINCHER\t$54.00\t$0.00\t$95.99\t10+\t700x28c\tBlack/Transparent\tGP5000-STR',
      'QBP-902\tSpecialized\tTurbo Vado 4.0 Step-Through E-Bike\t97822-5003\t888818765430\tCOMPLETE BIKES\t$2,100.00\t$3,249.99\t$3,249.99\tIn Stock\tM\tCast Umber\tTURBO-VADO-4',
    ].join('\n');

    expect(detectDelimiter(tsv)).toBe('\t');
    const inferred = inferFeedMapping(parseCsv(tsv)[0]!);
    expect(inferred.supplierSku).toBe('Item_Number');
    expect(inferred.brand).toBe('Manufacturer');
    expect(inferred.cost).toBe('Dealer_Net');
    expect(inferred.map).toBe('MAP_Price');

    // Zero manual mapping passed -> auto-inferred completely!
    const { records, errors } = mapFeed(tsv, undefined, { contentLicensed: true, defaultLeadDays: 4 });
    expect(errors).toHaveLength(0);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      supplierSku: 'QBP-901',
      brand: 'Continental',
      category: 'Tires & Tubes',
      costCents: 5400,
      mapCents: null, // $0.00 MAP safely normalized to null!
      msrpCents: 9599,
      qtyAvailable: 10,
      optionValues: { Size: '700x28c', Color: 'Black/Transparent' },
      matrixRef: 'GP5000-STR',
    });
    expect(records[1]).toMatchObject({
      supplierSku: 'QBP-902',
      category: 'Electric Bikes',
      costCents: 210000,
      mapCents: 324999,
      qtyAvailable: 5,
    });
    expect(normalizeCyclingCategory('HELMETS', 'Giro Aries Spherical MIPS')).toBe('Helmets & Safety');
    expect(normalizeCyclingCategory('BIKES/ELECTRIC/COMFORT / ROAD', 'BIKE JUPITER DEFIANT BLK')).toBe('Electric Bikes');
    expect(normalizeCyclingCategory('BIKES/ELECTRIC/MOUNTAIN', 'BIKE 26 SPEC LEVO SWRKS CARBON G4 S3')).toBe('Electric Bikes');
    expect(normalizeCyclingCategory('PARTS/MOTORS', 'EBIKE *JUPITER DISPLAY FOR DISCOVERY X5/X7')).toBe('Parts & Components');
    expect(normalizeCyclingCategory('PARTS/EBIKE PARTS', 'EBIKE *CHARGER PLUG ADAPTER FOR JUPITER')).toBe('Parts & Components');
    expect(normalizeCyclingCategory('ACCESSORIES/CAR RACK & PARTS', 'CAR KUAT PISTON ION EBIKE 2" 2-BIKE')).toBe('Accessories & Gear');
    expect(normalizeCyclingCategory('BIKES/ROAD/ROAD ENDURANCE', 'BIKE 25 GIANT DEFY ADVANCED 2 LRG')).toBe('Road & Gravel Bikes');
    expect(normalizeCyclingCategory('BIKES/KIDS/JUVENILE', 'BIKE 26 GIANT TALON 20 LITE')).toBe('Kids & BMX Bikes');
    expect(normalizeCyclingCategory('BIKES/FRAMESETS', 'FRAME 26 SPEC TARMAC SL9 SW 54')).toBe('Parts & Components');
  });

  it('chunks Shopify automatic discounts >200 product GIDs and maps Lightspeed SpecialOrders', async () => {
    const gqlOps: { query: string; vars: Record<string, unknown> }[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body ?? '{}')) as { query: string; variables: Record<string, unknown> };
      gqlOps.push({ query: parsed.query, vars: parsed.variables });
      if (parsed.query.includes('CreateDiscount')) {
        return new Response(JSON.stringify({
          data: { discountAutomaticBasicCreate: { automaticDiscountNode: { id: 'gid://shopify/DiscountAutomaticNode/999' }, userErrors: [] } },
          extensions: { cost: { throttleStatus: { currentlyAvailable: 1800, maximumAvailable: 2000, restoreRate: 100 } } },
        }));
      }
      return new Response(JSON.stringify({
        data: { discountAutomaticBasicUpdate: { automaticDiscountNode: { id: 'gid://shopify/DiscountAutomaticNode/999' }, userErrors: [] } },
      }));
    }) as unknown as typeof fetch;

    const client = new ShopifyAdminClient({ shopDomain: 'ubc.myshopify.com', accessToken: 'shpat_x', writesEnabled: true, fetchImpl });
    const api = new ShopifyAdminApi(client);
    const productIds = Array.from({ length: 450 }, (_, i) => `gid://shopify/Product/${i + 1}`);
    const id = await api.createAutomaticDiscount({
      title: '40K Scale Test Discount',
      percentOff: 0.15,
      productIds,
      startsAt: '2026-11-16T00:00:00Z',
      endsAt: null,
    });
    expect(id).toBe('gid://shopify/DiscountAutomaticNode/999');
    // 450 GIDs -> 1 Create (200) + 2 Updates (200 + 50) = 3 GraphQL mutations!
    expect(gqlOps).toHaveLength(3);

    const so = mapLsSpecialOrder({
      specialOrderID: '88',
      status: 'ready',
      unitQuantity: '1',
      receivedQuantity: '1',
      Note: { note: 'Customer pickup for Shopify #UBC1042' },
    });
    expect(so).toMatchObject({ specialOrderId: '88', status: 'ready', qtyReady: 1, referenceOrderNumber: '#UBC1042' });
  });
});

describe('lightspeed matrices (color / size)', () => {
  const sets = new Map<string, [string, string, string]>([['1', ['Color', 'Size', '']], ['3', ['', 'Size', '']]]);
  it('names matrix attributes with the attribute set', () => {
    expect(lsOptionValues({ attribute1: 'white', attribute2: 'XL', attribute3: '', itemAttributeSetID: '1' }, sets)).toEqual({ Color: 'white', Size: 'XL' });
    expect(lsOptionValues({ attribute1: '', attribute2: 'M', itemAttributeSetID: '3' }, sets)).toEqual({ Size: 'M' });
    expect(lsOptionValues({ attribute1: 'Red', itemAttributeSetID: '99' }, sets)).toEqual({ 'Option 1': 'Red' });
    expect(lsOptionValues(undefined, sets)).toEqual({});
  });
  it('removes option values from the end of the description to get the product title', () => {
    expect(lsMatrixBaseTitle('sun arm sleeves white XL', { Color: 'white', Size: 'XL' })).toBe('sun arm sleeves');
    expect(lsMatrixBaseTitle('Camber Helmet - Black / M', { Color: 'Black', Size: 'M' })).toBe('Camber Helmet');
    expect(lsMatrixBaseTitle('Plain Tube', {})).toBe('Plain Tube');
  });
  it('mapLsItem exposes the item attributes', () => {
    const m = mapLsItem({ itemID: '1', description: 'x', ItemAttributes: { attribute1: 'Blue', itemAttributeSetID: '1' } } as never);
    expect(m.itemAttributes).toMatchObject({ attribute1: 'Blue' });
  });
});

describe('lightspeed rotating refresh token shared between processes', () => {
  it('reuses a fresh access token another process saved instead of refreshing', async () => {
    let tokenCalls = 0;
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('oauth')) { tokenCalls++; return new Response('{}', { status: 400 }); }
      return new Response(JSON.stringify({ Account: { accountID: '1' } }), { status: 200 });
    }) as typeof fetch;
    let reads = 0;
    const client = new LightspeedRClient({
      clientId: 'c', clientSecret: 's', refreshToken: 'old', accountId: '1', fetchImpl,
      loadTokenState: async () => {
        reads++;
        // First read (startup): expired token. Later reads: another process already refreshed.
        return reads === 1
          ? { refreshToken: 'old', accessToken: 'stale', expiresAt: new Date(Date.now() - 1000).toISOString() }
          : { refreshToken: 'new', accessToken: 'fresh', expiresAt: new Date(Date.now() + 3600_000).toISOString() };
      },
    });
    await client.get('/Account.json');
    expect(tokenCalls).toBe(0);
  });
});

describe('lightspeed refresh lock across processes', () => {
  it('two processes needing a token at the same time refresh Lightspeed only once', async () => {
    let refreshes = 0;
    let vault = { refreshToken: 'r1', accessToken: 'old', expiresAt: new Date(Date.now() - 1000).toISOString() };
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (String(url).includes('oauth')) {
        refreshes++;
        const used = new URLSearchParams(String(init?.body)).get('refresh_token');
        if (used !== vault.refreshToken) return new Response('{"error":"invalid_grant"}', { status: 400 });
        await new Promise((r) => setTimeout(r, 20));
        return new Response(JSON.stringify({ access_token: 'fresh', expires_in: 3600, refresh_token: `r${refreshes + 1}` }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    let chain = Promise.resolve();
    const refreshLock = <T,>(fn: () => Promise<T>) => {
      const run = chain.then(fn);
      chain = run.then(() => undefined, () => undefined);
      return run;
    };
    const mk = () => new LightspeedRClient({
      clientId: 'c', clientSecret: 's', refreshToken: 'r1', accountId: '1', fetchImpl, refreshLock,
      loadTokenState: async () => ({ ...vault }),
      saveTokenState: async (st) => { vault = { refreshToken: st.refreshToken, accessToken: st.accessToken!, expiresAt: st.expiresAt! }; },
    });
    const a = mk();
    const b = mk();
    await Promise.all([a.get('/Account.json'), b.get('/Account.json')]);
    expect(refreshes).toBe(1);
    expect(vault.accessToken).toBe('fresh');
  });
});
