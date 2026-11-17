import type { SupplierCatalogRecord } from '../types.js';

export type CsvDelimiter = ',' | '\t' | ';' | '|';

/** Auto-detect CSV/TSV/semicolon/pipe delimiter from the header line (ignoring characters inside quotes). */
export function detectDelimiter(text: string): CsvDelimiter {
  const src = text.replace(/^\uFEFF/, '');
  let inQuotes = false;
  const counts: Record<CsvDelimiter, number> = { ',': 0, '\t': 0, ';': 0, '|': 0 };
  for (let i = 0; i < src.length && i < 8192; i++) {
    const c = src[i]!;
    if (c === '"') {
      if (inQuotes && src[i + 1] === '"') i++;
      else inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && (c === '\n' || c === '\r')) break;
    if (!inQuotes && (c === ',' || c === '\t' || c === ';' || c === '|')) {
      counts[c]++;
    }
  }
  let best: CsvDelimiter = ',';
  for (const d of ['\t', ';', '|', ','] as CsvDelimiter[]) {
    if (counts[d] > counts[best]) best = d;
  }
  return best;
}

/** RFC-4180 style CSV/TSV parser (quotes, escaped quotes, CRLF, auto-detected delimiter). */
export function parseCsv(text: string, delimiter?: CsvDelimiter): string[][] {
  const sep = delimiter ?? detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === sep) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

export interface FeedMapping {
  supplierSku: string;
  brand: string;
  title: string;
  mpn?: string;
  upc?: string;
  category?: string;
  cost?: string;
  msrp?: string;
  map?: string;
  qty?: string;
  dropShip?: string;
  leadDays?: string;
  description?: string;
  imageUrl?: string;
  size?: string;
  color?: string;
  matrixRef?: string;
}

export interface FeedRowError { line: number; message: string }

const COLUMN_ALIASES: Record<keyof FeedMapping, string[]> = {
  supplierSku: ['suppliersku', 'itemnumber', 'itemno', 'partnumber', 'partno', 'vendorsku', 'jbipart', 'qbppart', 'sku', 'customsku', 'systemid', 'material', 'codigo', 'item_id'],
  brand: ['brand', 'brandname', 'manufacturer', 'vendor', 'make', 'marca', 'fabricante'],
  title: ['title', 'description', 'itemdescription', 'productname', 'name', 'item', 'shortdescription', 'modeldescription', 'nombre', 'producto'],
  mpn: ['mpn', 'mfgpart', 'mfgpartno', 'mfgpartnumber', 'manufacturersku', 'manufactsku', 'modelnumber', 'factorypart'],
  upc: ['upc', 'upccode', 'gtin', 'ean', 'ean13', 'barcode', 'codigobarras'],
  category: ['category', 'department', 'producttype', 'type', 'subcategory', 'categoryname', 'categoria', 'familia'],
  cost: ['cost', 'dealercost', 'dealernet', 'wholesale', 'wholesaleprice', 'unitcost', 'defaultcost', 'netprice', 'costo'],
  msrp: ['msrp', 'retail', 'retailprice', 'defaultprice', 'listprice', 'srp', 'price', 'precio'],
  map: ['map', 'mapprice', 'umap', 'minadvertisedprice', 'minimumadvertisedprice'],
  qty: ['qty', 'qtyavailable', 'quantity', 'available', 'availqty', 'qoh', 'onhand', 'stock', 'inventory', 'miamiqty', 'totalqty', 'cantidad', 'existencia'],
  dropShip: ['dropship', 'dropshipeligible', 'directship'],
  leadDays: ['leaddays', 'leadtime', 'leadtimedays', 'etadays'],
  description: ['longdescription', 'bodyhtml', 'fullcopy', 'webdescription', 'detalles'],
  imageUrl: ['imageurl', 'image', 'image1', 'primaryimage', 'photourl', 'photo', 'imgurl', 'imagen'],
  size: ['size', 'framesize', 'wheelsize', 'talla', 'option1value'],
  color: ['color', 'colour', 'finish', 'colorway', 'option2value'],
  matrixRef: ['matrixref', 'itemmatrixid', 'parentsku', 'modelcode', 'stylecode', 'handle'],
};

