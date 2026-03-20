CREATE TABLE IF NOT EXISTS custom_search_engines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '🔍',
  url TEXT NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_custom_search_engines_user_id
  ON custom_search_engines (user_id);

CREATE INDEX IF NOT EXISTS idx_custom_search_engines_user_order
  ON custom_search_engines (user_id, display_order);
