CREATE TABLE IF NOT EXISTS email_mailbox_state (
  source_key VARCHAR(80) PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  uid_validity TEXT,
  last_uid BIGINT NOT NULL DEFAULT 0,
  last_connected_at TIMESTAMPTZ,
  last_message_at TIMESTAMPTZ,
  last_error_at TIMESTAMPTZ,
  last_error_code VARCHAR(64),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT email_mailbox_state_source_key_check
    CHECK (source_key ~ '^[a-z0-9_.-]+$'),
  CONSTRAINT email_mailbox_state_last_uid_check
    CHECK (last_uid >= 0),
  CONSTRAINT email_mailbox_state_error_code_check
    CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_.-]+$')
);

CREATE TABLE IF NOT EXISTS email_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_key VARCHAR(80) NOT NULL,
  mailbox_uid BIGINT,
  message_id_hash CHAR(64) NOT NULL,
  sender_hash CHAR(64) NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  tier SMALLINT NOT NULL,
  urgency VARCHAR(12) NOT NULL,
  deterministic_signature CHAR(64) NOT NULL,
  event_signature CHAR(64) NOT NULL,
  state_signature CHAR(64) NOT NULL,
  duplicate_of UUID REFERENCES email_events(id) ON DELETE SET NULL,
  classification_status VARCHAR(16) NOT NULL,
  provider VARCHAR(64),
  model VARCHAR(256),
  content_encrypted BYTEA NOT NULL,
  notified_at TIMESTAMPTZ,
  digested_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT email_events_source_key_check
    CHECK (source_key ~ '^[a-z0-9_.-]+$'),
  CONSTRAINT email_events_mailbox_uid_check
    CHECK (mailbox_uid IS NULL OR mailbox_uid > 0),
  CONSTRAINT email_events_message_id_hash_check
    CHECK (message_id_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT email_events_sender_hash_check
    CHECK (sender_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT email_events_tier_check
    CHECK (tier IN (1, 2, 3)),
  CONSTRAINT email_events_urgency_check
    CHECK (urgency IN ('high', 'medium', 'low')),
  CONSTRAINT email_events_event_signature_check
    CHECK (event_signature ~ '^[0-9a-f]{64}$'),
  CONSTRAINT email_events_deterministic_signature_check
    CHECK (deterministic_signature ~ '^[0-9a-f]{64}$'),
  CONSTRAINT email_events_state_signature_check
    CHECK (state_signature ~ '^[0-9a-f]{64}$'),
  CONSTRAINT email_events_classification_status_check
    CHECK (classification_status IN ('ai', 'fallback')),
  CONSTRAINT email_events_content_size_check
    CHECK (octet_length(content_encrypted) BETWEEN 32 AND 1048576),
  CONSTRAINT email_events_source_message_unique
    UNIQUE (user_id, source_key, message_id_hash)
);

CREATE INDEX IF NOT EXISTS idx_email_events_user_received
  ON email_events (user_id, received_at DESC, id);

CREATE INDEX IF NOT EXISTS idx_email_events_event_state
  ON email_events (user_id, event_signature, received_at DESC, id);

CREATE INDEX IF NOT EXISTS idx_email_events_deterministic
  ON email_events (user_id, deterministic_signature, received_at DESC, id);

CREATE INDEX IF NOT EXISTS idx_email_events_pending_digest
  ON email_events (user_id, received_at ASC, id)
  WHERE tier = 2 AND digested_at IS NULL AND duplicate_of IS NULL;

CREATE TABLE IF NOT EXISTS assistant_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '新对话',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT assistant_conversations_title_check
    CHECK (char_length(title) BETWEEN 1 AND 160)
);

CREATE INDEX IF NOT EXISTS idx_assistant_conversations_user_updated
  ON assistant_conversations (user_id, updated_at DESC, id);

CREATE TABLE IF NOT EXISTS assistant_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(16) NOT NULL,
  content TEXT NOT NULL,
  content_encrypted BYTEA,
  content_sensitive BOOLEAN NOT NULL DEFAULT FALSE,
  sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  provider VARCHAR(64),
  model VARCHAR(256),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  search_document TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('simple', COALESCE(content, ''))
  ) STORED,
  CONSTRAINT assistant_messages_role_check
    CHECK (role IN ('user', 'assistant')),
  CONSTRAINT assistant_messages_content_check
    CHECK (char_length(content) BETWEEN 1 AND 20000),
  CONSTRAINT assistant_messages_encrypted_content_size_check
    CHECK (
      content_encrypted IS NULL
      OR octet_length(content_encrypted) BETWEEN 32 AND 1048576
    ),
  CONSTRAINT assistant_messages_sensitive_content_check
    CHECK (
      (content_sensitive = FALSE AND content_encrypted IS NULL)
      OR (content_sensitive = TRUE AND content_encrypted IS NOT NULL)
    ),
  CONSTRAINT assistant_messages_sources_check
    CHECK (jsonb_typeof(sources) = 'array')
);

CREATE INDEX IF NOT EXISTS idx_assistant_messages_conversation_created
  ON assistant_messages (conversation_id, created_at ASC, id);

CREATE INDEX IF NOT EXISTS idx_assistant_messages_user_search
  ON assistant_messages USING GIN (search_document);

INSERT INTO maintenance_job_status (job_name)
VALUES
  ('email_ingest'),
  ('email_digest')
ON CONFLICT (job_name) DO NOTHING;
