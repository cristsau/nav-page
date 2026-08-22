CREATE TABLE IF NOT EXISTS maintenance_job_status (
  job_name VARCHAR(64) PRIMARY KEY,
  last_started_at TIMESTAMPTZ,
  last_succeeded_at TIMESTAMPTZ,
  last_failed_at TIMESTAMPTZ,
  last_duration_ms BIGINT,
  last_outcome VARCHAR(16) NOT NULL DEFAULT 'idle',
  last_result JSONB NOT NULL DEFAULT '{}'::jsonb,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error_code VARCHAR(64),
  alert_open BOOLEAN NOT NULL DEFAULT FALSE,
  last_alert_at TIMESTAMPTZ,
  last_notification_kind VARCHAR(16),
  last_notification_status VARCHAR(16),
  last_notification_at TIMESTAMPTZ,
  last_notification_error_code VARCHAR(64),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT maintenance_job_status_job_name_check
    CHECK (job_name ~ '^[a-z0-9_]+$'),
  CONSTRAINT maintenance_job_status_duration_check
    CHECK (last_duration_ms IS NULL OR last_duration_ms >= 0),
  CONSTRAINT maintenance_job_status_outcome_check
    CHECK (last_outcome IN ('idle', 'succeeded', 'failed')),
  CONSTRAINT maintenance_job_status_result_check
    CHECK (jsonb_typeof(last_result) = 'object'),
  CONSTRAINT maintenance_job_status_failure_count_check
    CHECK (consecutive_failures >= 0),
  CONSTRAINT maintenance_job_status_error_code_check
    CHECK (
      last_error_code IS NULL
      OR last_error_code ~ '^[A-Z0-9_.-]+$'
    ),
  CONSTRAINT maintenance_job_status_notification_kind_check
    CHECK (
      last_notification_kind IS NULL
      OR last_notification_kind IN ('failure', 'recovery')
    ),
  CONSTRAINT maintenance_job_status_notification_status_check
    CHECK (
      last_notification_status IS NULL
      OR last_notification_status IN ('sent', 'partial', 'skipped', 'failed')
    ),
  CONSTRAINT maintenance_job_status_notification_error_check
    CHECK (
      last_notification_error_code IS NULL
      OR last_notification_error_code ~ '^[A-Z0-9_.-]+$'
    )
);

INSERT INTO maintenance_job_status (job_name)
VALUES
  ('security_event_retention'),
  ('media_delete_retry')
ON CONFLICT (job_name) DO NOTHING;
