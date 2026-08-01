CREATE TABLE IF NOT EXISTS media_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  upstream_id TEXT NOT NULL UNIQUE,
  url TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size BIGINT NOT NULL,
  source TEXT NOT NULL DEFAULT 'reconciled',
  retention TEXT NOT NULL DEFAULT 'auto',
  state TEXT NOT NULL DEFAULT 'active',
  missing_observations INTEGER NOT NULL DEFAULT 0,
  delete_attempts INTEGER NOT NULL DEFAULT 0,
  delete_requested_at TIMESTAMPTZ,
  last_delete_attempt_at TIMESTAMPTZ,
  last_delete_error TEXT NOT NULL DEFAULT '',
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT media_assets_upstream_id_not_blank CHECK (BTRIM(upstream_id) <> ''),
  CONSTRAINT media_assets_url_not_blank CHECK (BTRIM(url) <> ''),
  CONSTRAINT media_assets_name_not_blank CHECK (BTRIM(name) <> ''),
  CONSTRAINT media_assets_mime_image_check CHECK (mime IN (
    'image/gif',
    'image/jpeg',
    'image/png',
    'image/webp'
  )),
  CONSTRAINT media_assets_size_check CHECK (size > 0),
  CONSTRAINT media_assets_source_check CHECK (source IN (
    'note',
    'library',
    'reconciled'
  )),
  CONSTRAINT media_assets_retention_check CHECK (retention IN ('auto', 'keep')),
  CONSTRAINT media_assets_state_check CHECK (state IN (
    'active',
    'orphan',
    'delete_pending',
    'delete_failed',
    'missing',
    'deleted'
  )),
  CONSTRAINT media_assets_missing_observations_check CHECK (missing_observations >= 0),
  CONSTRAINT media_assets_delete_attempts_check CHECK (delete_attempts >= 0)
);

CREATE INDEX IF NOT EXISTS idx_media_assets_user_created
  ON media_assets (user_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_media_assets_user_state
  ON media_assets (user_id, state, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_media_assets_user_retention
  ON media_assets (user_id, retention, updated_at DESC);
