ALTER TABLE notes
  ADD COLUMN IF NOT EXISTS remind_before_minutes INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'notes_remind_before_minutes_check'
      AND conrelid = 'notes'::regclass
  ) THEN
    ALTER TABLE notes
      ADD CONSTRAINT notes_remind_before_minutes_check
      CHECK (remind_before_minutes BETWEEN 0 AND 43200);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'notes_revision_check'
      AND conrelid = 'notes'::regclass
  ) THEN
    ALTER TABLE notes
      ADD CONSTRAINT notes_revision_check CHECK (revision >= 1);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_notes_reminder_generation
  ON notes (due_at, id)
  INCLUDE (user_id, remind_before_minutes)
  WHERE type = 'memo'
    AND completed = FALSE
    AND due_at IS NOT NULL;

ALTER TABLE note_reminders
  ADD COLUMN IF NOT EXISTS remind_before_minutes_snapshot INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reminder_at_snapshot TIMESTAMPTZ;

UPDATE note_reminders
SET reminder_at_snapshot = due_at_snapshot
WHERE reminder_at_snapshot IS NULL;

ALTER TABLE note_reminders
  ALTER COLUMN reminder_at_snapshot SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'note_reminders_advance_minutes_check'
      AND conrelid = 'note_reminders'::regclass
  ) THEN
    ALTER TABLE note_reminders
      ADD CONSTRAINT note_reminders_advance_minutes_check
      CHECK (remind_before_minutes_snapshot BETWEEN 0 AND 43200);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS note_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  encrypted BOOLEAN NOT NULL DEFAULT FALSE,
  password_hash TEXT NOT NULL DEFAULT '',
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  entry_date DATE,
  mood TEXT NOT NULL DEFAULT '',
  due_at TIMESTAMPTZ,
  remind_before_minutes INTEGER NOT NULL DEFAULT 0,
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT note_versions_revision_check CHECK (revision >= 1),
  CONSTRAINT note_versions_remind_before_check
    CHECK (remind_before_minutes BETWEEN 0 AND 43200),
  CONSTRAINT note_versions_note_revision_unique UNIQUE (note_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_note_versions_owner_note_created
  ON note_versions (user_id, note_id, created_at DESC, id DESC);

-- Earlier releases hid encrypted notes from the public reader but could leave
-- their bearer share rows behind. Remove those legacy URLs so a later decrypt
-- can never make an old link public again without an explicit new share.
DELETE FROM note_shares AS share
USING notes AS note
WHERE share.note_id = note.id
  AND note.encrypted = TRUE;

INSERT INTO maintenance_job_status (job_name)
VALUES
  ('note_reminder_generation'),
  ('bookmark_health_check')
ON CONFLICT (job_name) DO NOTHING;