/** Automatically infer column mapping from ANY distributor or POS CSV/TSV header row. */
export function inferFeedMapping(headers: readonly string[]): Partial<FeedMapping> {
  const norm = headers.map((h) => ({ raw: h, clean: h.trim().toLowerCase().replace(/[^a-z0-9]/g, '') }));
  const used = new Set<string>();
  const out: Partial<FeedMapping> = {};

  for (const [field, aliases] of Object.entries(COLUMN_ALIASES) as [keyof FeedMapping, string[]][]) {
    let match = norm.find((h) => !used.has(h.raw) && aliases.includes(h.clean));
    if (!match) {
      match = norm.find((h) => !used.has(h.raw) && aliases.some((a) => a.length >= 4 && h.clean.includes(a)));
    }
    if (match) {
      out[field] = match.raw;
      used.add(match.raw);
    }
  }
  return out;
}

const EBIKE_MODEL_RE =
  /\b(e-?bikes?|electric|pedal\s*assist|e-?mtb|jupiter|denago|aventon|velotric|lectric|rad\s+power|segway|xyber|fengos|turbo\s+vado|turbo\s+levo|turbo\s+como|turbo\s+tero|turbo\s+creo|levo\s+(?:sl|comp|pro|expert|alloy|sw|s-?works|swork|r\b|g[34]|\d)|kenevo|creo\s+sl|vado\s+sl|como\s+sl|tero\s+x|haul\s+(?:st|lt)|trance\s+x?\s*(?:adv\s+)?e\+?|transcend\s+e\+?|roam\s+e\+?|explore\s+e\+?|talon\s+e\+?|stance\s+e\+?|reign\s+e\+?|townie\s+go|heckler)\b/;

const KIDS_BMX_RE =
  /\b(kids?\s+bikes?|youth\s+bikes?|childrens?\s+bikes?|juvenile|bmx|freestyle|free\s+agent|riprock|hotwalk|hotrock|jett\s+\d|talon\s+(?:20|24)\b|talon\s+lite\s+24|tempt\s+(?:20|24)\b)\b/;

const NON_BIKE_PART_PREFIX_RE =
  /^(ebike\s*\*|charger\b|battery\b|car\s+|rack\b|pack\b|basket\b|brk\b|crk\b|seat\b|saddle\b|grip\b|whl\b|wheel\b|fork\b|shock\b|derail\b|shift\b|group\b|cass\b|pedal\b|trl\b|post\b|hub\b|bb\b|frame\b|shoe\b|hel\b|helmet\b|tire\b|tube\b|pump\b|tool\b|lock\b|light\b|comp\b|trainer\b|baby\s+seat\b|repair\s+stand\b)/;

