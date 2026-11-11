/** RFC-4180 style CSV parser (quotes, escaped quotes, CRLF). Small on purpose: supplier feeds are plain. */
export function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === delimiter) { row.push(field); field = ''; }
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
}

export interface FeedRowError { line: number; message: string }

const money = (v: string | undefined): number | null => {
  if (v === undefined) return null;
  const s = v.replace(/[$,\s]/g, '');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};

/** Map CSV rows to catalog records using a header mapping; invalid rows are reported, not dropped silently. */
export function mapFeed(text: string, mapping: FeedMapping, opts: { contentLicensed: boolean; defaultLeadDays: number }) {
  const rows = parseCsv(text);
  const header = (rows.shift() ?? []).map((h) => h.trim().toLowerCase());
  const idx = (col?: string) => (col ? header.indexOf(col.toLowerCase()) : -1);
  const req = { supplierSku: idx(mapping.supplierSku), brand: idx(mapping.brand), title: idx(mapping.title) };
  const missingCols = Object.entries(req).filter(([, i]) => i < 0).map(([k]) => (mapping as unknown as Record<string, string>)[k]);
  if (missingCols.length) throw new Error(`Feed is missing required columns: ${missingCols.join(', ')}`);
  const records = [];
  const errors: FeedRowError[] = [];
  const get = (r: string[], col?: string) => { const i = idx(col); return i >= 0 ? r[i]?.trim() : undefined; };
  for (let n = 0; n < rows.length; n++) {
    const r = rows[n]!;
    const sku = r[req.supplierSku]?.trim();
    if (!sku) { errors.push({ line: n + 2, message: 'empty supplier SKU' }); continue; }
    const qtyRaw = get(r, mapping.qty);
    const qty = qtyRaw === undefined || qtyRaw === '' ? 0 : Number(qtyRaw);
    if (!Number.isFinite(qty) || qty < 0) { errors.push({ line: n + 2, message: `invalid quantity "${qtyRaw}"` }); continue; }
    records.push({
      supplierSku: sku,
      brand: r[req.brand]?.trim() ?? '',
      title: r[req.title]?.trim() ?? '',
      mpn: get(r, mapping.mpn) || null,
      upc: get(r, mapping.upc) || null,
      category: get(r, mapping.category) || null,
      costCents: money(get(r, mapping.cost)),
      msrpCents: money(get(r, mapping.msrp)),
      mapCents: money(get(r, mapping.map)),
      qtyAvailable: Math.floor(qty),
      dropShip: /^(y|yes|true|1)$/i.test(get(r, mapping.dropShip) ?? ''),
      leadDays: Number(get(r, mapping.leadDays)) || opts.defaultLeadDays,
      contentLicensed: opts.contentLicensed,
    });
  }
  return { records, errors };
}
