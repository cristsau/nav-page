CREATE TABLE IF NOT EXISTS note_reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  due_at_snapshot TIMESTAMPTZ NOT NULL,
  triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (note_id, due_at_snapshot)
);

CREATE INDEX IF NOT EXISTS idx_note_reminders_user_triggered
  ON note_reminders (user_id, triggered_at DESC);

CREATE INDEX IF NOT EXISTS idx_note_reminders_user_unread
  ON note_reminders (user_id, triggered_at DESC)
  WHERE read_at IS NULL;
