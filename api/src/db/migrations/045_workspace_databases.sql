CREATE TABLE IF NOT EXISTS workspace_databases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon VARCHAR(32) NOT NULL DEFAULT 'database',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT workspace_databases_user_identity_unique UNIQUE (id, user_id),
  CONSTRAINT workspace_databases_name_check
    CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT workspace_databases_description_check
    CHECK (octet_length(description) <= 16000),
  CONSTRAINT workspace_databases_icon_check
    CHECK (icon ~ '^[a-z][a-z0-9-]{0,31}$')
);

CREATE TABLE IF NOT EXISTS workspace_database_properties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  database_id UUID NOT NULL,
  user_id UUID NOT NULL,
  name VARCHAR(80) NOT NULL,
  type VARCHAR(24) NOT NULL,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT workspace_database_properties_database_user_fkey
    FOREIGN KEY (database_id, user_id)
    REFERENCES workspace_databases(id, user_id)
    ON DELETE CASCADE,
  CONSTRAINT workspace_database_properties_identity_unique
    UNIQUE (id, database_id, user_id),
  CONSTRAINT workspace_database_properties_name_unique
    UNIQUE (database_id, name),
  CONSTRAINT workspace_database_properties_name_check
    CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  CONSTRAINT workspace_database_properties_type_check
    CHECK (type IN (
      'title', 'text', 'number', 'select', 'multi_select',
      'status', 'date', 'checkbox', 'url', 'relation'
    )),
  CONSTRAINT workspace_database_properties_config_check
    CHECK (
      jsonb_typeof(config) = 'object'
      AND octet_length(config::text) <= 32768
    ),
  CONSTRAINT workspace_database_properties_order_check
    CHECK (display_order BETWEEN 0 AND 10000)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_database_properties_one_title
  ON workspace_database_properties (database_id)
  WHERE type = 'title';

CREATE INDEX IF NOT EXISTS idx_workspace_database_properties_order
  ON workspace_database_properties (database_id, display_order, id);

CREATE TABLE IF NOT EXISTS workspace_database_views (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  database_id UUID NOT NULL,
  user_id UUID NOT NULL,
  name VARCHAR(80) NOT NULL,
  type VARCHAR(16) NOT NULL DEFAULT 'table',
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT workspace_database_views_database_user_fkey
    FOREIGN KEY (database_id, user_id)
    REFERENCES workspace_databases(id, user_id)
    ON DELETE CASCADE,
  CONSTRAINT workspace_database_views_identity_unique
    UNIQUE (id, database_id, user_id),
  CONSTRAINT workspace_database_views_name_unique
    UNIQUE (database_id, name),
  CONSTRAINT workspace_database_views_name_check
    CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  CONSTRAINT workspace_database_views_type_check
    CHECK (type IN ('table', 'board')),
  CONSTRAINT workspace_database_views_config_check
    CHECK (
      jsonb_typeof(config) = 'object'
      AND octet_length(config::text) <= 65536
    ),
  CONSTRAINT workspace_database_views_order_check
    CHECK (display_order BETWEEN 0 AND 10000)
);

CREATE INDEX IF NOT EXISTS idx_workspace_database_views_order
  ON workspace_database_views (database_id, display_order, id);

CREATE TABLE IF NOT EXISTS workspace_database_rows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  database_id UUID NOT NULL,
  user_id UUID NOT NULL,
  title VARCHAR(500) NOT NULL,
  values JSONB NOT NULL DEFAULT '{}'::jsonb,
  position BIGINT NOT NULL DEFAULT 0,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT workspace_database_rows_database_user_fkey
    FOREIGN KEY (database_id, user_id)
    REFERENCES workspace_databases(id, user_id)
    ON DELETE CASCADE,
  CONSTRAINT workspace_database_rows_identity_unique
    UNIQUE (id, user_id),
  CONSTRAINT workspace_database_rows_database_identity_unique
    UNIQUE (id, database_id, user_id),
  CONSTRAINT workspace_database_rows_title_check
    CHECK (char_length(btrim(title)) BETWEEN 1 AND 500),
  CONSTRAINT workspace_database_rows_values_check
    CHECK (
      jsonb_typeof(values) = 'object'
      AND octet_length(values::text) <= 262144
    )
);

CREATE INDEX IF NOT EXISTS idx_workspace_database_rows_active
  ON workspace_database_rows (database_id, position, created_at, id)
  WHERE archived = FALSE;

CREATE INDEX IF NOT EXISTS idx_workspace_database_rows_archived
  ON workspace_database_rows (database_id, updated_at DESC, id)
  WHERE archived = TRUE;

CREATE INDEX IF NOT EXISTS idx_workspace_database_rows_values_gin
  ON workspace_database_rows USING GIN (values);

CREATE TABLE IF NOT EXISTS workspace_database_relations (
  source_row_id UUID NOT NULL,
  source_database_id UUID NOT NULL,
  source_property_id UUID NOT NULL,
  target_row_id UUID NOT NULL,
  target_database_id UUID NOT NULL,
  user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT workspace_database_relations_pkey
    PRIMARY KEY (source_row_id, source_property_id, target_row_id),
  CONSTRAINT workspace_database_relations_source_row_fkey
    FOREIGN KEY (source_row_id, source_database_id, user_id)
    REFERENCES workspace_database_rows(id, database_id, user_id)
    ON DELETE CASCADE,
  CONSTRAINT workspace_database_relations_target_row_fkey
    FOREIGN KEY (target_row_id, target_database_id, user_id)
    REFERENCES workspace_database_rows(id, database_id, user_id)
    ON DELETE CASCADE,
  CONSTRAINT workspace_database_relations_source_property_fkey
    FOREIGN KEY (source_property_id, source_database_id, user_id)
    REFERENCES workspace_database_properties(id, database_id, user_id)
    ON DELETE CASCADE,
  CONSTRAINT workspace_database_relations_distinct_rows_check
    CHECK (source_row_id <> target_row_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_database_relations_target
  ON workspace_database_relations (
    target_row_id, target_database_id, user_id,
    source_property_id, source_row_id
  );

CREATE INDEX IF NOT EXISTS idx_workspace_databases_user_updated
  ON workspace_databases (user_id, updated_at DESC, id);
