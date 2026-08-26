ALTER TABLE email_mailbox_state
  DROP CONSTRAINT IF EXISTS email_mailbox_state_pkey;

ALTER TABLE email_mailbox_state
  ADD CONSTRAINT email_mailbox_state_pkey PRIMARY KEY (user_id, source_key);

ALTER TABLE mail_outbox
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS account_id UUID,
  ADD COLUMN IF NOT EXISTS source_message_id UUID,
  ADD COLUMN IF NOT EXISTS payload_encrypted BYTEA,
  ADD COLUMN IF NOT EXISTS content_hash CHAR(64),
  ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;

ALTER TABLE mail_outbox
  ADD CONSTRAINT mail_outbox_account_user_fkey
    FOREIGN KEY (account_id, user_id)
    REFERENCES email_accounts(id, user_id) ON DELETE CASCADE;

ALTER TABLE mail_outbox
  ADD CONSTRAINT mail_outbox_payload_size_check
    CHECK (
      payload_encrypted IS NULL
      OR octet_length(payload_encrypted) BETWEEN 32 AND 1048576
    ),
  ADD CONSTRAINT mail_outbox_content_hash_check
    CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT mail_outbox_user_payload_check
    CHECK (
      message_type <> 'user.mail'
      OR (
        user_id IS NOT NULL
        AND account_id IS NOT NULL
        AND content_hash IS NOT NULL
        AND confirmed_at IS NOT NULL
        AND sensitive = TRUE
        AND (
          (
            status IN ('pending', 'sending', 'failed')
            AND payload_encrypted IS NOT NULL
          )
          OR (
            status IN ('sent', 'expired')
            AND payload_encrypted IS NULL
          )
        )
      )
    );

CREATE INDEX IF NOT EXISTS idx_mail_outbox_user_created
  ON mail_outbox (user_id, created_at DESC, id)
  WHERE user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS email_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL,
  source_message_id UUID,
  payload_encrypted BYTEA NOT NULL,
  content_hash CHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'draft',
  outbox_id UUID UNIQUE REFERENCES mail_outbox(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 days',
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT email_drafts_account_user_fkey
    FOREIGN KEY (account_id, user_id)
    REFERENCES email_accounts(id, user_id) ON DELETE CASCADE,
  CONSTRAINT email_drafts_payload_size_check
    CHECK (octet_length(payload_encrypted) BETWEEN 32 AND 1048576),
  CONSTRAINT email_drafts_content_hash_check
    CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT email_drafts_status_check
    CHECK (status IN ('draft', 'queued', 'sent', 'failed')),
  CONSTRAINT email_drafts_confirmation_check
    CHECK (
      (status = 'draft' AND confirmed_at IS NULL AND outbox_id IS NULL)
      OR (status = 'queued' AND confirmed_at IS NOT NULL AND outbox_id IS NOT NULL)
      OR (status IN ('sent', 'failed') AND confirmed_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_email_drafts_user_updated
  ON email_drafts (user_id, updated_at DESC, id);

CREATE INDEX IF NOT EXISTS idx_email_drafts_expiry
  ON email_drafts (expires_at ASC, id)
  WHERE status IN ('draft', 'failed', 'sent');

INSERT INTO maintenance_job_status (job_name)
VALUES ('email_cache_retention')
ON CONFLICT (job_name) DO NOTHING;
