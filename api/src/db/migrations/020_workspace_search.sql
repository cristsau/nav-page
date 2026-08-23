-- Workspace search has a zero-extension baseline. pg_trgm is enabled only
-- when the server exposes it and the migration role is allowed to install it.
-- A missing/forbidden extension must never block the NAV release.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_available_extensions
    WHERE name = 'pg_trgm'
  ) THEN
    BEGIN
      CREATE EXTENSION IF NOT EXISTS pg_trgm;
    EXCEPTION
      WHEN insufficient_privilege OR undefined_file THEN
        RAISE NOTICE 'pg_trgm is unavailable; workspace search will use safe substring fallback';
    END;
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_nav_bookmarks_user_lower_title
  ON nav_bookmarks (user_id, LOWER(title) text_pattern_ops);

CREATE INDEX IF NOT EXISTS idx_notes_user_lower_title_unencrypted
  ON notes (user_id, LOWER(title) text_pattern_ops)
  WHERE encrypted = FALSE;

CREATE INDEX IF NOT EXISTS idx_notes_user_number_unencrypted
  ON notes (user_id, number_id)
  WHERE encrypted = FALSE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_extension
    WHERE extname = 'pg_trgm'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_nav_bookmarks_title_trgm '
      || 'ON nav_bookmarks USING GIN (LOWER(title) gin_trgm_ops)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_nav_bookmarks_description_trgm '
      || 'ON nav_bookmarks USING GIN (LOWER(description) gin_trgm_ops)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_notes_title_trgm_unencrypted '
      || 'ON notes USING GIN (LOWER(title) gin_trgm_ops) WHERE encrypted = FALSE';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_notes_content_trgm_unencrypted '
      || 'ON notes USING GIN (LOWER(content) gin_trgm_ops) WHERE encrypted = FALSE';
  END IF;
END;
$$;
