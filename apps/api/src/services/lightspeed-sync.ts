import { computeAvailability, formatRetailBarcode, normalizeGtin } from '@ubc/business-rules';
import {
  mapLsItem,
  mapLsSpecialOrder,
  normalizeCyclingCategory,
  type LsItem,
  type LsSpecialOrder,
} from '@ubc/integrations';
import { withTransaction } from '@ubc/database';
import { lsMatrixBaseTitle, lsOptionValues } from '@ubc/integrations';
import { audit } from './audit.js';
import { getSettings, rowToItem } from './catalog.js';
import type { AppContext } from './context.js';
import { enqueue, setProgress } from './jobs.js';

const KNOWN_CYCLING_BRANDS = [
  'Jupiter', 'Denago', 'Specialized', 'Trek', 'Cannondale', 'Giant', 'Liv', 'Momentum', 'Santa Cruz', 'Yeti', 'Intense', 'Cervelo', 'Pinarello', 'Scott', 'Orbea', 'Bianchi',
  'Batch', 'Electra', 'Biria', 'KHS', 'Free Agent', 'Haro', 'SE Bikes', 'Manhattan', 'State Bicycles', 'Surly', 'Litespeed', 'Segway', 'Aventon', 'Velotric', 'Gazelle',
  'Shimano', 'SRAM', 'Campagnolo', 'Continental', 'Vittoria', 'Maxxis', 'Pirelli', 'Schwalbe', 'Michelin', 'Teravail', 'Kenda', 'WTB', 'Panaracer', 'Goodyear', 'CushCore',
  'Giro', 'Bell', 'POC', 'Lazer', 'Kask', 'Troy Lee', 'Fox', 'Smith', 'Oakley', 'Tifosi', '100%', 'Garmin', 'Wahoo', 'Hammerhead', 'Bryton', 'Cateye',
  'Park Tool', 'Pedro\'s', 'Finish Line', 'Muc-Off', 'Silca', 'Topeak', 'Lezyne', 'Blackburn', 'Bontrager', 'Roval', 'Zipp', 'Enve', 'Mavic', 'Origin8', 'Sunlite', 'Jagwire',
  'Skratch', 'GU', 'Maurten', 'Nuun', 'Clif', 'Ryse', 'Hammer Nutrition', 'Honey Stinger', 'CamelBak', 'Polar Bottle', 'Fidlock', 'Kryptonite', 'Abus',
  'RockShox', 'SR Suntour', 'DT Swiss', 'Chris King', 'Industry Nine', 'CeramicSpeed', '5Dev', 'Atomik', 'Kids Ride Shotgun',
  'Pearl Izumi', 'Five Ten', 'Castelli', 'Rapha', 'Assos', 'Endura', 'Sidi', 'Fizik', 'Ergon', 'Brooks', 'Selle Royal', 'Supacaz', 'Lizard Skins', 'ESI', 'ODI', 'XLC',
  'Thule', 'Kuat', 'Saris', 'Yakima', 'Hollywood Racks', 'SeaSucker',
];

const POS_BRAND_ALIASES: Record<string, string> = {
  SPZ: 'Specialized',
  SPEC: 'Specialized',
  SWKS: 'Specialized',
  SWRKS: 'Specialized',
  PIZ: 'Pearl Izumi',
  GNT: 'Giant',
  CDL: 'Cannondale',
  CAN: 'Cannondale',
  SHM: 'Shimano',
  SHI: 'Shimano',
  RSHOX: 'RockShox',
  SANTACRUZ: 'Santa Cruz',
  SCOTTT: 'Scott',
  BKBRN: 'Blackburn',
  SEASUCK: 'SeaSucker',
  HOLLYWOD: 'Hollywood Racks',
  HOLLYWOOD: 'Hollywood Racks',
  BON: 'Bontrager',
  CON: 'Continental',
  MAX: 'Maxxis',
  VIT: 'Vittoria',
  PRK: 'Park Tool',
  TLD: 'Troy Lee',
  '-UBC': 'UBC Custom',
  UBC: 'UBC Custom',
};

const POS_DEPT_PREFIXES = new Set([
  'SMP', 'ZZ', 'BIKE', 'EBIKE', 'E-BIKE', 'TRIKE', 'SHOE', 'SHOES', 'HEL', 'HELMET', 'FOOD', 'DRINK', 'GLASS', 'GLASSES',
  'SHT', 'SHIRT', 'T-SHIRT', 'TSHIRT', 'JER', 'JERSEY', 'BIB', 'SOCK', 'SOCKS', 'GLV', 'GLOVE', 'GLOVES',
  'CAP', 'HAT', 'JACKET', 'VEST', 'PANT', 'PANTS', 'BAG', 'PACK', 'BASKET', 'BOTTLE', 'CAGE', 'TIRE', 'TUBE',
  'WHEEL', 'WHL', 'RIM', 'HUB', 'SPOKE', 'FORK', 'SHOCK', 'HEADSET', 'STEM', 'BAR', 'GRIP', 'TAPE',
  'SEAT', 'SADDLE', 'POST', 'SEATPOST', 'PEDAL', 'CRANK', 'CRK', 'CHAIN', 'CASS', 'CASSETTE', 'DER', 'DERAIL', 'SHIFT', 'GROUP', 'BRAKE', 'BRK',
  'ROTOR', 'PAD', 'CABLE', 'PUMP', 'CO2', 'TOOL', 'LUBE', 'LIGHT', 'LOCK', 'RACK', 'CAR', 'TRL', 'FENDER', 'BELL',
  'MIRROR', 'KICKSTAND', 'COMP', 'COMPUTER', 'MOUNT', 'FRAME', 'CHARGER', 'BATTERY', 'TRAINER', 'BABY', 'REPAIR', 'BB',
  'LABOR', 'SERVICE', 'USED', 'DEMO', 'PART', 'ACC',
]);

