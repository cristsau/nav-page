CREATE TABLE IF NOT EXISTS assistant_agent_operation_payloads (
  user_id UUID NOT NULL,
  operation_id UUID NOT NULL,
  arguments JSONB NOT NULL,
  preview JSONB NOT NULL,
  sensitive_payload BYTEA,
  before_snapshot JSONB,
  confirmation_fingerprint CHAR(64) NOT NULL,
  after_fingerprint CHAR(64),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT assistant_agent_operation_payloads_pkey
    PRIMARY KEY (user_id, operation_id),
  CONSTRAINT assistant_agent_operation_payloads_operation_fkey
    FOREIGN KEY (user_id, operation_id)
    REFERENCES assistant_agent_operations(user_id, operation_id)
    ON DELETE CASCADE,
  CONSTRAINT assistant_agent_operation_payloads_arguments_check
    CHECK (
      jsonb_typeof(arguments) = 'object'
      AND octet_length(arguments::text) <= 1048576
    ),
  CONSTRAINT assistant_agent_operation_payloads_preview_check
    CHECK (
      jsonb_typeof(preview) = 'object'
      AND octet_length(preview::text) <= 8192
    ),
  CONSTRAINT assistant_agent_operation_payloads_snapshot_check
    CHECK (
      before_snapshot IS NULL
      OR (
        jsonb_typeof(before_snapshot) = 'object'
        AND octet_length(before_snapshot::text) <= 1048576
      )
    ),
  CONSTRAINT assistant_agent_operation_payloads_sensitive_size_check
    CHECK (
      sensitive_payload IS NULL
      OR octet_length(sensitive_payload) BETWEEN 32 AND 1048576
    ),
  CONSTRAINT assistant_agent_operation_payloads_fingerprint_check
    CHECK (
      (confirmation_fingerprint IS NULL OR confirmation_fingerprint ~ '^[0-9a-f]{64}$')
      AND (after_fingerprint IS NULL OR after_fingerprint ~ '^[0-9a-f]{64}$')
    ),
  CONSTRAINT assistant_agent_operation_payloads_expiry_check
    CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_assistant_agent_operation_payloads_expiry
  ON assistant_agent_operation_payloads (expires_at, operation_id);

CREATE INDEX IF NOT EXISTS idx_assistant_agent_operation_payloads_user_expiry
  ON assistant_agent_operation_payloads (user_id, expires_at, operation_id);
