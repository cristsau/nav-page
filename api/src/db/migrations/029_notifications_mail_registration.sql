ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;

ALTER TABLE users
  ADD CONSTRAINT users_email_shape_check
    CHECK (
      email IS NULL
      OR (
        char_length(email) BETWEEN 3 AND 320
        AND email = BTRIM(email)
        AND email !~ '[[:cntrl:]]'
      )
    );

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique
  ON users (LOWER(email))
  WHERE email IS NOT NULL;

ALTER TABLE registration_requests
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS verification_token_hash CHAR(64),
  ADD COLUMN IF NOT EXISTS verification_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS verification_sent_at TIMESTAMPTZ;

ALTER TABLE registration_requests
  ADD CONSTRAINT registration_requests_status_check
    CHECK (status IN ('email_pending', 'pending', 'approved', 'rejected', 'expired')),
  ADD CONSTRAINT registration_requests_email_shape_check
    CHECK (
      email IS NULL
      OR (
        char_length(email) BETWEEN 3 AND 320
        AND email = BTRIM(email)
        AND email !~ '[[:cntrl:]]'
      )
    ),
  ADD CONSTRAINT registration_requests_verification_token_check
    CHECK (
      verification_token_hash IS NULL
      OR verification_token_hash ~ '^[0-9a-f]{64}$'
    ),
  ADD CONSTRAINT registration_requests_verification_state_check
    CHECK (
      (
        status = 'email_pending'
        AND email IS NOT NULL
        AND email_verified_at IS NULL
        AND verification_token_hash IS NOT NULL
        AND verification_expires_at IS NOT NULL
        AND verification_sent_at IS NOT NULL
      )
      OR (
        status <> 'email_pending'
        AND verification_token_hash IS NULL
        AND verification_expires_at IS NULL
      )
    );

CREATE INDEX IF NOT EXISTS idx_registration_requests_email
  ON registration_requests (LOWER(email))
  WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_registration_requests_verification
  ON registration_requests (verification_token_hash, verification_expires_at)
  WHERE status = 'email_pending';

CREATE UNIQUE INDEX IF NOT EXISTS idx_registration_requests_pending_username_unique
  ON registration_requests (username)
  WHERE status IN ('email_pending', 'pending');

CREATE UNIQUE INDEX IF NOT EXISTS idx_registration_requests_pending_email_unique
  ON registration_requests (LOWER(email))
  WHERE email IS NOT NULL AND status IN ('email_pending', 'pending');

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type VARCHAR(80) NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  source_type VARCHAR(48),
  source_id TEXT,
  action_url TEXT NOT NULL DEFAULT '',
  dedupe_key TEXT,
  sensitive BOOLEAN NOT NULL DEFAULT TRUE,
  push_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  read_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT notifications_event_type_check
    CHECK (event_type ~ '^[a-z0-9_.-]+$'),
  CONSTRAINT notifications_source_type_check
    CHECK (source_type IS NULL OR source_type ~ '^[a-z0-9_.-]+$'),
  CONSTRAINT notifications_action_url_check
    CHECK (action_url = '' OR (action_url LIKE '/%' AND action_url NOT LIKE '//%')),
  CONSTRAINT notifications_metadata_check
    CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT notifications_title_length_check
    CHECK (char_length(title) BETWEEN 1 AND 240),
  CONSTRAINT notifications_summary_length_check
    CHECK (char_length(summary) <= 1000),
  CONSTRAINT notifications_dedupe_key_length_check
    CHECK (dedupe_key IS NULL OR char_length(dedupe_key) BETWEEN 1 AND 300)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_user_dedupe
  ON notifications (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON notifications (user_id, created_at DESC, id)
  WHERE read_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_user_created
  ON notifications (user_id, created_at DESC, id);

CREATE TABLE IF NOT EXISTS notification_push_deliveries (
  notification_id UUID NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  subscription_id UUID NOT NULL REFERENCES web_push_subscriptions(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  last_error_code VARCHAR(64),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (notification_id, subscription_id),
  CONSTRAINT notification_push_deliveries_status_check
    CHECK (status IN ('pending', 'delivered', 'failed', 'expired')),
  CONSTRAINT notification_push_deliveries_attempt_count_check
    CHECK (attempt_count >= 0),
  CONSTRAINT notification_push_deliveries_error_code_check
    CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_.-]+$')
);

CREATE INDEX IF NOT EXISTS idx_notification_push_deliveries_pending
  ON notification_push_deliveries (updated_at ASC, notification_id, subscription_id)
  WHERE status IN ('pending', 'failed');

CREATE TABLE IF NOT EXISTS mail_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_type VARCHAR(64) NOT NULL,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  text_body TEXT NOT NULL DEFAULT '',
  html_body TEXT NOT NULL DEFAULT '',
  dedupe_key TEXT NOT NULL UNIQUE,
  sensitive BOOLEAN NOT NULL DEFAULT TRUE,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_attempt_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  scrubbed_at TIMESTAMPTZ,
  last_error_code VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT mail_outbox_message_type_check
    CHECK (message_type ~ '^[a-z0-9_.-]+$'),
  CONSTRAINT mail_outbox_status_check
    CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'expired')),
  CONSTRAINT mail_outbox_attempt_count_check
    CHECK (attempt_count >= 0),
  CONSTRAINT mail_outbox_recipient_length_check
    CHECK (char_length(recipient) BETWEEN 3 AND 320),
  CONSTRAINT mail_outbox_subject_length_check
    CHECK (char_length(subject) BETWEEN 1 AND 240),
  CONSTRAINT mail_outbox_dedupe_key_length_check
    CHECK (char_length(dedupe_key) BETWEEN 1 AND 300),
  CONSTRAINT mail_outbox_error_code_check
    CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_.-]+$')
);

CREATE INDEX IF NOT EXISTS idx_mail_outbox_pending
  ON mail_outbox (next_attempt_at ASC, created_at ASC, id)
  WHERE status IN ('pending', 'failed');

INSERT INTO maintenance_job_status (job_name)
VALUES ('mail_delivery')
ON CONFLICT (job_name) DO NOTHING;
