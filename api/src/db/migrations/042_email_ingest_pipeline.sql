ALTER TABLE email_accounts
  ADD COLUMN IF NOT EXISTS sync_request_generation BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sync_completed_generation BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_sync_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_sync_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_sync_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_idle_event_at TIMESTAMPTZ;

ALTER TABLE email_accounts
  ADD CONSTRAINT email_accounts_sync_generation_check
    CHECK (
      sync_request_generation >= 0
      AND sync_completed_generation >= 0
      AND sync_completed_generation <= sync_request_generation
    );

CREATE TABLE IF NOT EXISTS email_classification_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL,
  email_message_id UUID NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  attempt_count SMALLINT NOT NULL DEFAULT 0,
  max_attempts SMALLINT NOT NULL DEFAULT 5,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_error_at TIMESTAMPTZ,
  last_error_code VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT email_classification_jobs_account_user_fkey
    FOREIGN KEY (account_id, user_id)
    REFERENCES email_accounts(id, user_id) ON DELETE CASCADE,
  CONSTRAINT email_classification_jobs_message_account_user_fkey
    FOREIGN KEY (email_message_id, account_id, user_id)
    REFERENCES email_messages(id, account_id, user_id) ON DELETE CASCADE,
  CONSTRAINT email_classification_jobs_status_check
    CHECK (status IN ('pending', 'running', 'retry_wait', 'succeeded', 'dead_letter')),
  CONSTRAINT email_classification_jobs_attempt_count_check
    CHECK (attempt_count BETWEEN 0 AND max_attempts AND max_attempts BETWEEN 1 AND 10),
  CONSTRAINT email_classification_jobs_error_code_check
    CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_.-]+$'),
  CONSTRAINT email_classification_jobs_lifecycle_check
    CHECK (
      (status = 'succeeded' AND completed_at IS NOT NULL AND last_error_code IS NULL)
      OR (status = 'dead_letter' AND completed_at IS NOT NULL AND last_error_code IS NOT NULL)
      OR (status IN ('pending', 'running', 'retry_wait') AND completed_at IS NULL)
    ),
  CONSTRAINT email_classification_jobs_message_unique
    UNIQUE (user_id, email_message_id)
);

CREATE INDEX IF NOT EXISTS idx_email_classification_jobs_due
  ON email_classification_jobs (next_attempt_at ASC, created_at ASC, id ASC)
  WHERE status IN ('pending', 'retry_wait');

CREATE INDEX IF NOT EXISTS idx_email_classification_jobs_account_status
  ON email_classification_jobs (user_id, account_id, status, created_at ASC, id ASC);

-- Backfill only encrypted mailbox rows that have never produced a classification
-- event. Existing events are historical completion evidence and must not be
-- replayed during the first deployment: older rows can legitimately have a NULL
-- notified_at, and re-queuing them would fan out duplicate Web Push alerts.
-- Legacy events may predate the email_message_id foreign key, so source_key plus
-- the stable Message-ID hash is also treated as completion evidence. Historical
-- messages without a Message-ID are intentionally excluded because they cannot
-- be linked to a legacy event without decrypting content in a schema migration.
INSERT INTO email_classification_jobs (user_id, account_id, email_message_id)
SELECT message.user_id, message.account_id, message.id
FROM email_messages AS message
JOIN email_accounts AS account
  ON account.id = message.account_id
 AND account.user_id = message.user_id
WHERE message.message_id_hash IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM email_events AS event
    WHERE event.user_id = message.user_id
      AND (
        event.email_message_id = message.id
        OR (
          event.source_key = account.source_key
          AND event.message_id_hash = message.message_id_hash
        )
      )
  )
ON CONFLICT (user_id, email_message_id) DO NOTHING;

INSERT INTO maintenance_job_status (job_name)
VALUES ('email_classification')
ON CONFLICT (job_name) DO NOTHING;
