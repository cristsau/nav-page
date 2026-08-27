CREATE TABLE IF NOT EXISTS email_sent_append_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  outbox_id UUID NOT NULL UNIQUE,
  user_id UUID NOT NULL,
  account_id UUID NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'prepared',
  message_id VARCHAR(998) NOT NULL,
  nav_id CHAR(24) NOT NULL,
  mime_encrypted BYTEA,
  mime_sha256 CHAR(64) NOT NULL,
  mime_size_bytes INTEGER NOT NULL,
  append_attempted BOOLEAN NOT NULL DEFAULT FALSE,
  append_attempt_count INTEGER NOT NULL DEFAULT 0,
  reconcile_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  smtp_accepted_at TIMESTAMPTZ,
  append_started_at TIMESTAMPTZ,
  appended_at TIMESTAMPTZ,
  sent_folder_path VARCHAR(512),
  uid_validity BIGINT,
  uid BIGINT,
  last_error_code VARCHAR(64),
  scrubbed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT email_sent_append_jobs_outbox_user_fkey
    FOREIGN KEY (outbox_id, user_id)
    REFERENCES mail_outbox(id, user_id) ON DELETE CASCADE,
  CONSTRAINT email_sent_append_jobs_account_user_fkey
    FOREIGN KEY (account_id, user_id)
    REFERENCES email_accounts(id, user_id) ON DELETE CASCADE,
  CONSTRAINT email_sent_append_jobs_status_check
    CHECK (
      status IN (
        'prepared', 'pending', 'appending', 'reconcile',
        'appended', 'blocked', 'cancelled', 'expired'
      )
    ),
  CONSTRAINT email_sent_append_jobs_message_id_check
    CHECK (
      char_length(message_id) BETWEEN 3 AND 998
      AND message_id ~ '^<[^<>[:cntrl:]]+>$'
    ),
  CONSTRAINT email_sent_append_jobs_nav_id_check
    CHECK (nav_id ~ '^[0-9a-f]{24}$'),
  CONSTRAINT email_sent_append_jobs_mime_sha256_check
    CHECK (mime_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT email_sent_append_jobs_mime_size_check
    CHECK (mime_size_bytes BETWEEN 1 AND 41943040),
  CONSTRAINT email_sent_append_jobs_mime_ciphertext_size_check
    CHECK (
      mime_encrypted IS NULL
      OR octet_length(mime_encrypted) BETWEEN 30 AND 41943069
    ),
  CONSTRAINT email_sent_append_jobs_attempt_count_check
    CHECK (append_attempt_count >= 0 AND reconcile_count >= 0),
  CONSTRAINT email_sent_append_jobs_folder_path_check
    CHECK (
      sent_folder_path IS NULL
      OR (
        char_length(sent_folder_path) BETWEEN 1 AND 512
        AND sent_folder_path !~ '[[:cntrl:]]'
      )
    ),
  CONSTRAINT email_sent_append_jobs_uid_validity_check
    CHECK (uid_validity IS NULL OR uid_validity BETWEEN 1 AND 4294967295),
  CONSTRAINT email_sent_append_jobs_uid_check
    CHECK (uid IS NULL OR uid BETWEEN 1 AND 4294967295),
  CONSTRAINT email_sent_append_jobs_error_code_check
    CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_.-]+$'),
  CONSTRAINT email_sent_append_jobs_lifecycle_check
    CHECK (
      (
        (
          append_attempted = FALSE
          AND append_attempt_count = 0
          AND append_started_at IS NULL
        )
        OR (
          append_attempted = TRUE
          AND append_attempt_count >= 1
          AND append_started_at IS NOT NULL
        )
      )
      AND (
        (
          status = 'prepared'
          AND append_attempted = FALSE
          AND mime_encrypted IS NOT NULL
          AND smtp_accepted_at IS NULL
          AND appended_at IS NULL
          AND scrubbed_at IS NULL
        )
        OR (
          status IN ('pending', 'appending', 'reconcile', 'blocked')
          AND (
            status NOT IN ('appending', 'reconcile')
            OR append_attempted = TRUE
          )
          AND (status <> 'pending' OR append_attempted = FALSE)
          AND mime_encrypted IS NOT NULL
          AND smtp_accepted_at IS NOT NULL
          AND appended_at IS NULL
          AND scrubbed_at IS NULL
        )
        OR (
          status = 'appended'
          AND append_attempted = TRUE
          AND mime_encrypted IS NULL
          AND smtp_accepted_at IS NOT NULL
          AND appended_at IS NOT NULL
          AND sent_folder_path IS NOT NULL
          AND uid_validity IS NOT NULL
          AND uid IS NOT NULL
          AND scrubbed_at IS NOT NULL
        )
        OR (
          status IN ('cancelled', 'expired')
          AND mime_encrypted IS NULL
          AND appended_at IS NULL
          AND scrubbed_at IS NOT NULL
        )
      )
    )
);

CREATE INDEX IF NOT EXISTS idx_email_sent_append_jobs_due
  ON email_sent_append_jobs (next_attempt_at ASC, created_at ASC, id)
  WHERE status IN ('pending', 'appending', 'reconcile', 'blocked');

CREATE INDEX IF NOT EXISTS idx_email_sent_append_jobs_user_created
  ON email_sent_append_jobs (user_id, created_at DESC, id);

INSERT INTO maintenance_job_status (job_name)
VALUES ('email_sent_append')
ON CONFLICT (job_name) DO NOTHING;
