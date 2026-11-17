/**
 * Deterministic DEMO dataset. Every product, price, quantity and order here
 * is fictitious. Brand names are used only to make the demo realistic and do
 * not represent UBC's real catalog, costs or supplier agreements.
 */
import type { CatalogItem, MapPolicy, SpecialOrderStatus, SupplierOffer } from '@ubc/shared';

export const DEMO_NOTICE = 'DEMO DATA — fictitious products, prices, costs and orders. Connectors for Shopify Plus, Lightspeed POS, QBP, JBI and Specialized are ready to connect.';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gtinWithCheckDigit(body11: string): string {
  let sum = 0;
  for (let i = 0; i < body11.length; i++) {
    const d = Number(body11[body11.length - 1 - i]);
    sum += d * (i % 2 === 0 ? 3 : 1);
  }
  return body11 + String((10 - (sum % 10)) % 10);
}

export interface DemoSupplier {
  code: string;
  name: string;
  connector: string;
  methods: string[];
  notes: string;
}

export const DEMO_SUPPLIERS: DemoSupplier[] = [
  { code: 'QBP', name: 'Quality Bicycle Products', connector: 'qbp', methods: ['api', 'catalog_feed'], notes: 'UBC active dealer account — connector ready for QBP API token or scheduled CSV feed.' },
  { code: 'JBI', name: 'J&B Importers', connector: 'jbi', methods: ['catalog_feed', 'dealer_portal'], notes: 'UBC active dealer account — connector ready for JBI SFTP/CSV catalog feed and portal POs.' },
  { code: 'SPECIALIZED', name: 'Specialized Bicycle Components', connector: 'specialized', methods: ['dealer_portal', 'catalog_feed'], notes: 'UBC authorized dealer — complete bikes enforce in-store pickup (Click & Collect) and strict MAP.' },
];

interface CategoryDef {
  name: string;
  brands: string[];
  nouns: string[];
  price: [number, number];
  variants: string[][];
  mapShare: number;
}

const CATEGORIES: CategoryDef[] = [
  { name: 'Bikes', brands: ['Specialized', 'Trek', 'Giant', 'Cannondale', 'Marin'], nouns: ['Road Bike', 'Gravel Bike', 'Hybrid Bike', 'Trail Bike', 'Kids Bike'], price: [49900, 450000], variants: [['S', 'M', 'L', 'XL']], mapShare: 0.9 },
  { name: 'Electric Bikes', brands: ['Specialized', 'Trek', 'Aventon', 'Gazelle'], nouns: ['Commuter E-Bike', 'E-MTB', 'Cargo E-Bike', 'Step-Through E-Bike'], price: [149900, 899900], variants: [['S', 'M', 'L']], mapShare: 1 },
  { name: 'Parts', brands: ['Shimano', 'SRAM', 'KMC', 'Continental', 'Maxxis', 'WTB'], nouns: ['Chain', 'Cassette', 'Brake Pads', 'Tire', 'Inner Tube', 'Derailleur', 'Bottom Bracket', 'Saddle'], price: [899, 39900], variants: [['Standard'], ['700x25', '700x28', '700x32'], ['29x2.4', '27.5x2.6']], mapShare: 0.25 },
  { name: 'Accessories', brands: ['Bell', 'Giro', 'Kryptonite', 'Topeak', 'Lezyne', 'CamelBak', 'Thule'], nouns: ['Helmet', 'U-Lock', 'Floor Pump', 'Mini Pump', 'Front Light', 'Rear Light', 'Bottle Cage', 'Hydration Pack', 'Bike Rack', 'Multi-Tool'], price: [1499, 69900], variants: [['Standard'], ['S', 'M', 'L'], ['Black', 'White']], mapShare: 0.35 },
  { name: 'Apparel', brands: ['Pearl Izumi', 'Specialized', 'Fox', 'Giro'], nouns: ['Jersey', 'Bib Shorts', 'Gloves', 'Rain Jacket', 'Shoes'], price: [2999, 29900], variants: [['S', 'M', 'L', 'XL']], mapShare: 0.2 },
];

