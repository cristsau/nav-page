CREATE TABLE monitor_node_details (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  node_id BIGINT NOT NULL CHECK (node_id > 0),
  details JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(user_id,node_id)
);
CREATE TABLE monitor_changes (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  node_id BIGINT NOT NULL CHECK (node_id > 0),
  before_state JSONB NOT NULL,
  patch JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('preview','applying','applied','conflict','uncertain','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '15 minutes',
  applied_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ
);
CREATE INDEX monitor_changes_owner ON monitor_changes(user_id,node_id,created_at DESC);
CREATE TABLE monitor_probe_credentials (
  node_id BIGINT PRIMARY KEY CHECK (node_id > 0),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash CHAR(64) NOT NULL UNIQUE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_report_at TIMESTAMPTZ,
  services JSONB NOT NULL DEFAULT '[]'
);
CREATE TABLE monitor_probe_samples (
  node_id BIGINT NOT NULL REFERENCES monitor_probe_credentials(node_id) ON DELETE CASCADE,
  carrier TEXT NOT NULL CHECK (carrier IN ('cu','cm','ct')),
  observed_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  address INET,
  sent SMALLINT NOT NULL CHECK (sent BETWEEN 0 AND 5),
  received SMALLINT NOT NULL CHECK (received BETWEEN 0 AND sent),
  avg_ms DOUBLE PRECISION CHECK (avg_ms >= 0 AND avg_ms < 60000),
  min_ms DOUBLE PRECISION,
  max_ms DOUBLE PRECISION,
  error TEXT,
  PRIMARY KEY(node_id,carrier,observed_at)
);
CREATE INDEX monitor_probe_recent ON monitor_probe_samples(node_id,received_at DESC);