const UPPER_ACRONYMS = new Set([
  'SRAM', 'BMC', 'POC', 'GT', 'GU', 'KMC', 'WTB', 'HED', 'XLC', 'SE', 'DK', 'ODI', 'ESI', 'KHS',
  'DMR', 'MRP', 'PRO', 'EVO', 'MSW', 'QBP', 'JBI', '3T', 'FSA', 'LOOK', 'SIDI', 'SKS', 'UBC',
]);

export function formatPosBrand(rawBrand: string | null, fallbackTitle: string): string {
  // Explicit Jupiter override so POS typos ("-UBC", "Ebike", accidental "Specialized" on Jupiter chargers) always resolve to Jupiter
  if (/\bjupiter\b/i.test(fallbackTitle)) return 'Jupiter';

  if (rawBrand) {
    const clean = rawBrand.trim().replace(/\s+/g, ' ');
    const upper = clean.toUpperCase();
    // Catch-all POS codes ("SMP", "ZZ", "-UBC", "UBC") -> extract real manufacturer from title when present!
    if (upper === 'SMP' || upper === 'ZZ' || upper === '-UBC' || upper === 'UBC') {
      const fromTitle = inferBrandFromTitle(fallbackTitle, true);
      if (fromTitle) return fromTitle;
      if (upper === '-UBC' || upper === 'UBC') return 'UBC Custom';
      return upper === 'SMP' ? 'UBC Small Parts' : 'UBC Archive';
    }
    if (POS_BRAND_ALIASES[upper]) return POS_BRAND_ALIASES[upper]!;
    if (!POS_DEPT_PREFIXES.has(upper)) {
      if (UPPER_ACRONYMS.has(upper)) return upper;
      if (/^dt\s+swiss$/i.test(clean)) return 'DT Swiss';
      if (clean === upper && /[A-Z]{3,}/.test(clean)) {
        return clean
          .toLowerCase()
          .replace(/(^|[\s/-])([a-z])/g, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
      }
      return clean;
    }
  }
  return inferBrandFromTitle(fallbackTitle, false) ?? 'UBC Shop';
}

function inferBrandFromTitle(title: string, strictOnly = false): string | null {
  const trimmed = title.trim();
  const upperTokens = trimmed.toUpperCase().split(/[\s/*()-]+/).filter(Boolean);
  for (const tok of upperTokens.slice(0, 5)) {
    if (POS_BRAND_ALIASES[tok]) return POS_BRAND_ALIASES[tok]!;
    if (tok === 'I9') return 'Industry Nine';
    if (tok === 'TARMAC' || tok === 'ROUBAIX' || tok === 'STUMPJUMPER' || tok === 'ROCKHOPPER' || tok === 'SIRRUS') return 'Specialized';
  }
  const lower = ` ${trimmed.toLowerCase().replace(/\*/g, ' ')} `;
  for (const b of KNOWN_CYCLING_BRANDS) {
    const bLow = b.toLowerCase();
    const idx = lower.indexOf(` ${bLow} `);
    if (idx !== -1) return b;
  }
  if (strictOnly) return null;
  // Find first non-department token (e.g. skipping "SHOE", "HEL", "FOOD", "DRINK", "BIKE", "EBIKE", year "26")
  for (const rawTok of trimmed.split(/[\s*]+/)) {
    const cleanTok = rawTok.replace(/[^A-Za-z0-9'-]/g, '');
    if (cleanTok.length < 2 || /^\d+$/.test(cleanTok)) continue;
    const u = cleanTok.toUpperCase();
    if (POS_DEPT_PREFIXES.has(u)) continue;
    if (POS_BRAND_ALIASES[u]) return POS_BRAND_ALIASES[u]!;
    if (UPPER_ACRONYMS.has(u)) return u;
    return cleanTok.charAt(0).toUpperCase() + cleanTok.slice(1).toLowerCase();
  }
  return 'UBC Shop';
}

const DEFAULT_SHOP_NAMES: Record<string, string> = {
  '1': 'UBC Tampa Showroom',
  '2': 'UBC Alafia River Park',
};

/**
 * Set-based batch ingestion of Lightspeed R-Series `LsItem[]` records:
 *  - Links to existing canonical variants by `external_ids (lightspeed_r)`, `sku`, or normalized `upc`.
 *  - Creates canonical `products` (grouping multi-size/color items via `itemMatrixID`) & `variants`
 *    for POS items not yet in Hub.
 *  - Updates `inventory_levels` strictly with `source = 'lightspeed_r'` (physical shop stock is NEVER
 *    summed with distributor `supplier_offers`).
 *  - Stages clean availability updates into `outbound_sync_staging` (`ready_for_shopify`).
 */
/** Lightspeed attribute set names (Color/Size...), loaded once per process. */
let attrSetCache: { at: number; sets: Map<string, [string, string, string]> } | null = null;
async function getAttributeSetNames(ctx: AppContext): Promise<Map<string, [string, string, string]>> {
  if (attrSetCache && Date.now() - attrSetCache.at < 6 * 3600_000) return attrSetCache.sets;
  try {
    const sets = ctx.connectors.lightspeed ? await ctx.connectors.lightspeed.listItemAttributeSets() : new Map();
    attrSetCache = { at: Date.now(), sets };
    return sets;
  } catch {
    return attrSetCache?.sets ?? new Map();
  }
}

export async function ingestLightspeedItemsBatch(
  ctx: AppContext,
  companyId: string,
  rawItems: LsItem[],
  opts: { physicalShopIds?: string[]; publishNew?: boolean } = {},
) {
  if (!rawItems.length) {
    return { seen: 0, createdVariants: 0, updatedVariants: 0, stagedForShopify: 0, latestTimestamp: null as string | null };
  }

  const [settings, locRes, storeRes] = await Promise.all([
    getSettings(ctx.pool, companyId),
    ctx.pool.query<{ id: string; name: string; lightspeed_shop_id: string | null }>(
      `SELECT id, name, lightspeed_shop_id FROM locations WHERE company_id = $1 AND kind = 'physical' ORDER BY (shopify_location_id IS NULL), name`,
      [companyId],
    ),
    ctx.pool.query<{ id: string }>(`SELECT id FROM stores WHERE company_id = $1 ORDER BY created_at LIMIT 1`, [companyId]),
  ]);

  const defaultStoreId = storeRes.rows[0]?.id ?? null;
  const attrSetNames = await getAttributeSetNames(ctx);
  // update_only (Workstand-owned store): stage every changed item; the flush keeps only barcode-linked ones.
  const updateOnly = ctx.config.env.SHOPIFY_SYNC_MODE === 'update_only';
  const configuredShopIds = opts.physicalShopIds;
  const newStatus = opts.publishNew ? 'published' : 'draft';

  // Deduplicate by itemID within the batch (latest wins) & collect active physical shop IDs.
  const byItemId = new Map<string, ReturnType<typeof mapLsItem>>();
  const seenShopIds = new Set<string>();
  let latestTimestamp: string | null = null;
  for (const raw of rawItems) {
    if (!raw.itemID) continue;
    const mapped = mapLsItem(raw, configuredShopIds);
    byItemId.set(mapped.lightspeedItemId, mapped);
    for (const sid of Object.keys(mapped.shopQuantities)) {
      if (!configuredShopIds || configuredShopIds.includes(sid)) seenShopIds.add(sid);
    }
    if (mapped.updatedAt && (!latestTimestamp || mapped.updatedAt > latestTimestamp)) {
      latestTimestamp = mapped.updatedAt;
    }
  }
  const items = [...byItemId.values()];

  // Map each Lightspeed physical shopID ("1" Tampa Showroom, "2" UBC Alafia River Park) to its canonical `locations.id`.
  const locationByShopId = new Map<string, string>();
  let fallbackLocationId: string | null = locRes.rows[0]?.id ?? null;
  for (const l of locRes.rows) {
    if (l.lightspeed_shop_id) locationByShopId.set(l.lightspeed_shop_id, l.id);
  }
  if (defaultStoreId) {
    for (const sid of [...seenShopIds].sort()) {
      if (locationByShopId.has(sid)) continue;
      // Bind primary unmapped physical location to shop "1" if available.
      const unmapped = sid === '1' ? locRes.rows.find((l) => !l.lightspeed_shop_id) : undefined;
      if (unmapped) {
        await ctx.pool.query(`UPDATE locations SET lightspeed_shop_id = $2 WHERE id = $1`, [unmapped.id, sid]);
        unmapped.lightspeed_shop_id = sid;
        locationByShopId.set(sid, unmapped.id);
        continue;
      }
      const locName = DEFAULT_SHOP_NAMES[sid] ?? `UBC Shop #${sid}`;
      const insLoc = await ctx.pool.query<{ id: string }>(
        `INSERT INTO locations (company_id, store_id, name, kind, lightspeed_shop_id)
         VALUES ($1, $2, $3, 'physical', $4)
         ON CONFLICT (company_id, name) DO UPDATE SET lightspeed_shop_id = EXCLUDED.lightspeed_shop_id
         RETURNING id`,
        [companyId, defaultStoreId, locName, sid],
      );
      if (insLoc.rows[0]) {
        locationByShopId.set(sid, insLoc.rows[0].id);
        if (!fallbackLocationId) fallbackLocationId = insLoc.rows[0].id;
      }
    }
  }

  let createdVariants = 0;
  let updatedVariants = 0;
  let stagedForShopify = 0;

  const CHUNK_SIZE = 1000;
  for (let i = 0; i < items.length; i += CHUNK_SIZE) {
    const chunk = items.slice(i, i + CHUNK_SIZE);

    await withTransaction(ctx.pool, async (c) => {
      const lsIds = chunk.map((x) => x.lightspeedItemId);
      const skus = chunk.map((x) => x.sku?.trim()).filter((s): s is string => Boolean(s));
      const gtinKeys = new Set<string>();
      for (const x of chunk) {
        const g14 = normalizeGtin(x.upc);
        if (g14) gtinKeys.add(g14.replace(/^0+/, ''));
        const rawTrim = (x.upc ?? '').replace(/\D+/g, '').replace(/^0+/, '');
        if (rawTrim.length >= 6) gtinKeys.add(rawTrim);
      }
      const normUpcs = [...gtinKeys];

      // 1. Batch lookup existing variants by external_id, SKU, or canonical GTIN/UPC.
      const extRows = await c.query<{ external_id: string; entity_id: string }>(
        `SELECT external_id, entity_id FROM external_ids
         WHERE company_id = $1 AND system = 'lightspeed_r' AND entity_type = 'variant' AND external_id = ANY($2::text[])`,
        [companyId, lsIds],
      );
      const varByLsId = new Map(extRows.rows.map((r) => [r.external_id, r.entity_id]));

      const varBySku = new Map<string, string>();
      const allExistingSkus = new Set<string>();
      if (skus.length > 0) {
        const skuRows = await c.query<{ id: string; sku: string; has_ls: boolean }>(
          `SELECT v.id, v.sku,
                  EXISTS (SELECT 1 FROM external_ids e WHERE e.entity_type = 'variant' AND e.entity_id = v.id AND e.system = 'lightspeed_r') AS has_ls
           FROM variants v
           WHERE v.company_id = $1 AND v.sku = ANY($2::text[])`,
          [companyId, skus],
        );
        for (const r of skuRows.rows) {
          allExistingSkus.add(r.sku);
          if (!r.has_ls) varBySku.set(r.sku, r.id);
        }
      }

      const varByUpc = new Map<string, string>();
      if (normUpcs.length > 0) {
        const upcRows = await c.query<{ id: string; upc: string; k: string }>(
          `SELECT v.id, v.upc, ltrim(v.upc, '0') AS k
           FROM variants v
           WHERE v.company_id = $1 AND v.upc IS NOT NULL AND v.upc <> '' AND ltrim(v.upc, '0') = ANY($2::text[])
             AND NOT EXISTS (SELECT 1 FROM external_ids e WHERE e.entity_type = 'variant' AND e.entity_id = v.id AND e.system = 'lightspeed_r')`,
          [companyId, normUpcs],
        );
        for (const r of upcRows.rows) {
          if (!varByUpc.has(r.k)) varByUpc.set(r.k, r.id);
          const g14 = normalizeGtin(r.upc);
          if (g14 && !varByUpc.has(g14)) varByUpc.set(g14, r.id);
        }
      }

      const existingUpdates: {
        vid: string;
        lsId: string;
        price: number | null;
        compare_at: number | null;
        cost: number | null;
        upc: string | null;
        mpn: string | null;
        qty: number;
        shopQuantities: Record<string, number>;
        options: Record<string, string>;
        sku: string | null;
      }[] = [];

      const newItems: typeof chunk = [];
      const claimedVids = new Set<string>();

      for (const it of chunk) {
        const g14 = normalizeGtin(it.upc);
        const normU = (it.upc ?? '').replace(/\D+/g, '').replace(/^0+/, '');
        const directVid = varByLsId.get(it.lightspeedItemId);
        let matchedVid = directVid;
        if (!matchedVid) {
          const cand =
            (it.sku ? varBySku.get(it.sku.trim()) : undefined)
            ?? (g14 ? varByUpc.get(g14) ?? varByUpc.get(g14.replace(/^0+/, '')) : undefined)
            ?? (normU.length >= 6 ? varByUpc.get(normU) : undefined);
          if (cand && !claimedVids.has(cand)) matchedVid = cand;
        }

        if (matchedVid) {
          claimedVids.add(matchedVid);
          existingUpdates.push({
            vid: matchedVid,
            lsId: it.lightspeedItemId,
            price: it.priceCents !== null && it.priceCents > 0 ? it.priceCents : null,
            compare_at: it.compareAtCents !== null && it.compareAtCents > 0 ? it.compareAtCents : null,
            cost: it.costCents !== null && it.costCents > 0 ? it.costCents : null,
            upc: formatRetailBarcode(it.upc),
            mpn: it.mpn?.trim() || null,
            qty: it.physicalQty,
            shopQuantities: it.shopQuantities,
            options: lsOptionValues(it.itemAttributes ?? undefined, attrSetNames),
            sku: it.sku?.trim() || null,
          });
        } else {
          newItems.push(it);
        }
      }

      const affectedVariantIds = new Set<string>();

      // 2a. Items inside an ACTIVE price-update promo keep the promo price. The new Lightspeed price
      //     becomes the price they go back to when the promo is restored.
      if (existingUpdates.length > 0) {
        const promo = await c.query<{ variant_id: string }>(
          `SELECT DISTINCT cl.variant_id FROM campaign_lines cl JOIN campaigns cp ON cp.id = cl.campaign_id
           WHERE cp.company_id = $1 AND cp.status = 'active' AND cp.strategy = 'variant_price_update'
             AND cl.applied_at IS NOT NULL AND cl.restored_at IS NULL AND cl.variant_id = ANY($2::uuid[])`,
          [companyId, existingUpdates.map((u) => u.vid)],
        );
        if (promo.rows.length) {
          const inPromo = new Set(promo.rows.map((r) => r.variant_id));
          const lsPrices = existingUpdates.filter((u) => inPromo.has(u.vid) && u.price !== null).map((u) => ({ vid: u.vid, p: u.price }));
          if (lsPrices.length) {
            await c.query(
              `UPDATE campaign_lines cl SET old_price_cents = r.p
               FROM jsonb_to_recordset($2::jsonb) AS r(vid uuid, p int), campaigns cp
               WHERE cp.id = cl.campaign_id AND cp.company_id = $1 AND cp.status = 'active' AND cl.variant_id = r.vid
                 AND cl.applied_at IS NOT NULL AND cl.restored_at IS NULL`,
              [companyId, JSON.stringify(lsPrices)],
            );
          }
          for (const u of existingUpdates) if (inPromo.has(u.vid)) u.price = null; // keep promo price & compare-at
        }
      }

      // 2. Bulk update existing variants with Lightspeed Default / SALE PRICE & cost/UPC/MPN.
      if (existingUpdates.length > 0) {
        await c.query(
          `UPDATE variants v
           SET price_cents = COALESCE(r.price, v.price_cents),
               compare_at_cents = CASE WHEN r.price IS NOT NULL THEN r.compare_at ELSE v.compare_at_cents END,
               cost_cents = COALESCE(r.cost, v.cost_cents),
               -- Lightspeed is the source of truth: its UPC, Manufact. SKU and System ID win.
               upc = COALESCE(r.upc, v.upc),
               mpn = COALESCE(r.mpn, v.mpn),
               sku = CASE WHEN r.sku IS NOT NULL AND r.sku <> v.sku
                           AND NOT EXISTS (SELECT 1 FROM variants x WHERE x.company_id = v.company_id AND x.sku = r.sku AND x.id <> v.id)
                          THEN r.sku ELSE v.sku END,
               -- Matrix options (Color/Size) from Lightspeed fill in only when the variant has none yet.
               option_values = CASE WHEN v.option_values = '{}'::jsonb AND r.options IS NOT NULL THEN r.options ELSE v.option_values END,
               updated_at = now()
           FROM jsonb_to_recordset($2::jsonb) AS r(vid uuid, price int, compare_at int, cost int, upc text, mpn text, options jsonb, sku text)
           WHERE v.company_id = $1 AND v.id = r.vid`,
          [companyId, JSON.stringify(existingUpdates)],
        );
        updatedVariants += existingUpdates.length;
        for (const u of existingUpdates) affectedVariantIds.add(u.vid);
      }

      // 3. Bulk create canonical products & variants for new Lightspeed POS items.
      const createdLsLinks: { vid: string; lsId: string; qty: number; shopQuantities: Record<string, number> }[] = [];
      if (newItems.length > 0) {
        const prodMap = new Map<string, {
          ref: string;
          brand: string;
          model: string;
          category: string;
          title: string;
          status: string;
        }>();

        for (const it of newItems) {
          const prodRef = it.matrixId ? `ls-m-${it.matrixId}` : `ls-i-${it.lightspeedItemId}`;
          if (!prodMap.has(prodRef)) {
            const title = (it.title || `POS Item ${it.lightspeedItemId}`).trim();
            const itOpts = lsOptionValues(it.itemAttributes ?? undefined, attrSetNames);
            const baseTitle = it.matrixId
              ? (Object.keys(itOpts).length
                ? lsMatrixBaseTitle(title, itOpts)
                : title.replace(/\s+[-–—/]\s*(XS|S|M|L|XL|XXL|S\d|\d{2}(?:\.\d)?(?:\s*cm|\s*in|c)?)\s*$/i, '').trim() || title)
              : title;
            const category = normalizeCyclingCategory(it.rawCategory, baseTitle);
            const isService = category === 'Workshop Services';
            prodMap.set(prodRef, {
              ref: prodRef,
              brand: formatPosBrand(it.brand, baseTitle),
              model: baseTitle.slice(0, 120),
              category,
              title: baseTitle,
              status: isService ? 'hidden' : newStatus,
            });
          }
        }

        const insProds = await c.query<{ id: string; ref: string }>(
          `INSERT INTO products (company_id, ref, brand, model, category, title, status)
           SELECT $1, r.ref, r.brand, r.model, r.category, r.title, r.status
           FROM jsonb_to_recordset($2::jsonb) AS r(ref text, brand text, model text, category text, title text, status text)
           ON CONFLICT (company_id, ref) DO UPDATE SET
             brand = EXCLUDED.brand,
             category = EXCLUDED.category,
             title = EXCLUDED.title,
             updated_at = now()
           RETURNING id, ref`,
          [companyId, JSON.stringify([...prodMap.values()])],
        );
        const prodIdByRef = new Map(insProds.rows.map((r) => [r.ref, r.id]));

        const seenSku = new Set<string>(allExistingSkus);
        const newVarPayload = newItems.map((it) => {
          const prodRef = it.matrixId ? `ls-m-${it.matrixId}` : `ls-i-${it.lightspeedItemId}`;
          let sku = it.sku?.trim() || `LS-${it.lightspeedItemId}`;
          if (seenSku.has(sku)) sku = `${sku}-${it.lightspeedItemId}`;
          seenSku.add(sku);

          const safeCost = it.costCents !== null && it.costCents > 0 ? it.costCents : null;
          const fallbackCharm99 = safeCost && safeCost > 0
            ? Math.max(99, Math.round((safeCost * 1.65) / 100) * 100 - 1)
            : 1999;
          const safePrice = it.priceCents && it.priceCents > 0
            ? it.priceCents
            : fallbackCharm99;
          const safeCompareAt = it.compareAtCents && it.compareAtCents > safePrice ? it.compareAtCents : null;
          const isService = prodMap.get(prodRef)?.status === 'hidden';

          return {
            lsId: it.lightspeedItemId,
            qty: it.physicalQty,
            shopQuantities: it.shopQuantities,
            pid: prodIdByRef.get(prodRef)!,
            vref: `lsv-${it.lightspeedItemId}`,
            title: (it.title || sku).trim(),
            sku,
            upc: formatRetailBarcode(it.upc),
            mpn: it.mpn?.trim() || null,
            price: safePrice,
            compare_at: safeCompareAt,
            cost: safeCost,
            options: lsOptionValues(it.itemAttributes ?? undefined, attrSetNames),
            status: isService ? 'hidden' : newStatus,
          };
        });

        const insVars = await c.query<{ id: string; sku: string }>(
          `INSERT INTO variants (
             company_id, product_id, ref, title, sku, upc, mpn, price_cents, compare_at_cents, cost_cents, option_values, status
           )
           SELECT $1, r.pid, r.vref, r.title, r.sku, r.upc, r.mpn, r.price, r.compare_at, r.cost, COALESCE(r.options, '{}'::jsonb), r.status
           FROM jsonb_to_recordset($2::jsonb) AS r(
             pid uuid, vref text, title text, sku text, upc text, mpn text, price int, compare_at int, cost int, options jsonb, status text
           )
           ON CONFLICT (company_id, sku) DO UPDATE SET
             price_cents = EXCLUDED.price_cents,
             compare_at_cents = EXCLUDED.compare_at_cents,
             cost_cents = COALESCE(EXCLUDED.cost_cents, variants.cost_cents),
             upc = COALESCE(variants.upc, EXCLUDED.upc),
             mpn = COALESCE(variants.mpn, EXCLUDED.mpn),
             updated_at = now()
           RETURNING id, sku`,
          [companyId, JSON.stringify(newVarPayload)],
        );
        createdVariants += insVars.rowCount ?? 0;
        const vidBySku = new Map(insVars.rows.map((r) => [r.sku, r.id]));
        for (const nv of newVarPayload) {
          const vid = vidBySku.get(nv.sku);
          if (vid) {
            createdLsLinks.push({ vid, lsId: nv.lsId, qty: nv.qty, shopQuantities: nv.shopQuantities });
            affectedVariantIds.add(vid);
          }
        }
      }

      // 4. Bulk upsert external_ids (`system = 'lightspeed_r'`) and per-shop physical `inventory_levels`.
      const allLsMappings = [
        ...existingUpdates.map((u) => ({ vid: u.vid, lsId: u.lsId, qty: u.qty, shopQuantities: u.shopQuantities })),
        ...createdLsLinks,
      ];
      // Deduplicate by variant_id so ON CONFLICT never touches a row twice.
      const dedupByVid = new Map<string, { vid: string; lsId: string; qty: number; shopQuantities: Record<string, number> }>();
      for (const m of allLsMappings) dedupByVid.set(m.vid, m);
      const uniqueMappings = [...dedupByVid.values()];

      if (uniqueMappings.length > 0) {
        await c.query(
          `INSERT INTO external_ids (company_id, entity_type, entity_id, system, external_id)
           SELECT $1, 'variant', r.vid, 'lightspeed_r', r.ls_id
           FROM jsonb_to_recordset($2::jsonb) AS r(vid uuid, ls_id text)
           ON CONFLICT (company_id, system, entity_type, entity_id) DO UPDATE SET external_id = EXCLUDED.external_id`,
          [companyId, JSON.stringify(uniqueMappings.map((m) => ({ vid: m.vid, ls_id: m.lsId })))],
        );

        const positiveInvRows: { vid: string; lid: string; qty: number }[] = [];
        const zeroInvRows: { vid: string; lid: string }[] = [];

        for (const m of uniqueMappings) {
          const shopEntries = Object.entries(m.shopQuantities).filter(([sid]) => !configuredShopIds || configuredShopIds.includes(sid));
          if (shopEntries.length > 0 && locationByShopId.size > 0) {
            for (const [sid, sqty] of shopEntries) {
              const lid = locationByShopId.get(sid);
              if (!lid) continue;
              if (sqty > 0) positiveInvRows.push({ vid: m.vid, lid, qty: sqty });
              else zeroInvRows.push({ vid: m.vid, lid });
            }
          } else if (fallbackLocationId) {
            if (m.qty > 0) positiveInvRows.push({ vid: m.vid, lid: fallbackLocationId, qty: m.qty });
            else zeroInvRows.push({ vid: m.vid, lid: fallbackLocationId });
          }
        }

        if (positiveInvRows.length > 0) {
          await c.query(
            `INSERT INTO inventory_levels (variant_id, location_id, company_id, on_hand, reserved, source, updated_at)
             SELECT r.vid, r.lid, $1, r.qty, 0, 'lightspeed_r', now()
             FROM jsonb_to_recordset($2::jsonb) AS r(vid uuid, lid uuid, qty int)
             ON CONFLICT (variant_id, location_id) DO UPDATE SET
               on_hand = EXCLUDED.on_hand,
               source = 'lightspeed_r',
               updated_at = now()`,
            [companyId, JSON.stringify(positiveInvRows)],
          );
        }

        if (zeroInvRows.length > 0) {
          await c.query(
            `DELETE FROM inventory_levels il
             USING jsonb_to_recordset($2::jsonb) AS r(vid uuid, lid uuid)
             WHERE il.company_id = $1 AND il.variant_id = r.vid AND il.location_id = r.lid AND il.reserved = 0`,
            [companyId, JSON.stringify(zeroInvRows)],
          );
          await c.query(
            `UPDATE inventory_levels il
             SET on_hand = 0, source = 'lightspeed_r', updated_at = now()
             FROM jsonb_to_recordset($2::jsonb) AS r(vid uuid, lid uuid)
             WHERE il.company_id = $1 AND il.variant_id = r.vid AND il.location_id = r.lid AND il.reserved > 0`,
            [companyId, JSON.stringify(zeroInvRows)],
          );
        }
      }

      // 5. Recompute availability (strictly keeping physical stock separate from supplier offers!) & stage for Shopify.
      // Only stage variants already linked to Shopify OR explicitly requested via `publishNew: true`,
      // so unphotographed POS nuts/bolts/labor never flood the live Shopify storefront automatically!
      if (affectedVariantIds.size > 0) {
        const catRows = await c.query(
          `SELECT * FROM catalog_items WHERE company_id = $1 AND id = ANY($2::uuid[])`,
          [companyId, [...affectedVariantIds]],
        );
        const stagingBatch = catRows.rows
          .map((raw) => rowToItem(raw as never))
          .filter((item) => Boolean(item.shopifyVariantId) || Boolean(opts.publishNew) || updateOnly)
          .map((item) => {
            const av = computeAvailability(item, settings.availability);
            const clickAndCollectOnly = item.brand.toLowerCase() === 'specialized' && item.category.toLowerCase().includes('bike');
            return {
              vid: item.id,
              payload: {
                publishedQty: av.shopify.publishedQty,
                inventoryPolicy: av.shopify.inventoryPolicy,
                availability: av.status,
                leadTimeDays: av.shopify.leadTimeDays,
                clickAndCollectOnly,
              },
            };
          });

        if (stagingBatch.length > 0) {
          await c.query(
            `INSERT INTO outbound_sync_staging (
               company_id, store_id, variant_id, stream, decision, hold_reasons, shopify_payload, status, updated_at
             )
             SELECT $1, $2, r.vid, 'availability', 'ready_for_shopify', '[]'::jsonb, r.payload, 'pending', now()
             FROM jsonb_to_recordset($3::jsonb) AS r(vid uuid, payload jsonb)
             ON CONFLICT (company_id, variant_id, stream) DO UPDATE SET
               decision = 'ready_for_shopify',
               hold_reasons = '[]'::jsonb,
               shopify_payload = EXCLUDED.shopify_payload,
               status = 'pending',
               updated_at = now()`,
            [companyId, defaultStoreId, JSON.stringify(stagingBatch)],
          );
          stagedForShopify += stagingBatch.length;
        }
      }
    });
  }

  return {
    seen: items.length,
    createdVariants,
    updatedVariants,
    stagedForShopify,
    latestTimestamp,
  };
}

