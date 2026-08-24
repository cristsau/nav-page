ALTER TABLE notes
  ADD COLUMN IF NOT EXISTS content_format TEXT NOT NULL DEFAULT 'plain',
  ADD COLUMN IF NOT EXISTS content_json JSONB,
  ADD COLUMN IF NOT EXISTS content_json_encrypted TEXT;

ALTER TABLE note_versions
  ADD COLUMN IF NOT EXISTS content_format TEXT NOT NULL DEFAULT 'plain',
  ADD COLUMN IF NOT EXISTS content_json JSONB,
  ADD COLUMN IF NOT EXISTS content_json_encrypted TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'notes_content_format_check'
      AND conrelid = 'notes'::regclass
  ) THEN
    ALTER TABLE notes
      ADD CONSTRAINT notes_content_format_check
      CHECK (content_format IN ('plain', 'tiptap-json'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'notes_content_json_object_check'
      AND conrelid = 'notes'::regclass
  ) THEN
    ALTER TABLE notes
      ADD CONSTRAINT notes_content_json_object_check
      CHECK (content_json IS NULL OR jsonb_typeof(content_json) = 'object');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'notes_rich_content_privacy_check'
      AND conrelid = 'notes'::regclass
  ) THEN
    ALTER TABLE notes
      ADD CONSTRAINT notes_rich_content_privacy_check
      CHECK (
        (encrypted = FALSE AND content_json_encrypted IS NULL)
        OR (encrypted = TRUE AND content_json IS NULL)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'notes_rich_content_state_check'
      AND conrelid = 'notes'::regclass
  ) THEN
    ALTER TABLE notes
      ADD CONSTRAINT notes_rich_content_state_check
      CHECK (
        (content_format = 'plain'
          AND content_json IS NULL
          AND content_json_encrypted IS NULL)
        OR (content_format = 'tiptap-json'
          AND encrypted = FALSE
          AND content_json IS NOT NULL
          AND content_json_encrypted IS NULL)
        OR (content_format = 'tiptap-json'
          AND encrypted = TRUE
          AND content_json IS NULL
          AND NULLIF(content_json_encrypted, '') IS NOT NULL)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'note_versions_content_format_check'
      AND conrelid = 'note_versions'::regclass
  ) THEN
    ALTER TABLE note_versions
      ADD CONSTRAINT note_versions_content_format_check
      CHECK (content_format IN ('plain', 'tiptap-json'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'note_versions_content_json_object_check'
      AND conrelid = 'note_versions'::regclass
  ) THEN
    ALTER TABLE note_versions
      ADD CONSTRAINT note_versions_content_json_object_check
      CHECK (content_json IS NULL OR jsonb_typeof(content_json) = 'object');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'note_versions_rich_content_privacy_check'
      AND conrelid = 'note_versions'::regclass
  ) THEN
    ALTER TABLE note_versions
      ADD CONSTRAINT note_versions_rich_content_privacy_check
      CHECK (
        (encrypted = FALSE AND content_json_encrypted IS NULL)
        OR (encrypted = TRUE AND content_json IS NULL)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'note_versions_rich_content_state_check'
      AND conrelid = 'note_versions'::regclass
  ) THEN
    ALTER TABLE note_versions
      ADD CONSTRAINT note_versions_rich_content_state_check
      CHECK (
        (content_format = 'plain'
          AND content_json IS NULL
          AND content_json_encrypted IS NULL)
        OR (content_format = 'tiptap-json'
          AND encrypted = FALSE
          AND content_json IS NOT NULL
          AND content_json_encrypted IS NULL)
        OR (content_format = 'tiptap-json'
          AND encrypted = TRUE
          AND content_json IS NULL
          AND NULLIF(content_json_encrypted, '') IS NOT NULL)
      );
  END IF;
END $$;
