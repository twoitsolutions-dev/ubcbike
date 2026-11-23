import { z } from 'zod';
import type { Pool } from '@ubc/database';
import { audit, logError } from './audit.js';
import { HttpError, notFound, type AppContext } from './context.js';

export interface ReviewSourceRow {
  location_key: string;
  name: string;
  address: string;
  place_id: string;
  rating: string | number;
  total_reviews: number;
  google_maps_url: string;
  synced_at: Date | null;
}

export interface ReviewRow {
  id: string;
  location_key: string;
  external_id: string | null;
  author_name: string;
  rating: number;
  text: string;
  relative_time: string;
  published_at: Date;
  source: string;
  featured: boolean;
  hidden: boolean;
  created_at: Date;
}

const DEFAULT_SOURCES = [
  {
    locationKey: 'tampa',
    name: 'University Bicycle Center · Tampa',
    address: '1220 E Fletcher Ave, Tampa, FL 33612',
    googleMapsUrl: 'https://www.google.com/maps/search/?api=1&query=University+Bicycle+Center+1220+E+Fletcher+Ave+Tampa+FL',
  },
  {
    locationKey: 'alafia',
    name: 'UBC at Alafia River State Park',
    address: '14326 S County Rd 39, Lithia, FL 33547',
    googleMapsUrl: 'https://www.google.com/maps/search/?api=1&query=UBC+Alafia+River+State+Park+Lithia+FL',
  },
];

export const reviewSourcesUpdateSchema = z.object({
  sources: z.array(z.object({
    locationKey: z.enum(['tampa', 'alafia']),
    placeId: z.string().trim().max(120).default(''),
    rating: z.coerce.number().min(0).max(5).default(0),
    totalReviews: z.coerce.number().int().min(0).max(1000000).default(0),
    googleMapsUrl: z.string().trim().max(500).default(''),
  })).min(1).max(4),
});

export const manualReviewSchema = z.object({
  locationKey: z.enum(['tampa', 'alafia']).default('tampa'),
  authorName: z.string().trim().min(1).max(80),
  rating: z.coerce.number().int().min(1).max(5).default(5),
  text: z.string().trim().min(5).max(1200),
  relativeTime: z.string().trim().max(60).default(''),
  featured: z.boolean().default(true),
});

export const toggleReviewSchema = z.object({
  featured: z.boolean().optional(),
  hidden: z.boolean().optional(),
});

async function ensureDefaultSources(pool: Pool, companyId: string) {
  for (const s of DEFAULT_SOURCES) {
    await pool.query(
      `INSERT INTO google_review_sources (company_id, location_key, name, address, google_maps_url)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (company_id, location_key) DO NOTHING`,
      [companyId, s.locationKey, s.name, s.address, s.googleMapsUrl],
    );
  }
}

function summarizeSources(sources: ReviewSourceRow[]) {
  let weighted = 0;
  let total = 0;
  for (const s of sources) {
    const count = Number(s.total_reviews || 0);
    const r = Number(s.rating || 0);
    if (count > 0 && r > 0) {
      weighted += r * count;
      total += count;
    }
  }
  const avg = total > 0 ? Math.round((weighted / total) * 10) / 10 : 0;
  return { rating: avg, totalReviews: total };
}

export async function getReviewsState(pool: Pool, companyId: string) {
  await ensureDefaultSources(pool, companyId);
  const [srcRes, revRes] = await Promise.all([
    pool.query<ReviewSourceRow>(
      `SELECT location_key, name, address, place_id, rating, total_reviews, google_maps_url, synced_at
       FROM google_review_sources
       WHERE company_id = $1
       ORDER BY CASE location_key WHEN 'tampa' THEN 0 ELSE 1 END, location_key`,
      [companyId],
    ),
    pool.query<ReviewRow>(
      `SELECT id, location_key, external_id, author_name, rating, text, relative_time, published_at, source, featured, hidden, created_at
       FROM google_reviews
       WHERE company_id = $1
       ORDER BY hidden ASC, featured DESC, published_at DESC, created_at DESC
       LIMIT 100`,
      [companyId],
    ),
  ]);
  const sources = srcRes.rows.map((s) => ({
    locationKey: s.location_key,
    name: s.name,
    address: s.address,
    placeId: s.place_id,
    rating: Number(s.rating || 0),
    totalReviews: Number(s.total_reviews || 0),
    googleMapsUrl: s.google_maps_url,
    syncedAt: s.synced_at,
  }));
  return {
    apiConfigured: Boolean(process.env.GOOGLE_PLACES_API_KEY?.trim()),
    summary: summarizeSources(srcRes.rows),
    sources,
    reviews: revRes.rows,
  };
}

