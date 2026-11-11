/**
 * Product identity & equivalence.
 *
 * A supplier SKU is only meaningful inside that supplier. Cross-source
 * identity relies on GTIN (UPC/EAN, validated check digit) and on
 * brand + manufacturer part number. Anything ambiguous goes to manual review.
 */

export function normalizeGtin(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (![8, 12, 13, 14].includes(digits.length)) return null;
  if (!isValidGtinCheckDigit(digits)) return null;
  // All-zero or repeated placeholder codes are common in supplier feeds.
  if (/^(\d)\1+$/.test(digits)) return null;
  return digits.padStart(14, '0');
}

export function isValidGtinCheckDigit(digits: string): boolean {
  const body = digits.slice(0, -1);
  const check = Number(digits[digits.length - 1]);
  let sum = 0;
  // Weights alternate 3,1 starting from the rightmost body digit.
  for (let i = 0; i < body.length; i++) {
    const d = Number(body[body.length - 1 - i]);
    sum += d * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10 === check;
}

export function normalizeBrand(raw: string | null | undefined): string {
  return (raw ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\b(inc|llc|co|corp|bikes?|bicycles?|components)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

export function normalizeMpn(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return v.length >= 4 ? v : null; // very short part numbers are not discriminating
}

function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1));
}

export function titleSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

export interface Identity {
  brand: string | null;
  mpn: string | null;
  upc: string | null;
  title: string;
}

export type MatchDecision = 'auto_match' | 'review' | 'no_match';

export interface MatchResult {
  decision: MatchDecision;
  score: number;
  reasons: string[];
}

export function compareIdentities(incoming: Identity, existing: Identity): MatchResult {
  const reasons: string[] = [];
  const gA = normalizeGtin(incoming.upc);
  const gB = normalizeGtin(existing.upc);
  const bA = normalizeBrand(incoming.brand);
  const bB = normalizeBrand(existing.brand);
  const mA = normalizeMpn(incoming.mpn);
  const mB = normalizeMpn(existing.mpn);
  const brandKnown = bA !== '' && bB !== '';
  const sameBrand = brandKnown && bA === bB;
  const sim = titleSimilarity(incoming.title, existing.title);

  if (gA && gB && gA === gB) {
    reasons.push('GTIN_EQUAL');
    if (brandKnown && !sameBrand) {
      reasons.push('BRAND_CONFLICT');
      return { decision: 'review', score: 0.6, reasons };
    }
    if (mA && mB && mA !== mB) {
      reasons.push('MPN_CONFLICT');
      return { decision: 'review', score: 0.7, reasons };
    }
    return { decision: 'auto_match', score: 0.99, reasons };
  }

  if (gA && gB && gA !== gB) {
    reasons.push('GTIN_DIFFERENT');
    // Different valid GTINs: usually different variants (size/colour). Only flag if everything else matches.
    if (sameBrand && mA && mA === mB) {
      reasons.push('BRAND_MPN_EQUAL');
      return { decision: 'review', score: 0.5, reasons };
    }
    return { decision: 'no_match', score: 0.05, reasons };
  }

  // At least one side lacks a usable GTIN.
  if (sameBrand && mA && mB && mA === mB) {
    reasons.push('BRAND_MPN_EQUAL');
    if (!gA || !gB) reasons.push('GTIN_MISSING');
    // Without GTIN corroboration we never auto-match: variants often share an MPN prefix.
    return { decision: 'review', score: 0.75 + Math.min(0.15, sim * 0.15), reasons };
  }

  if (sameBrand && sim >= 0.6) {
    reasons.push('TITLE_SIMILAR');
    return { decision: 'review', score: 0.4 + sim * 0.2, reasons };
  }

  return { decision: 'no_match', score: sim * 0.3, reasons: reasons.length ? reasons : ['NO_EVIDENCE'] };
}

export interface Candidate<T> extends MatchResult {
  item: T;
}

/** Best candidate across a catalog; ties at auto_match level are downgraded to review. */
export function findBestMatch<T extends Identity>(incoming: Identity, catalog: readonly T[]): Candidate<T> | null {
  let best: Candidate<T> | null = null;
  let autoCount = 0;
  for (const item of catalog) {
    const r = compareIdentities(incoming, item);
    if (r.decision === 'no_match') continue;
    if (r.decision === 'auto_match') autoCount++;
    if (!best || r.score > best.score) best = { ...r, item };
  }
  if (best && autoCount > 1) {
    return { ...best, decision: 'review', reasons: [...best.reasons, 'MULTIPLE_GTIN_MATCHES'] };
  }
  return best;
}