/** Normalize arbitrary bike-industry distributor & Lightspeed POS department strings into clean UBC / Shopify Smart Collection categories. */
export function normalizeCyclingCategory(rawCategory?: string | null, title?: string | null): string {
  const catLower = (rawCategory ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  const titleLower = (title ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

  // 1. Workshop Services, Labor, Rentals, Discounts/Protection Plans, Click & Collect
  if (
    /^(services|service|labor|workshop|rentals|discounts\s*&\s*codes|click\s*&\s*collect)\b/.test(catLower) ||
    /^labor\b/.test(titleLower)
  ) {
    return 'Workshop Services';
  }

  // 2. Explicit non-bike POS / distributor department hierarchies (never let "ebike"/"road" in a part or rack title turn it into a complete bike!)
  if (/^parts\b/.test(catLower)) {
    if (/\b(tires?|tubes?|tubeless|patch\s+kit|flat\s+protection)\b/.test(catLower)) return 'Tires & Tubes';
    return 'Parts & Components';
  }
  if (/^accessories\b/.test(catLower)) {
    if (/\bhelmets?\b/.test(catLower)) return 'Helmets & Safety';
    if (/\b(water\s+bottle|hydration\s+pack)\b/.test(catLower)) return 'Hydration & Nutrition';
    if (/\b(tools?|repair\s+stands?|pump|co2|lubes?|degreasers?|polish|chamois\s+cream)\b/.test(catLower)) return 'Tools & Workshop';
    return 'Accessories & Gear';
  }
  if (/^(clothing|apparel)\b/.test(catLower)) return 'Apparel & Footwear';
  if (/^food\s*&\s*drinks\b/.test(catLower)) {
    if (/\b(chamois|lubes?)\b/.test(catLower)) return 'Tools & Workshop';
    return 'Hydration & Nutrition';
  }
  if (/^tires\b/.test(catLower)) return 'Tires & Tubes';
  if (/^helmets\b/.test(catLower)) return 'Helmets & Safety';

  // 3. Explicit BIKES/... hierarchy from Lightspeed POS (#114391)
  if (/^bikes\//.test(catLower)) {
    if (catLower.startsWith('bikes/framesets')) return 'Parts & Components';
    if (catLower.startsWith('bikes/excersise') || catLower.startsWith('bikes/exercise')) return 'Accessories & Gear';
    if (catLower.startsWith('bikes/electric') || EBIKE_MODEL_RE.test(titleLower)) return 'Electric Bikes';
    if (catLower.startsWith('bikes/kids') || KIDS_BMX_RE.test(titleLower)) return 'Kids & BMX Bikes';
    if (catLower.startsWith('bikes/mountain')) return 'Mountain Bikes';
    if (catLower.startsWith('bikes/road') || catLower.startsWith('bikes/triathlon')) return 'Road & Gravel Bikes';
    if (catLower.startsWith('bikes/used')) {
      if (/\b(mtb|mountain|epic|stumpjumper|rockhopper|trance|talon|roscoe|sb1\d\d)\b/.test(titleLower)) return 'Mountain Bikes';
      if (/\b(road|gravel|tarmac|roubaix|allez|diverge|crux|synapse|defy|contend|catalist|cross\s+check)\b/.test(titleLower)) return 'Road & Gravel Bikes';
      return 'Used & Consignment';
    }
    return 'Hybrid & Comfort Bikes';
  }

  // 4. Uncategorized / generic ("Imported", "COMPLETE BIKES", "BIKES", or blank) — check non-bike part prefixes BEFORE complete-bike models!
  const isPartPrefix = NON_BIKE_PART_PREFIX_RE.test(titleLower);
  const looksLikeCompleteBike =
    !isPartPrefix &&
    !/\b(framesets?|frame\s+only|shoes?|helmets?|tires?|tubes?|saddles?|seats?|back\s*rest|grips?|pedals?|cranks?|chargers?|batter(?:y|ies)|displays?|controllers?|adapters?|racks?|baskets?|bags?|packs?|lights?)\b/.test(titleLower) &&
    (catLower === 'bikes' ||
      catLower.includes('complete bike') ||
      /^(bike|used\s+bike|trike|zz\s+spec)\b/.test(titleLower) ||
      EBIKE_MODEL_RE.test(titleLower) ||
      /\b(tarmac\s+sl|roubaix\s+(?:sl|sw)|epic\s+\d|stumpjumper)\b/.test(titleLower));

  if (looksLikeCompleteBike) {
    if (EBIKE_MODEL_RE.test(titleLower)) return 'Electric Bikes';
    if (KIDS_BMX_RE.test(titleLower)) return 'Kids & BMX Bikes';
    if (/\b(mtb|mountain|full[\s-]?suspension|hardtail|trail|enduro|epic|stumpjumper|\bsj\b|chisel|rockhopper|status|trance|talon|tempt|intrigue|embolden|habit|roscoe|sb1\d\d|asr|sniper|mb\.1)\b/.test(titleLower)) {
      return 'Mountain Bikes';
    }
    if (/\b(road|gravel|tarmac|roubaix|allez|diverg|crux|aethos|synapse|synapes?|supersix|evo\s+se|defy|contend|revolt|addict|flite|all-?road|triathlon)\b/.test(titleLower)) {
      return 'Road & Gravel Bikes';
    }
    if (/^used\s+bike\b/.test(titleLower)) return 'Used & Consignment';
    return 'Hybrid & Comfort Bikes';
  }

  if (/^used\b/.test(catLower)) return 'Used & Consignment';

  // 5. General keyword fallback for supplier CSVs and uncategorized accessories/parts
  const s = `${catLower} ${titleLower}`;
  if (/\b(helmets?|mips|cascos?)\b/.test(s)) return 'Helmets & Safety';
  if (/\b(shoes?|jerseys?|bibs?|shorts|gloves?|socks?|jackets?|vests?|t-?shirts?|shirts?|pants|apparel|clothing)\b/.test(s)) return 'Apparel & Footwear';
  if (/\b(tires?|tyres?|tubes?|tubeless|clinchers?|gp\s*5000|llantas?|camaras?)\b/.test(s)) return 'Tires & Tubes';
  if (/\b(hydration|nutrition|electrolytes?|chews?|gels?|drinks?|food|energy\s+bars?|bottles?|cages?|skratch|roctane|ryse|clif|maurten|nuun)\b/.test(s)) return 'Hydration & Nutrition';
  if (/\b(repair\s+stands?|tools?|wrench(?:es)?|lubes?|lubricants?|pumps?|co2|cleaners?|degreasers?|grease|sealants?|park\s+tool|herramientas?)\b/.test(s)) return 'Tools & Workshop';
  if (/\b(locks?|u-locks?|lights?|headlights?|taillights?|racks?|fenders?|kickstands?|mirrors?|bells?|baskets?|trailers?|car\s+racks?|hitch|bags?|packs?|panniers?|computers?|gps|power\s*meters?|radars?|sunglasses|eyewear|glasses|goggles?|chargers?|batter(?:y|ies)|trainers?)\b/.test(s)) return 'Accessories & Gear';
  if (/\b(saddles?|seats?|groupsets?|derailleurs?|cassettes?|freewheels?|chains?|chainrings?|pedals?|cleats?|brakes?|rotors?|pads?|cranks?|cranksets?|bottom\s+brackets?|wheelsets?|wheels?|rims?|spokes?|hubs?|handlebars?|bar\s+tape|grips?|bar\s+ends?|stems?|seatposts?|headsets?|forks?|shocks?|cables?|housings?|bearings?|di2|shimano|sram|displays?|controllers?|adapters?)\b/.test(s)) return 'Parts & Components';
  return 'Parts & Components';
}

const money = (v: string | undefined, strictlyPositive = false): number | null => {
  if (v === undefined) return null;
  const cleaned = v.replace(/[A-Za-z$\s]/g, '').replace(/,/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === 'N/A') return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  const cents = Math.round(n * 100);
  if (strictlyPositive && cents <= 0) return null;
  return cents;
};

/** Parse distributor stock strings like "15", "10+", ">25", "In Stock", "Yes", "Out of Stock", "Backorder". Rejects negative numbers. */
function parseFlexibleQty(raw: string | undefined): number | null {
  if (raw === undefined) return 0;
  const s = raw.trim();
  if (s === '' || /^(out\s*of\s*stock|oos|no|false|none|backorder|n\/a|-+)$/i.test(s)) return 0;
  if (/^(in\s*stock|available|yes|true|call)$/i.test(s)) return 5;
  const plusOrGt = /^[>+]?\s*(\d+(?:\.\d+)?)\s*\+?$/.exec(s.replace(/,/g, ''));
  if (plusOrGt) return Math.max(0, Math.floor(Number(plusOrGt[1])));
  const n = Number(s.replace(/,/g, ''));
  if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  return null;
}

/** Map CSV/TSV/pipe/semicolon rows to catalog records using explicit or auto-inferred header mapping. */
export function mapFeed(
  text: string,
  mapping: Partial<FeedMapping> | undefined,
  opts: { contentLicensed: boolean; defaultLeadDays: number; defaultBrand?: string; delimiter?: CsvDelimiter },
) {
  const rows = parseCsv(text, opts.delimiter);
  const rawHeader = rows.shift() ?? [];
  const inferred = inferFeedMapping(rawHeader);
  const eff: Partial<FeedMapping> = { ...inferred };
  if (mapping) {
    for (const [k, v] of Object.entries(mapping) as [keyof FeedMapping, string | undefined][]) {
      if (v && v.trim()) eff[k] = v.trim();
    }
  }

  const headerLower = rawHeader.map((h) => h.trim().toLowerCase());
  const idx = (col?: string) => (col ? headerLower.indexOf(col.trim().toLowerCase()) : -1);

  const skuIdx = idx(eff.supplierSku);
  const titleIdx = idx(eff.title);
  const brandIdx = idx(eff.brand);

  const missingCols: string[] = [];
  if (skuIdx < 0) missingCols.push(eff.supplierSku || 'supplierSku');
  if (titleIdx < 0) missingCols.push(eff.title || 'title');
  if (brandIdx < 0 && !opts.defaultBrand) missingCols.push(eff.brand || 'brand');
  if (missingCols.length) throw new Error(`Feed is missing required columns: ${missingCols.join(', ')}`);

  const colIdx = {
    mpn: idx(eff.mpn),
    upc: idx(eff.upc),
    category: idx(eff.category),
    cost: idx(eff.cost),
    msrp: idx(eff.msrp),
    map: idx(eff.map),
    qty: idx(eff.qty),
    dropShip: idx(eff.dropShip),
    leadDays: idx(eff.leadDays),
    description: idx(eff.description),
    imageUrl: idx(eff.imageUrl),
    size: idx(eff.size),
    color: idx(eff.color),
    matrixRef: idx(eff.matrixRef),
  };

  const getAt = (r: string[], i: number) => (i >= 0 ? r[i]?.trim() : undefined);
  const records: SupplierCatalogRecord[] = [];
  const errors: FeedRowError[] = [];

  for (let n = 0; n < rows.length; n++) {
    const r = rows[n]!;
    const sku = r[skuIdx]?.trim();
    if (!sku) { errors.push({ line: n + 2, message: 'empty supplier SKU' }); continue; }
    const qty = parseFlexibleQty(getAt(r, colIdx.qty));
    if (qty === null) {
      errors.push({ line: n + 2, message: `invalid quantity "${getAt(r, colIdx.qty)}"` });
      continue;
    }
    const rawTitle = r[titleIdx]?.trim() ?? sku;
    const rawBrand = (brandIdx >= 0 ? r[brandIdx]?.trim() : opts.defaultBrand) || opts.defaultBrand || 'Generic';
    const rawCat = getAt(r, colIdx.category) || null;
    const sizeVal = getAt(r, colIdx.size);
    const colorVal = getAt(r, colIdx.color);
    const optionValues: Record<string, string> = {};
    if (sizeVal) optionValues.Size = sizeVal;
    if (colorVal) optionValues.Color = colorVal;

    const imgRaw = getAt(r, colIdx.imageUrl);
    const images = imgRaw
      ? imgRaw.split(/[|;\s]+/).map((u) => u.trim()).filter((u) => /^https?:\/\//i.test(u))
      : [];

    records.push({
      supplierSku: sku,
      brand: rawBrand,
      title: rawTitle,
      mpn: getAt(r, colIdx.mpn) || null,
      upc: getAt(r, colIdx.upc) || null,
      category: normalizeCyclingCategory(rawCat, rawTitle),
      costCents: money(getAt(r, colIdx.cost), false),
      msrpCents: money(getAt(r, colIdx.msrp), true),
      mapCents: money(getAt(r, colIdx.map), true),
      qtyAvailable: qty,
      dropShip: /^(y|yes|true|1)$/i.test(getAt(r, colIdx.dropShip) ?? ''),
      leadDays: Number(getAt(r, colIdx.leadDays)) || opts.defaultLeadDays,
      contentLicensed: opts.contentLicensed,
      description: getAt(r, colIdx.description) || null,
      images,
      optionValues,
      matrixRef: getAt(r, colIdx.matrixRef) || null,
    });
  }
  return { records, errors, inferredMapping: eff };
}
