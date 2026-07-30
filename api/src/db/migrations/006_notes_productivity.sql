ALTER TABLE notes
  ADD COLUMN IF NOT EXISTS entry_date DATE,
  ADD COLUMN IF NOT EXISTS mood TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE notes
SET entry_date = created_at::date
WHERE type = 'diary'
  AND entry_date IS NULL;

CREATE INDEX IF NOT EXISTS idx_notes_user_entry_date
  ON notes (user_id, entry_date DESC)
  WHERE type = 'diary';

CREATE INDEX IF NOT EXISTS idx_notes_user_due_at
  ON notes (user_id, due_at ASC)
  WHERE type = 'memo' AND completed = FALSE;