/**
 * Worker job: incremental or full catalog + physical inventory sync from Lightspeed Retail R-Series.
 */
export async function syncFromLightspeedJob(
  ctx: AppContext,
  companyId: string,
  opts: { full?: boolean; publishNew?: boolean } = {},
  jobId?: number,
) {
  const ls = ctx.connectors.lightspeed;
  if (ls) await ls.ensureConfigured();
  if (!ls || ls.missing().length > 0) {
    const missing = ls ? ls.missing() : ['DEMO mode — Lightspeed R-Series OAuth runs in LIVE mode'];
    await ctx.pool.query(
      `INSERT INTO integration_connections (company_id, system, status, detail, missing, writes_enabled, last_checked_at)
       VALUES ($1, 'lightspeed_r', 'not_connected', 'Awaiting Lightspeed R-Series OAuth credentials', $2, false, now())
       ON CONFLICT (company_id, system) DO UPDATE SET
         status = 'not_connected',
         missing = EXCLUDED.missing,
         last_checked_at = now()`,
      [companyId, JSON.stringify(missing)],
    );
    return { status: 'awaiting_oauth_credentials', missing, seen: 0 };
  }

  const connRow = await ctx.pool.query<{ sync_cursor: string | null }>(
    `SELECT sync_cursor FROM integration_connections WHERE company_id = $1 AND system = 'lightspeed_r'`,
    [companyId],
  );
  const sinceCursor = opts.full ? undefined : (connRow.rows[0]?.sync_cursor ?? undefined);

  let seen = 0;
  let createdVariants = 0;
  let updatedVariants = 0;
  let stagedForShopify = 0;
  let latestCursor = sinceCursor ?? null;
  let buffer: LsItem[] = [];

  const flushBuffer = async () => {
    if (!buffer.length) return;
    const batch = buffer;
    buffer = [];
    const r = await ingestLightspeedItemsBatch(ctx, companyId, batch, { publishNew: opts.publishNew });
    seen += r.seen;
    createdVariants += r.createdVariants;
    updatedVariants += r.updatedVariants;
    stagedForShopify += r.stagedForShopify;
    if (r.latestTimestamp && (!latestCursor || r.latestTimestamp > latestCursor)) {
      latestCursor = r.latestTimestamp;
    }
    if (jobId) {
      await setProgress(ctx.pool, jobId, { seen, createdVariants, updatedVariants, stagedForShopify, latestCursor });
    }
  };

  for await (const page of ls.iterateItems(sinceCursor)) {
    buffer.push(...page);
    if (buffer.length >= 500) {
      await flushBuffer();
    }
  }
  await flushBuffer();

  // Remove/hide any Lightspeed items archived since last sync so archived items never stay in the Hub.
  if (sinceCursor && typeof ls.iterateArchivedIds === 'function') {
    const archivedIds: string[] = [];
    for await (const ids of ls.iterateArchivedIds(sinceCursor)) {
      archivedIds.push(...ids);
    }
    if (archivedIds.length > 0) {
      const found = await ctx.pool.query<{ entity_id: string }>(
        `SELECT entity_id FROM external_ids
         WHERE company_id = $1 AND system = 'lightspeed_r' AND entity_type = 'variant' AND external_id = ANY($2::text[])`,
        [companyId, archivedIds],
      );
      if (found.rows.length > 0) {
        const vids = found.rows.map((r) => r.entity_id);
        await ctx.pool.query(
          `DELETE FROM variants v
           WHERE v.company_id = $1 AND v.id = ANY($2::uuid[])
             AND NOT EXISTS (SELECT 1 FROM order_lines ol WHERE ol.variant_id = v.id)
             AND NOT EXISTS (SELECT 1 FROM campaign_lines cl WHERE cl.variant_id = v.id)
             AND NOT EXISTS (SELECT 1 FROM purchase_order_lines pol WHERE pol.variant_id = v.id)`,
          [companyId, vids],
        );
        await ctx.pool.query(
          `DELETE FROM external_ids e
           WHERE e.company_id = $1 AND e.system = 'lightspeed_r' AND e.entity_type = 'variant'
             AND NOT EXISTS (SELECT 1 FROM variants v WHERE v.id = e.entity_id)`,
          [companyId],
        );
        await ctx.pool.query(
          `UPDATE products p SET status = 'hidden', updated_at = now()
           FROM variants v
           WHERE p.company_id = $1 AND v.product_id = p.id AND v.id = ANY($2::uuid[]) AND p.status <> 'hidden'`,
          [companyId, vids],
        );
        await ctx.pool.query(`DELETE FROM inventory_levels WHERE variant_id = ANY($1::uuid[])`, [vids]);
      }
    }
  }

  await ctx.pool.query(
    `INSERT INTO integration_connections (
       company_id, system, status, detail, missing, writes_enabled, last_checked_at, sync_cursor, last_synced_at, records_synced
     )
     VALUES ($1, 'lightspeed_r', 'connected', 'Synced from Lightspeed R-Series', '[]'::jsonb, false, now(), $2, now(), $3)
     ON CONFLICT (company_id, system) DO UPDATE SET
       status = 'connected',
       detail = EXCLUDED.detail,
       missing = '[]'::jsonb,
       last_checked_at = now(),
       sync_cursor = COALESCE(EXCLUDED.sync_cursor, integration_connections.sync_cursor),
       last_synced_at = now(),
       records_synced = integration_connections.records_synced + EXCLUDED.records_synced`,
    [companyId, latestCursor, seen],
  );

  if (stagedForShopify > 0) {
    await enqueue(ctx.pool, {
      companyId,
      type: 'pipeline.flush_shopify',
      payload: { trigger: 'lightspeed_sync', stagedForShopify },
    });
  }

  const summary = { status: 'synced', seen, createdVariants, updatedVariants, stagedForShopify, latestCursor };
  await audit(ctx.pool, { companyId, action: 'lightspeed.catalog_synced', detail: summary });
  return summary;
}

