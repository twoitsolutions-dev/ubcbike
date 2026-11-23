CREATE TABLE IF NOT EXISTS google_review_sources (
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  location_key TEXT NOT NULL,
  name TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  place_id TEXT NOT NULL DEFAULT '',
  rating NUMERIC(3,2) NOT NULL DEFAULT 0,
  total_reviews INTEGER NOT NULL DEFAULT 0,
  google_maps_url TEXT NOT NULL DEFAULT '',
  synced_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, location_key)
);

CREATE TABLE IF NOT EXISTS google_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  location_key TEXT NOT NULL,
  external_id TEXT,
  author_name TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  text TEXT NOT NULL,
  relative_time TEXT NOT NULL DEFAULT '',
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source TEXT NOT NULL DEFAULT 'manual',
  featured BOOLEAN NOT NULL DEFAULT true,
  hidden BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS google_reviews_external_uniq
  ON google_reviews (company_id, location_key, external_id)
  WHERE external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS google_reviews_company_idx
  ON google_reviews (company_id, hidden, featured DESC, published_at DESC);