export async function updateReviewSources(
  ctx: AppContext,
  companyId: string,
  userId: string,
  input: z.infer<typeof reviewSourcesUpdateSchema>,
) {
  await ensureDefaultSources(ctx.pool, companyId);
  for (const s of input.sources) {
    await ctx.pool.query(
      `UPDATE google_review_sources
       SET place_id = $3, rating = $4, total_reviews = $5, google_maps_url = $6, updated_at = now()
       WHERE company_id = $1 AND location_key = $2`,
      [companyId, s.locationKey, s.placeId, s.rating, s.totalReviews, s.googleMapsUrl],
    );
  }
  await audit(ctx.pool, { companyId, userId, action: 'reviews.sources_updated', detail: { count: input.sources.length } });
  return getReviewsState(ctx.pool, companyId);
}

interface PlacesV1Response {
  displayName?: { text?: string };
  rating?: number;
  userRatingCount?: number;
  googleMapsUri?: string;
  reviews?: Array<{
    name?: string;
    rating?: number;
    relativePublishTimeDescription?: string;
    publishTime?: string;
    text?: { text?: string };
    originalText?: { text?: string };
    authorAttribution?: { displayName?: string };
  }>;
}

export async function syncGoogleReviews(ctx: AppContext, companyId: string, userId: string) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY?.trim();
  if (!apiKey) {
    throw new HttpError(
      400,
      'NOT_CONFIGURED',
      'GOOGLE_PLACES_API_KEY is not set on the server. Add it in Hostinger environment variables to sync directly from Google, or add verified Google reviews manually below.',
    );
  }
  const state = await getReviewsState(ctx.pool, companyId);
  const withPlaceId = state.sources.filter((s) => s.placeId.trim().length > 0);
  if (!withPlaceId.length) {
    throw new HttpError(400, 'VALIDATION', 'Save at least one Google Place ID (Tampa or Alafia) before syncing.');
  }

  let syncedLocations = 0;
  let upsertedReviews = 0;

  for (const src of withPlaceId) {
    const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(src.placeId.trim())}`;
    const res = await fetch(url, {
      headers: {
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'displayName,rating,userRatingCount,googleMapsUri,reviews',
      },
    });
    if (!res.ok) {
      const body = await res.text();
      await logError(ctx.pool, {
        companyId,
        source: 'reviews:google_places_sync',
        message: `Places API HTTP ${res.status} for ${src.locationKey}: ${body.slice(0, 200)}`,
      }).catch(() => {});
      throw new HttpError(502, 'UPSTREAM_ERROR', `Google Places API failed for ${src.name} (HTTP ${res.status}).`);
    }
    const data = (await res.json()) as PlacesV1Response;
    await ctx.pool.query(
      `UPDATE google_review_sources
       SET rating = COALESCE($3, rating),
           total_reviews = COALESCE($4, total_reviews),
           google_maps_url = COALESCE(NULLIF($5, ''), google_maps_url),
           synced_at = now(),
           updated_at = now()
       WHERE company_id = $1 AND location_key = $2`,
      [companyId, src.locationKey, data.rating ?? null, data.userRatingCount ?? null, data.googleMapsUri ?? ''],
    );
    syncedLocations += 1;

    for (const r of data.reviews || []) {
      const text = String(r.originalText?.text || r.text?.text || '').trim();
      const author = String(r.authorAttribution?.displayName || '').trim();
      if (!text || !author) continue;
      const extId = String(r.name || `${author}:${r.publishTime || ''}`).slice(0, 200);
      const publishedAt = r.publishTime ? new Date(r.publishTime) : new Date();
      await ctx.pool.query(
        `INSERT INTO google_reviews
           (company_id, location_key, external_id, author_name, rating, text, relative_time, published_at, source, featured, hidden)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'google_api', true, false)
         ON CONFLICT (company_id, location_key, external_id) WHERE external_id IS NOT NULL
         DO UPDATE SET
           author_name = EXCLUDED.author_name,
           rating = EXCLUDED.rating,
           text = EXCLUDED.text,
           relative_time = EXCLUDED.relative_time,
           published_at = EXCLUDED.published_at`,
        [
          companyId,
          src.locationKey,
          extId,
          author,
          Math.max(1, Math.min(5, Math.round(r.rating || 5))),
          text,
          String(r.relativePublishTimeDescription || ''),
          Number.isNaN(publishedAt.getTime()) ? new Date() : publishedAt,
        ],
      );
      upsertedReviews += 1;
    }
  }

  await audit(ctx.pool, {
    companyId,
    userId,
    action: 'reviews.google_synced',
    detail: { syncedLocations, upsertedReviews },
  });
  return { ...(await getReviewsState(ctx.pool, companyId)), syncedLocations, upsertedReviews };
}

export async function addManualReview(
  ctx: AppContext,
  companyId: string,
  userId: string,
  input: z.infer<typeof manualReviewSchema>,
) {
  await ensureDefaultSources(ctx.pool, companyId);
  const r = await ctx.pool.query<ReviewRow>(
    `INSERT INTO google_reviews
       (company_id, location_key, author_name, rating, text, relative_time, source, featured, hidden)
     VALUES ($1, $2, $3, $4, $5, $6, 'manual', $7, false)
     RETURNING *`,
    [companyId, input.locationKey, input.authorName, input.rating, input.text, input.relativeTime, input.featured],
  );
  await audit(ctx.pool, {
    companyId,
    userId,
    action: 'reviews.manual_added',
    detail: { id: r.rows[0]!.id, locationKey: input.locationKey },
  });
  return r.rows[0]!;
}

export async function updateReviewFlags(
  ctx: AppContext,
  companyId: string,
  userId: string,
  id: string,
  input: z.infer<typeof toggleReviewSchema>,
) {
  const r = await ctx.pool.query<ReviewRow>(
    `UPDATE google_reviews
     SET featured = COALESCE($3, featured),
         hidden = COALESCE($4, hidden)
     WHERE id = $1 AND company_id = $2
     RETURNING *`,
    [id, companyId, input.featured ?? null, input.hidden ?? null],
  );
  if (!r.rowCount) throw notFound('Review');
  await audit(ctx.pool, { companyId, userId, action: 'reviews.updated', detail: { id, ...input } });
  return r.rows[0]!;
}

export async function deleteReview(ctx: AppContext, companyId: string, userId: string, id: string) {
  const r = await ctx.pool.query(`DELETE FROM google_reviews WHERE id = $1 AND company_id = $2 RETURNING id`, [id, companyId]);
  if (!r.rowCount) throw notFound('Review');
  await audit(ctx.pool, { companyId, userId, action: 'reviews.deleted', detail: { id } });
  return { ok: true };
}

export async function publishReviewsToShopify(ctx: AppContext, companyId: string, userId: string) {
  if (ctx.config.mode === 'live' && !ctx.config.env.SHOPIFY_WRITES_ENABLED) {
    throw new HttpError(400, 'WRITES_DISABLED', 'SHOPIFY_WRITES_ENABLED is false.');
  }
  const state = await getReviewsState(ctx.pool, companyId);
  const visible = state.reviews.filter((r) => !r.hidden).slice(0, 24);
  const payload = {
    updatedAt: new Date().toISOString(),
    summary: state.summary,
    locations: state.sources.map((s) => ({
      key: s.locationKey,
      name: s.name,
      address: s.address,
      rating: s.rating,
      totalReviews: s.totalReviews,
      googleMapsUrl: s.googleMapsUrl,
    })),
    reviews: visible.map((r) => ({
      id: r.id,
      location: r.location_key,
      author: r.author_name,
      rating: r.rating,
      text: r.text,
      relativeTime: r.relative_time || 'Verified Google Review',
      source: r.source,
      featured: r.featured,
    })),
  };

  const { themesUpdated } = await ctx.connectors.shopify.upsertThemeAsset(
    'assets/ubc-reviews.json',
    JSON.stringify(payload),
  );
  await audit(ctx.pool, {
    companyId,
    userId,
    action: 'reviews.published_to_shopify',
    detail: { count: visible.length, themesUpdated },
  });
  return { count: visible.length, themesUpdated, summary: state.summary };
}
