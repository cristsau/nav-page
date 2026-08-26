CREATE TABLE IF NOT EXISTS email_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_key VARCHAR(80) NOT NULL,
  label VARCHAR(120) NOT NULL DEFAULT '个人邮箱',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_connected_at TIMESTAMPTZ,
  last_error_at TIMESTAMPTZ,
  last_error_code VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT email_accounts_source_key_check
    CHECK (source_key ~ '^[a-z0-9_.-]+$'),
  CONSTRAINT email_accounts_label_check
    CHECK (char_length(label) BETWEEN 1 AND 120 AND label = BTRIM(label)),
  CONSTRAINT email_accounts_capabilities_check
    CHECK (jsonb_typeof(capabilities) = 'object'),
  CONSTRAINT email_accounts_error_code_check
    CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_.-]+$'),
  CONSTRAINT email_accounts_user_source_unique
    UNIQUE (user_id, source_key),
  CONSTRAINT email_accounts_identity_user_unique
    UNIQUE (id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_email_accounts_user_enabled
  ON email_accounts (user_id, enabled, id);

CREATE TABLE IF NOT EXISTS email_folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL,
  user_id UUID NOT NULL,
  path VARCHAR(512) NOT NULL,
  path_hash CHAR(64) NOT NULL,
  delimiter VARCHAR(8),
  special_use VARCHAR(16),
  selectable BOOLEAN NOT NULL DEFAULT TRUE,
  subscribed BOOLEAN NOT NULL DEFAULT TRUE,
  uid_validity BIGINT,
  uid_next BIGINT,
  highest_modseq NUMERIC(20, 0),
  last_uid BIGINT NOT NULL DEFAULT 0,
  sync_generation BIGINT NOT NULL DEFAULT 1,
  initial_sync_complete BOOLEAN NOT NULL DEFAULT FALSE,
  last_listed_at TIMESTAMPTZ,
  last_synced_at TIMESTAMPTZ,
  last_error_at TIMESTAMPTZ,
  last_error_code VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT email_folders_account_user_fkey
    FOREIGN KEY (account_id, user_id)
    REFERENCES email_accounts(id, user_id) ON DELETE CASCADE,
  CONSTRAINT email_folders_path_check
    CHECK (
      char_length(path) BETWEEN 1 AND 512
      AND path !~ '[[:cntrl:]]'
    ),
  CONSTRAINT email_folders_path_hash_check
    CHECK (path_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT email_folders_delimiter_check
    CHECK (
      delimiter IS NULL
      OR (char_length(delimiter) BETWEEN 1 AND 8 AND delimiter !~ '[[:cntrl:]]')
    ),
  CONSTRAINT email_folders_special_use_check
    CHECK (
      special_use IS NULL
      OR special_use IN (
        'inbox', 'sent', 'drafts', 'trash', 'junk', 'archive',
        'all', 'important', 'flagged'
      )
    ),
  CONSTRAINT email_folders_uid_validity_check
    CHECK (uid_validity IS NULL OR uid_validity BETWEEN 1 AND 4294967295),
  CONSTRAINT email_folders_uid_next_check
    CHECK (uid_next IS NULL OR uid_next BETWEEN 1 AND 4294967295),
  CONSTRAINT email_folders_highest_modseq_check
    CHECK (
      highest_modseq IS NULL
      OR highest_modseq BETWEEN 1 AND 18446744073709551615
    ),
  CONSTRAINT email_folders_last_uid_check
    CHECK (last_uid BETWEEN 0 AND 4294967295),
  CONSTRAINT email_folders_sync_generation_check
    CHECK (sync_generation >= 1),
  CONSTRAINT email_folders_error_code_check
    CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_.-]+$'),
  CONSTRAINT email_folders_account_path_unique
    UNIQUE (account_id, path_hash),
  CONSTRAINT email_folders_identity_account_user_unique
    UNIQUE (id, account_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_email_folders_user_special_use
  ON email_folders (user_id, account_id, special_use, id);

CREATE INDEX IF NOT EXISTS idx_email_folders_sync_due
  ON email_folders (last_synced_at ASC NULLS FIRST, id)
  WHERE selectable = TRUE;

CREATE TABLE IF NOT EXISTS email_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL,
  user_id UUID NOT NULL,
  canonical_hash CHAR(64) NOT NULL,
  message_id_hash CHAR(64),
  thread_key_hash CHAR(64) NOT NULL,
  envelope_encrypted BYTEA NOT NULL,
  content_encrypted BYTEA NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  size_bytes BIGINT NOT NULL DEFAULT 0,
  has_attachments BOOLEAN NOT NULL DEFAULT FALSE,
  attachment_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT email_messages_account_user_fkey
    FOREIGN KEY (account_id, user_id)
    REFERENCES email_accounts(id, user_id) ON DELETE CASCADE,
  CONSTRAINT email_messages_canonical_hash_check
    CHECK (canonical_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT email_messages_message_id_hash_check
    CHECK (message_id_hash IS NULL OR message_id_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT email_messages_thread_key_hash_check
    CHECK (thread_key_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT email_messages_envelope_size_check
    CHECK (octet_length(envelope_encrypted) BETWEEN 32 AND 1048576),
  CONSTRAINT email_messages_content_size_check
    CHECK (octet_length(content_encrypted) BETWEEN 32 AND 8388608),
  CONSTRAINT email_messages_size_bytes_check
    CHECK (size_bytes >= 0),
  CONSTRAINT email_messages_attachment_count_check
    CHECK (attachment_count BETWEEN 0 AND 10000),
  CONSTRAINT email_messages_account_canonical_unique
    UNIQUE (account_id, canonical_hash),
  CONSTRAINT email_messages_identity_account_user_unique
    UNIQUE (id, account_id, user_id),
  CONSTRAINT email_messages_identity_user_unique
    UNIQUE (id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_email_messages_user_received
  ON email_messages (user_id, received_at DESC, id);

CREATE INDEX IF NOT EXISTS idx_email_messages_account_thread
  ON email_messages (account_id, thread_key_hash, received_at DESC, id);

CREATE TABLE IF NOT EXISTS email_folder_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  folder_id UUID NOT NULL,
  message_id UUID NOT NULL,
  account_id UUID NOT NULL,
  user_id UUID NOT NULL,
  uid_validity BIGINT NOT NULL,
  uid BIGINT NOT NULL,
  modseq NUMERIC(20, 0),
  seen BOOLEAN NOT NULL DEFAULT FALSE,
  answered BOOLEAN NOT NULL DEFAULT FALSE,
  flagged BOOLEAN NOT NULL DEFAULT FALSE,
  draft BOOLEAN NOT NULL DEFAULT FALSE,
  deleted BOOLEAN NOT NULL DEFAULT FALSE,
  keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
  internal_date TIMESTAMPTZ NOT NULL,
  size_bytes BIGINT NOT NULL DEFAULT 0,
  expunged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT email_folder_messages_folder_account_user_fkey
    FOREIGN KEY (folder_id, account_id, user_id)
    REFERENCES email_folders(id, account_id, user_id) ON DELETE CASCADE,
  CONSTRAINT email_folder_messages_message_account_user_fkey
    FOREIGN KEY (message_id, account_id, user_id)
    REFERENCES email_messages(id, account_id, user_id) ON DELETE CASCADE,
  CONSTRAINT email_folder_messages_uid_validity_check
    CHECK (uid_validity BETWEEN 1 AND 4294967295),
  CONSTRAINT email_folder_messages_uid_check
    CHECK (uid BETWEEN 1 AND 4294967295),
  CONSTRAINT email_folder_messages_modseq_check
    CHECK (modseq IS NULL OR modseq BETWEEN 1 AND 18446744073709551615),
  CONSTRAINT email_folder_messages_keywords_check
    CHECK (jsonb_typeof(keywords) = 'array'),
  CONSTRAINT email_folder_messages_size_bytes_check
    CHECK (size_bytes >= 0),
  CONSTRAINT email_folder_messages_remote_identity_unique
    UNIQUE (folder_id, uid_validity, uid)
);

CREATE INDEX IF NOT EXISTS idx_email_folder_messages_folder_current
  ON email_folder_messages (user_id, folder_id, internal_date DESC, id)
  WHERE expunged_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_email_folder_messages_unread
  ON email_folder_messages (user_id, folder_id, internal_date DESC, id)
  WHERE expunged_at IS NULL AND seen = FALSE;

CREATE INDEX IF NOT EXISTS idx_email_folder_messages_flagged
  ON email_folder_messages (user_id, internal_date DESC, id)
  WHERE expunged_at IS NULL AND flagged = TRUE;

CREATE INDEX IF NOT EXISTS idx_email_folder_messages_message_current
  ON email_folder_messages (user_id, message_id, folder_id)
  WHERE expunged_at IS NULL;

ALTER TABLE email_events
  ADD COLUMN IF NOT EXISTS email_message_id UUID;

ALTER TABLE email_events
  ADD CONSTRAINT email_events_message_user_fkey
    FOREIGN KEY (email_message_id, user_id)
    REFERENCES email_messages(id, user_id) ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_events_user_message_unique
  ON email_events (user_id, email_message_id)
  WHERE email_message_id IS NOT NULL;

INSERT INTO email_accounts (
  user_id, source_key, last_connected_at, last_error_at, last_error_code,
  created_at, updated_at
)
SELECT
  state.user_id,
  state.source_key,
  state.last_connected_at,
  state.last_error_at,
  state.last_error_code,
  NOW(),
  state.updated_at
FROM email_mailbox_state AS state
ON CONFLICT (user_id, source_key) DO NOTHING;

INSERT INTO email_folders (
  account_id, user_id, path, path_hash, delimiter, special_use,
  selectable, subscribed, uid_validity, uid_next, last_uid,
  sync_generation, initial_sync_complete, last_synced_at,
  last_error_at, last_error_code, created_at, updated_at
)
SELECT
  account.id,
  state.user_id,
  'INBOX',
  '83ecb521bf320f677287e8b923809bb34d74bad9628f713ed0e0ce4cfe04f2f8',
  NULL,
  'inbox',
  TRUE,
  TRUE,
  CASE
    WHEN state.uid_validity ~ '^[0-9]{1,10}$'
      THEN CASE
        WHEN state.uid_validity::NUMERIC BETWEEN 1 AND 4294967295
          THEN state.uid_validity::BIGINT
        ELSE NULL
      END
    ELSE NULL
  END,
  CASE
    WHEN state.last_uid BETWEEN 0 AND 4294967294 THEN state.last_uid + 1
    ELSE NULL
  END,
  LEAST(state.last_uid, 4294967295),
  1,
  FALSE,
  state.last_connected_at,
  state.last_error_at,
  state.last_error_code,
  NOW(),
  state.updated_at
FROM email_mailbox_state AS state
JOIN email_accounts AS account
  ON account.user_id = state.user_id
 AND account.source_key = state.source_key
ON CONFLICT (account_id, path_hash) DO NOTHING;
