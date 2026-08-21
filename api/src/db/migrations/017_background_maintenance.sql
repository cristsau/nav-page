CREATE INDEX IF NOT EXISTS idx_media_assets_delete_retry
  ON media_assets (
    (COALESCE(last_delete_attempt_at, delete_requested_at, created_at)) ASC,
    id ASC
  ) INCLUDE (user_id, delete_attempts)
  WHERE retention = 'auto'
    AND state IN ('delete_pending', 'delete_failed');