/**
 * Worker job: read-only polling of Lightspeed R-Series `/SpecialOrder.json` to detect
 * when UBC reception receives a special-order bike/part at the Tampa counter.
 */
export async function syncLightspeedSpecialOrdersJob(ctx: AppContext, companyId: string) {
  const ls = ctx.connectors.lightspeed;
  if (ls) await ls.ensureConfigured();
  if (!ls || ls.missing().length > 0) {
    return { status: 'awaiting_oauth_credentials', checked: 0, updatedOrders: 0 };
  }

  let checked = 0;
  let updatedOrders = 0;

  try {
    for await (const page of ls.iterateSpecialOrders()) {
      for (const rawSo of page as LsSpecialOrder[]) {
        checked++;
        const so = mapLsSpecialOrder(rawSo);
        if (!so.referenceOrderNumber || (so.status !== 'ready' && so.status !== 'completed')) continue;

        const idempKey = `ls-so:${so.specialOrderId}:${so.status}`;
        const ev = await ctx.pool.query<{ id: number }>(
          `INSERT INTO sync_events (company_id, source, topic, idempotency_key, payload, status, processed_at)
           VALUES ($1, 'lightspeed_r', 'special_order.status', $2, $3, 'processed', now())
           ON CONFLICT (company_id, source, idempotency_key) DO NOTHING
           RETURNING id`,
          [companyId, idempKey, JSON.stringify(so)],
        );
        if (!ev.rows[0]) continue;

        const nextInternal = so.status === 'completed' ? 'completed' : 'ready_for_pickup';
        const upd = await ctx.pool.query<{ id: string; internal_status: string }>(
          `UPDATE orders
           SET internal_status = $3, updated_at = now()
           WHERE company_id = $1 AND upper(number) = upper($2)
             AND internal_status NOT IN ('completed', 'cancelled', $3)
           RETURNING id, internal_status`,
          [companyId, so.referenceOrderNumber, nextInternal],
        );
        if (upd.rows[0]) {
          await ctx.pool.query(
            `INSERT INTO order_events (order_id, from_status, to_status, actor, note)
             VALUES ($1, NULL, $2, 'lightspeed_r', $3)`,
            [
              upd.rows[0].id,
              nextInternal,
              `Lightspeed R-Series SpecialOrder #${so.specialOrderId} marked ${so.status} (qty ready: ${so.qtyReady})`,
            ],
          );
          updatedOrders++;
        }
      }
    }
  } catch (err) {
    if (/HTTP (401|403)\b/i.test((err as Error)?.message ?? '')) {
      return { status: 'skipped_read_only_inventory_scope', checked: 0, updatedOrders: 0 };
    }
    throw err;
  }

  return { status: 'synced', checked, updatedOrders };
}
