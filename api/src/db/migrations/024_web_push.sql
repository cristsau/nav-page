CREATE TABLE IF NOT EXISTS web_push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  endpoint_hash CHAR(64) NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent_digest CHAR(64),
  device_label TEXT NOT NULL DEFAULT '',
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  disabled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT web_push_subscriptions_endpoint_hash_check
    CHECK (endpoint_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT web_push_subscriptions_key_check
    CHECK (char_length(p256dh) BETWEEN 16 AND 512 AND char_length(auth) BETWEEN 8 AND 256),
  CONSTRAINT web_push_subscriptions_device_label_check
    CHECK (char_length(device_label) <= 80),
  CONSTRAINT web_push_subscriptions_failure_count_check
    CHECK (failure_count >= 0),
  CONSTRAINT web_push_subscriptions_user_agent_digest_check
    CHECK (user_agent_digest IS NULL OR user_agent_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT web_push_subscriptions_user_endpoint_unique
    UNIQUE (user_id, endpoint_hash)
);

CREATE INDEX IF NOT EXISTS idx_web_push_subscriptions_user_active
  ON web_push_subscriptions (user_id, updated_at DESC, id)
  WHERE disabled_at IS NULL;

CREATE TABLE IF NOT EXISTS note_reminder_push_deliveries (
  reminder_id UUID NOT NULL REFERENCES note_reminders(id) ON DELETE CASCADE,
  subscription_id UUID NOT NULL REFERENCES web_push_subscriptions(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  last_error_code VARCHAR(64),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (reminder_id, subscription_id),
  CONSTRAINT note_reminder_push_deliveries_status_check
    CHECK (status IN ('pending', 'delivered', 'failed', 'expired')),
  CONSTRAINT note_reminder_push_deliveries_attempt_count_check
    CHECK (attempt_count >= 0),
  CONSTRAINT note_reminder_push_deliveries_error_code_check
    CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_.-]+$')
);

CREATE INDEX IF NOT EXISTS idx_note_reminder_push_deliveries_pending
  ON note_reminder_push_deliveries (updated_at ASC, reminder_id, subscription_id)
  WHERE status IN ('pending', 'failed');

INSERT INTO maintenance_job_status (job_name)
VALUES ('web_push_delivery')
ON CONFLICT (job_name) DO NOTHING;
