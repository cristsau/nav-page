CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  scope TEXT NOT NULL,
  key_digest TEXT NOT NULL,
  window_started_at TIMESTAMPTZ NOT NULL,
  window_expires_at TIMESTAMPTZ NOT NULL,
  request_count INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (scope, key_digest),
  CONSTRAINT rate_limit_buckets_scope_check
    CHECK (scope ~ '^[a-z][a-z0-9_]{2,63}$'),
  CONSTRAINT rate_limit_buckets_key_digest_check
    CHECK (key_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT rate_limit_buckets_window_check
    CHECK (window_expires_at > window_started_at),
  CONSTRAINT rate_limit_buckets_request_count_check
    CHECK (request_count > 0)
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_buckets_expires
  ON rate_limit_buckets (window_expires_at);

CREATE TABLE IF NOT EXISTS security_events (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL,
  outcome TEXT NOT NULL,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  subject_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  resource_type TEXT,
  resource_id UUID,
  affected_count INTEGER,
  client_ip_digest TEXT,
  user_agent_digest TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT security_events_type_check
    CHECK (event_type ~ '^[a-z][a-z0-9_.]{2,63}$'),
  CONSTRAINT security_events_outcome_check
    CHECK (outcome IN ('success', 'failure', 'denied')),
  CONSTRAINT security_events_resource_type_check
    CHECK (
      resource_type IS NULL
      OR resource_type ~ '^[a-z][a-z0-9_]{1,63}$'
    ),
  CONSTRAINT security_events_affected_count_check
    CHECK (affected_count IS NULL OR affected_count >= 0),
  CONSTRAINT security_events_client_ip_digest_check
    CHECK (
      client_ip_digest IS NULL
      OR client_ip_digest ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT security_events_user_agent_digest_check
    CHECK (
      user_agent_digest IS NULL
      OR user_agent_digest ~ '^[0-9a-f]{64}$'
    )
);

CREATE INDEX IF NOT EXISTS idx_security_events_created
  ON security_events (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_security_events_type_created
  ON security_events (event_type, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_security_events_actor_created
  ON security_events (actor_user_id, created_at DESC, id DESC)
  WHERE actor_user_id IS NOT NULL;
