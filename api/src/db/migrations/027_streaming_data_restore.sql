CREATE TABLE IF NOT EXISTS data_restore_stream_uploads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'uploading',
  backup_header JSONB NOT NULL DEFAULT '{}'::jsonb,
  counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload_sha256 TEXT,
  payload_bytes BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '1 hour'),
  CONSTRAINT data_restore_stream_uploads_status_check
    CHECK (status IN ('uploading', 'ready', 'applied', 'failed')),
  CONSTRAINT data_restore_stream_uploads_header_check
    CHECK (jsonb_typeof(backup_header) = 'object'),
  CONSTRAINT data_restore_stream_uploads_counts_check
    CHECK (jsonb_typeof(counts) = 'object'),
  CONSTRAINT data_restore_stream_uploads_digest_check
    CHECK (payload_sha256 IS NULL OR payload_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT data_restore_stream_uploads_bytes_check CHECK (payload_bytes >= 0),
  CONSTRAINT data_restore_stream_uploads_expiry_check CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_data_restore_stream_uploads_expiry
  ON data_restore_stream_uploads (expires_at);
CREATE INDEX IF NOT EXISTS idx_data_restore_stream_uploads_user_session
  ON data_restore_stream_uploads (user_id, session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS data_restore_stream_records (
  upload_id UUID NOT NULL REFERENCES data_restore_stream_uploads(id) ON DELETE CASCADE,
  collection TEXT NOT NULL,
  ordinal BIGINT NOT NULL,
  record JSONB NOT NULL,
  CONSTRAINT data_restore_stream_records_pkey PRIMARY KEY (upload_id, collection, ordinal),
  CONSTRAINT data_restore_stream_records_collection_check CHECK (
    collection IN (
      'groups',
      'bookmarks',
      'notes',
      'customEngines',
      'shares',
      'settings',
      'mediaAssets'
    )
  ),
  CONSTRAINT data_restore_stream_records_ordinal_check CHECK (ordinal >= 0),
  CONSTRAINT data_restore_stream_records_record_check CHECK (jsonb_typeof(record) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_data_restore_stream_records_upload_order
  ON data_restore_stream_records (upload_id, collection, ordinal);
