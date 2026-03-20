CREATE TABLE IF NOT EXISTS notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'memo',
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  encrypted BOOLEAN NOT NULL DEFAULT FALSE,
  password_hash TEXT NOT NULL DEFAULT '',
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notes_user_id ON notes (user_id);
CREATE INDEX IF NOT EXISTS idx_notes_user_type ON notes (user_id, type);
CREATE INDEX IF NOT EXISTS idx_notes_user_updated_at ON notes (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS note_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE,
  expire_at TIMESTAMPTZ,
  view_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_note_shares_note_id ON note_shares (note_id);
CREATE INDEX IF NOT EXISTS idx_note_shares_user_id ON note_shares (user_id);
CREATE INDEX IF NOT EXISTS idx_note_shares_code ON note_shares (code);
