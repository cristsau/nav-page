CREATE TABLE IF NOT EXISTS ai_usage_daily (
  usage_date DATE NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feature VARCHAR(64) NOT NULL,
  provider VARCHAR(64) NOT NULL,
  model VARCHAR(256) NOT NULL,
  api_mode VARCHAR(32) NOT NULL,
  request_count BIGINT NOT NULL DEFAULT 0,
  success_count BIGINT NOT NULL DEFAULT 0,
  failure_count BIGINT NOT NULL DEFAULT 0,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cached_input_tokens BIGINT NOT NULL DEFAULT 0,
  reasoning_tokens BIGINT NOT NULL DEFAULT 0,
  latency_ms_total BIGINT NOT NULL DEFAULT 0,
  estimated_cost_microusd BIGINT NOT NULL DEFAULT 0,
  priced_request_count BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (usage_date, user_id, feature, provider, model, api_mode),
  CONSTRAINT ai_usage_daily_feature_check
    CHECK (feature ~ '^[a-z0-9_.-]+$'),
  CONSTRAINT ai_usage_daily_provider_check
    CHECK (provider ~ '^[a-z0-9_.-]+$'),
  CONSTRAINT ai_usage_daily_model_check
    CHECK (LENGTH(model) BETWEEN 1 AND 256),
  CONSTRAINT ai_usage_daily_api_mode_check
    CHECK (api_mode ~ '^[a-z0-9_.-]+$'),
  CONSTRAINT ai_usage_daily_counts_check
    CHECK (
      request_count >= 0
      AND success_count >= 0
      AND failure_count >= 0
      AND success_count + failure_count <= request_count
      AND input_tokens >= 0
      AND output_tokens >= 0
      AND cached_input_tokens >= 0
      AND reasoning_tokens >= 0
      AND latency_ms_total >= 0
      AND estimated_cost_microusd >= 0
      AND priced_request_count >= 0
      AND priced_request_count <= request_count
    )
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_daily_user_date
  ON ai_usage_daily (user_id, usage_date DESC);

INSERT INTO maintenance_job_status (job_name)
VALUES ('ai_usage_retention')
ON CONFLICT (job_name) DO NOTHING;
