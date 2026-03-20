CREATE TABLE IF NOT EXISTS nav_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '📁',
  color TEXT NOT NULL DEFAULT '#3b82f6',
  display_order INTEGER NOT NULL DEFAULT 0,
  collapsed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nav_groups_user_id ON nav_groups (user_id);
CREATE INDEX IF NOT EXISTS idx_nav_groups_user_order ON nav_groups (user_id, display_order);

CREATE TABLE IF NOT EXISTS nav_bookmarks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id UUID NOT NULL REFERENCES nav_groups(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  favicon TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nav_bookmarks_user_id ON nav_bookmarks (user_id);
CREATE INDEX IF NOT EXISTS idx_nav_bookmarks_group_id ON nav_bookmarks (group_id);
CREATE INDEX IF NOT EXISTS idx_nav_bookmarks_group_order ON nav_bookmarks (group_id, display_order);
