CREATE TABLE IF NOT EXISTS workspace_search_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bookmark_id UUID REFERENCES nav_bookmarks(id) ON DELETE CASCADE,
  note_id UUID REFERENCES notes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  lexical_tokens TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  term_frequencies JSONB NOT NULL DEFAULT '{}'::jsonb,
  document_length INTEGER NOT NULL DEFAULT 0,
  source_hash CHAR(64) NOT NULL,
  source_updated_at TIMESTAMPTZ NOT NULL,
  indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  embedding REAL[],
  embedding_model TEXT,
  embedding_dimensions INTEGER,
  embedding_updated_at TIMESTAMPTZ,
  CONSTRAINT workspace_search_documents_kind_check
    CHECK (kind IN ('bookmark', 'note')),
  CONSTRAINT workspace_search_documents_source_check
    CHECK (
      (kind = 'bookmark' AND bookmark_id IS NOT NULL AND note_id IS NULL)
      OR (kind = 'note' AND note_id IS NOT NULL AND bookmark_id IS NULL)
    ),
  CONSTRAINT workspace_search_documents_tags_check
    CHECK (jsonb_typeof(tags) = 'array'),
  CONSTRAINT workspace_search_documents_term_frequencies_check
    CHECK (jsonb_typeof(term_frequencies) = 'object'),
  CONSTRAINT workspace_search_documents_length_check
    CHECK (document_length >= 0),
  CONSTRAINT workspace_search_documents_hash_check
    CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT workspace_search_documents_embedding_check
    CHECK (
      (embedding IS NULL AND embedding_model IS NULL
        AND embedding_dimensions IS NULL AND embedding_updated_at IS NULL)
      OR (
        embedding IS NOT NULL
        AND embedding_model IS NOT NULL
        AND embedding_dimensions IS NOT NULL
        AND embedding_dimensions BETWEEN 1 AND 4096
        AND cardinality(embedding) = embedding_dimensions
        AND embedding_updated_at IS NOT NULL
      )
    )
);

CREATE TABLE IF NOT EXISTS workspace_search_index_state (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  dirty BOOLEAN NOT NULL DEFAULT TRUE,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  indexed_at TIMESTAMPTZ
);

CREATE OR REPLACE FUNCTION nav_mark_workspace_search_dirty()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP <> 'DELETE' THEN
    INSERT INTO workspace_search_index_state (user_id, dirty, changed_at)
    VALUES (NEW.user_id, TRUE, NOW())
    ON CONFLICT (user_id)
    DO UPDATE SET dirty = TRUE, changed_at = NOW();
  END IF;

  IF TG_OP <> 'INSERT' AND (TG_OP = 'DELETE' OR OLD.user_id <> NEW.user_id) THEN
    INSERT INTO workspace_search_index_state (user_id, dirty, changed_at)
    VALUES (OLD.user_id, TRUE, NOW())
    ON CONFLICT (user_id)
    DO UPDATE SET dirty = TRUE, changed_at = NOW();
  END IF;

  RETURN NULL;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'nav_bookmarks_workspace_search_dirty'
      AND tgrelid = 'nav_bookmarks'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER nav_bookmarks_workspace_search_dirty
    AFTER INSERT OR UPDATE OR DELETE ON nav_bookmarks
    FOR EACH ROW EXECUTE FUNCTION nav_mark_workspace_search_dirty();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'notes_workspace_search_dirty'
      AND tgrelid = 'notes'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER notes_workspace_search_dirty
    AFTER INSERT OR UPDATE OR DELETE ON notes
    FOR EACH ROW EXECUTE FUNCTION nav_mark_workspace_search_dirty();
  END IF;
END $$;

INSERT INTO workspace_search_index_state (user_id, dirty, changed_at)
SELECT id, TRUE, NOW()
FROM users
ON CONFLICT (user_id) DO NOTHING;

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_search_documents_bookmark
  ON workspace_search_documents (bookmark_id)
  WHERE bookmark_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_search_documents_note
  ON workspace_search_documents (note_id)
  WHERE note_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_workspace_search_documents_user_kind
  ON workspace_search_documents (user_id, kind, source_updated_at DESC, id);

CREATE INDEX IF NOT EXISTS idx_workspace_search_documents_lexical_tokens
  ON workspace_search_documents USING GIN (lexical_tokens);

CREATE INDEX IF NOT EXISTS idx_workspace_search_documents_pending_embedding
  ON workspace_search_documents (indexed_at ASC, id ASC)
  INCLUDE (user_id)
  WHERE embedding IS NULL;

INSERT INTO maintenance_job_status (job_name)
VALUES ('search_embedding_index')
ON CONFLICT (job_name) DO NOTHING;
