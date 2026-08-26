CREATE TABLE IF NOT EXISTS assistant_agent_operations (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_id UUID NOT NULL,
  conversation_id UUID REFERENCES assistant_conversations(id) ON DELETE SET NULL,
  message_id UUID REFERENCES assistant_messages(id) ON DELETE SET NULL,
  response_message_id UUID REFERENCES assistant_messages(id) ON DELETE SET NULL,
  tool_name VARCHAR(80) NOT NULL,
  tool_version SMALLINT NOT NULL DEFAULT 1,
  risk VARCHAR(16) NOT NULL,
  authorization_mode VARCHAR(24) NOT NULL,
  arguments_hash CHAR(64) NOT NULL,
  status VARCHAR(24) NOT NULL,
  response_status SMALLINT,
  resource_type VARCHAR(32),
  resource_id UUID,
  result_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_code VARCHAR(64),
  started_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  undo_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT assistant_agent_operations_pkey
    PRIMARY KEY (user_id, operation_id),
  CONSTRAINT assistant_agent_operations_tool_name_check
    CHECK (tool_name ~ '^[a-z][a-z0-9_]{2,79}$'),
  CONSTRAINT assistant_agent_operations_tool_version_check
    CHECK (tool_version BETWEEN 1 AND 32767),
  CONSTRAINT assistant_agent_operations_risk_check
    CHECK (risk IN ('read', 'write', 'risky')),
  CONSTRAINT assistant_agent_operations_authorization_mode_check
    CHECK (authorization_mode IN ('explicit_command', 'confirmation')),
  CONSTRAINT assistant_agent_operations_arguments_hash_check
    CHECK (arguments_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT assistant_agent_operations_status_check
    CHECK (status IN (
      'proposed', 'awaiting_confirmation', 'running',
      'succeeded', 'failed', 'cancelled', 'undone'
    )),
  CONSTRAINT assistant_agent_operations_response_status_check
    CHECK (response_status IS NULL OR response_status BETWEEN 200 AND 599),
  CONSTRAINT assistant_agent_operations_resource_pair_check
    CHECK (
      (resource_type IS NULL AND resource_id IS NULL)
      OR (
        resource_type ~ '^[a-z][a-z0-9_]{1,31}$'
        AND resource_id IS NOT NULL
      )
    ),
  CONSTRAINT assistant_agent_operations_result_summary_check
    CHECK (
      jsonb_typeof(result_summary) = 'object'
      AND octet_length(result_summary::text) <= 2048
    ),
  CONSTRAINT assistant_agent_operations_error_code_check
    CHECK (
      error_code IS NULL
      OR error_code ~ '^[a-z][a-z0-9_.-]{1,63}$'
    ),
  CONSTRAINT assistant_agent_operations_undo_window_check
    CHECK (undo_until IS NULL OR completed_at IS NULL OR undo_until > completed_at)
);

CREATE INDEX IF NOT EXISTS idx_assistant_agent_operations_user_created
  ON assistant_agent_operations (user_id, created_at DESC, operation_id);

CREATE INDEX IF NOT EXISTS idx_assistant_agent_operations_conversation_created
  ON assistant_agent_operations (conversation_id, created_at DESC, operation_id)
  WHERE conversation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_assistant_agent_operations_message
  ON assistant_agent_operations (message_id, operation_id)
  WHERE message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_assistant_agent_operations_response_message
  ON assistant_agent_operations (response_message_id, operation_id)
  WHERE response_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_assistant_agent_operations_undo
  ON assistant_agent_operations (user_id, undo_until, operation_id)
  WHERE status = 'succeeded' AND undo_until IS NOT NULL;
