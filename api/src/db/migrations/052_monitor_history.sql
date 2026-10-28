CREATE TABLE monitor_probe_rollups (
  node_id BIGINT NOT NULL REFERENCES monitor_probe_credentials(node_id) ON DELETE CASCADE,
  carrier TEXT NOT NULL CHECK (carrier IN ('cu','cm','ct')),
  step INTEGER NOT NULL CHECK (step IN (300,3600)),
  bucket TIMESTAMPTZ NOT NULL,
  address TEXT NOT NULL,
  sent BIGINT NOT NULL,
  received BIGINT NOT NULL,
  rtt_sum DOUBLE PRECISION NOT NULL,
  min_ms DOUBLE PRECISION,
  max_ms DOUBLE PRECISION,
  rounds INTEGER NOT NULL,
  valid_rounds INTEGER NOT NULL,
  first_at TIMESTAMPTZ NOT NULL,
  last_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(node_id,carrier,step,bucket,address)
);
CREATE INDEX monitor_rollups_time ON monitor_probe_rollups(step,bucket);
CREATE TABLE monitor_probe_maintenance (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(id),
  watermark TIMESTAMPTZ NOT NULL,
  pruned_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX monitor_probe_observed ON monitor_probe_samples(observed_at);
CREATE TABLE monitor_admin_events (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('started','applied','rejected','uncertain')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