const MODELS = ['Apex', 'Vista', 'Ridge', 'Coastal', 'Metro', 'Summit', 'Glide', 'Torque', 'Pulse', 'Atlas', 'Nova', 'Drift', 'Echo', 'Fuse', 'Orbit'];

export interface DemoOrderLine {
  itemId: string;
  sku: string;
  title: string;
  qty: number;
  priceCents: number;
  source: 'ubc_stock' | 'supplier';
  supplierCode: string | null;
  costCents: number | null;
}

export interface DemoOrder {
  id: string;
  number: string;
  createdAt: string;
  customerName: string;
  fulfillmentMethod: 'pickup' | 'ship';
  financialStatus: 'paid' | 'pending' | 'refunded';
  shopifyFulfillmentStatus: 'unfulfilled' | 'partial' | 'fulfilled';
  status: SpecialOrderStatus;
  isSpecialOrder: boolean;
  totalCents: number;
  lines: DemoOrderLine[];
  tracking: string | null;
  events: { at: string; from: SpecialOrderStatus | null; to: SpecialOrderStatus; actor: string; note: string }[];
}

export interface DemoDataset {
  generatedAt: string;
  notice: string;
  suppliers: DemoSupplier[];
  items: CatalogItem[];
  orders: DemoOrder[];
}

const FIRST = ['Alex', 'Maria', 'Jordan', 'Sofia', 'Daniel', 'Valeria', 'Chris', 'Camila', 'Sam', 'Lucia'];
const LAST = ['Demo', 'Sample', 'Tester', 'Example'];

