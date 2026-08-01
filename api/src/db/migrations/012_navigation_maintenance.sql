ALTER TABLE nav_bookmarks
  ADD COLUMN IF NOT EXISTS health_status TEXT NOT NULL DEFAULT 'unchecked',
  ADD COLUMN IF NOT EXISTS health_http_status INTEGER,
  ADD COLUMN IF NOT EXISTS health_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS health_failure_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS health_error_code TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'nav_bookmarks_health_status_check'
      AND conrelid = 'nav_bookmarks'::regclass
  ) THEN
    ALTER TABLE nav_bookmarks
      ADD CONSTRAINT nav_bookmarks_health_status_check
      CHECK (
        health_status IN (
          'unchecked',
          'healthy',
          'redirected',
          'protected',
          'throttled',
          'suspect',
          'broken',
          'unsupported'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'nav_bookmarks_health_http_status_check'
      AND conrelid = 'nav_bookmarks'::regclass
  ) THEN
    ALTER TABLE nav_bookmarks
      ADD CONSTRAINT nav_bookmarks_health_http_status_check
      CHECK (
        health_http_status IS NULL
        OR health_http_status BETWEEN 100 AND 599
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'nav_bookmarks_health_failure_count_check'
      AND conrelid = 'nav_bookmarks'::regclass
  ) THEN
    ALTER TABLE nav_bookmarks
      ADD CONSTRAINT nav_bookmarks_health_failure_count_check
      CHECK (health_failure_count >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'nav_bookmarks_health_error_code_check'
      AND conrelid = 'nav_bookmarks'::regclass
  ) THEN
    ALTER TABLE nav_bookmarks
      ADD CONSTRAINT nav_bookmarks_health_error_code_check
      CHECK (
        health_error_code IS NULL
        OR health_error_code IN (
          'invalid_url',
          'unsupported_protocol',
          'credentials_not_allowed',
          'unsupported_port',
          'unsafe_target',
          'dns_error',
          'timeout',
          'tls_error',
          'connection_error',
          'invalid_redirect',
          'too_many_redirects',
          'http_error'
        )
      );
  END IF;
END $$;