export function generateDemoDataset(opts: { seed?: number; products?: number; now?: Date } = {}): DemoDataset {
  const rnd = mulberry32(opts.seed ?? 20261111);
  const now = opts.now ?? new Date();
  const nProducts = opts.products ?? 1100;
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)]!;
  const int = (a: number, b: number) => Math.floor(a + rnd() * (b - a + 1));
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();

  const items: CatalogItem[] = [];
  let upcCounter = 1000;
  for (let p = 0; p < nProducts; p++) {
    const roll = rnd();
    const cat = CATEGORIES[roll < 0.13 ? 0 : roll < 0.2 ? 1 : roll < 0.5 ? 2 : roll < 0.88 ? 3 : 4]!;
    const brand = pick(cat.brands);
    const model = `${pick(MODELS)} ${int(1, 9)}`;
    const noun = pick(cat.nouns);
    const variants = pick(cat.variants);
    const basePrice = Math.round((cat.price[0] + rnd() ** 2 * (cat.price[1] - cat.price[0])) / 100) * 100 - 1;
    const mapPolicy: MapPolicy = rnd() < cat.mapShare ? 'map' : 'none';
    const marginTarget = 0.28 + rnd() * 0.22;
    const productId = `p${String(p + 1).padStart(4, '0')}`;
    const physicalProduct = rnd() < 0.35;
    const supplierShare = rnd();
    variants.forEach((opt, vi) => {
      const priceCents = basePrice;
      const costCents = rnd() < 0.04 ? null : Math.round(priceCents * (1 - marginTarget));
      const mapCents = mapPolicy === 'map' ? Math.round(priceCents * (cat.name.includes('Bike') ? 1 : 0.85 + rnd() * 0.1)) : null;
      const physicalQty = physicalProduct ? int(0, cat.name.includes('Bike') ? 3 : 12) : 0;
      const offers: SupplierOffer[] = [];
      const upc = rnd() < 0.9 ? gtinWithCheckDigit(`0${String(70000000 + upcCounter++).padStart(10, '0')}`) : null;
      const pushOffer = (code: string, mult: number) => {
        offers.push({
          supplierCode: code,
          supplierSku: `${code.slice(0, 3)}-${productId.slice(1)}-${vi + 1}`,
          costCents: costCents === null ? Math.round(priceCents * 0.6) : Math.round(costCents * mult),
          qtyAvailable: rnd() < 0.15 ? int(0, 2) : int(3, 60),
          reportedAt: rnd() < 0.08 ? hoursAgo(int(60, 200)) : hoursAgo(int(1, 30)),
          dropShip: code === 'QBP' ? rnd() < 0.7 : rnd() < 0.3,
          leadDays: int(2, 7),
        });
      };
      if (brand === 'Specialized') pushOffer('SPECIALIZED', 1);
      else {
        if (supplierShare < 0.75) pushOffer('QBP', 0.98 + rnd() * 0.06);
        if (supplierShare > 0.45) pushOffer('JBI', 0.97 + rnd() * 0.07);
      }
      const statusRoll = rnd();
      items.push({
        id: `${productId}-v${vi + 1}`,
        productId,
        title: `${brand} ${model} ${noun}${opt === 'Standard' ? '' : ` — ${opt}`}`,
        brand,
        model,
        category: cat.name,
        sku: `UBC-${productId.slice(1)}-${vi + 1}`,
        upc,
        mpn: `${brand.slice(0, 3).toUpperCase()}-${model.replace(/\s/g, '')}-${opt.replace(/\W/g, '')}`,
        priceCents,
        compareAtCents: null,
        costCents,
        mapCents,
        mapPolicy,
        status: statusRoll < 0.82 ? 'published' : statusRoll < 0.95 ? 'hidden' : 'draft',
        physicalQty,
        reservedQty: physicalQty > 0 && rnd() < 0.1 ? 1 : 0,
        offers,
        shopifyVariantId: null,
        lightspeedItemId: physicalProduct ? `LS-${int(10000, 99999)}` : null,
        updatedAt: hoursAgo(int(1, 400)),
        version: 1,
      });
    });
  }

  const orders: DemoOrder[] = [];
  const flows: SpecialOrderStatus[] = [
    'awaiting_approval', 'awaiting_approval', 'awaiting_review', 'approved', 'po_submitted',
    'supplier_confirmed', 'in_transit', 'received_at_ubc', 'ready_for_pickup', 'completed', 'exception', 'new_order',
  ];
  const specialCandidates = items.filter((i) => i.physicalQty === 0 && i.offers.some((o) => o.qtyAvailable > 2));
  const stockCandidates = items.filter((i) => i.physicalQty > 1);
  flows.forEach((status, idx) => {
    const special = idx < 10;
    const it = special ? specialCandidates[(idx * 37) % specialCandidates.length]! : stockCandidates[(idx * 11) % stockCandidates.length]!;
    const offer = special ? [...it.offers].sort((a, b) => a.costCents - b.costCents)[0]! : null;
    const qty = it.category.includes('Bike') ? 1 : int(1, 2);
    const created = hoursAgo(24 * (12 - idx) + int(0, 20));
    const method = rnd() < 0.6 ? 'pickup' : 'ship';
    orders.push({
      id: `o${1001 + idx}`,
      number: `#DEMO-${1001 + idx}`,
      createdAt: created,
      customerName: `${pick(FIRST)} ${pick(LAST)}`,
      fulfillmentMethod: method,
      financialStatus: 'paid',
      shopifyFulfillmentStatus: status === 'completed' ? 'fulfilled' : 'unfulfilled',
      status: special ? status : status === 'exception' ? 'completed' : status,
      isSpecialOrder: special,
      totalCents: it.priceCents * qty,
      lines: [{
        itemId: it.id, sku: it.sku, title: it.title, qty, priceCents: it.priceCents,
        source: special ? 'supplier' : 'ubc_stock', supplierCode: offer?.supplierCode ?? null,
        costCents: offer?.costCents ?? it.costCents,
      }],
      tracking: ['in_transit', 'received_at_ubc', 'ready_for_pickup', 'completed'].includes(status) ? `DEMO-TRK-${int(100000, 999999)}` : null,
      events: [{ at: created, from: null, to: 'new_order', actor: 'shopify-webhook (demo)', note: 'Order received from Shopify (simulated)' }],
    });
    const last = orders[orders.length - 1]!;
    if (status === 'exception' && special) {
      last.events.push({ at: hoursAgo(5), from: 'po_submitted', to: 'exception', actor: 'system', note: 'Supplier cost changed by more than 2 % — needs review' });
    }
  });

  return { generatedAt: now.toISOString(), notice: DEMO_NOTICE, suppliers: DEMO_SUPPLIERS, items, orders };
}
