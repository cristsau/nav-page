ALTER TABLE email_folder_messages
  ADD CONSTRAINT email_folder_messages_identity_account_user_unique
    UNIQUE (id, account_id, user_id);

CREATE TABLE email_remote_commands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL,
  source_location_id UUID NOT NULL,
  source_folder_id UUID NOT NULL,
  source_message_id UUID NOT NULL,
  target_folder_id UUID,
  action VARCHAR(24) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'scheduled',
  idempotency_key VARCHAR(128) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  expected_uid_validity BIGINT NOT NULL,
  expected_uid BIGINT NOT NULL,
  expected_modseq NUMERIC(20, 0),
  expected_seen BOOLEAN NOT NULL,
  expected_flagged BOOLEAN NOT NULL,
  expected_deleted BOOLEAN NOT NULL,
  undo_until TIMESTAMPTZ NOT NULL,
  next_attempt_at TIMESTAMPTZ NOT NULL,
  attempt_count SMALLINT NOT NULL DEFAULT 0,
  max_attempts SMALLINT NOT NULL DEFAULT 5,
  started_at TIMESTAMPTZ,
  remote_mutation_started_at TIMESTAMPTZ,
  remote_mutation_completed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_error_code VARCHAR(64),
  result_folder_id UUID,
  result_uid_validity BIGINT,
  result_uid BIGINT,
  permanent_confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT email_remote_commands_account_user_fkey
    FOREIGN KEY (account_id, user_id)
    REFERENCES email_accounts(id, user_id) ON DELETE CASCADE,
  CONSTRAINT email_remote_commands_source_location_account_user_fkey
    FOREIGN KEY (source_location_id, account_id, user_id)
    REFERENCES email_folder_messages(id, account_id, user_id) ON DELETE CASCADE,
  CONSTRAINT email_remote_commands_source_folder_account_user_fkey
    FOREIGN KEY (source_folder_id, account_id, user_id)
    REFERENCES email_folders(id, account_id, user_id) ON DELETE CASCADE,
  CONSTRAINT email_remote_commands_source_message_account_user_fkey
    FOREIGN KEY (source_message_id, account_id, user_id)
    REFERENCES email_messages(id, account_id, user_id) ON DELETE CASCADE,
  CONSTRAINT email_remote_commands_target_folder_account_user_fkey
    FOREIGN KEY (target_folder_id, account_id, user_id)
    REFERENCES email_folders(id, account_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT email_remote_commands_result_folder_account_user_fkey
    FOREIGN KEY (result_folder_id, account_id, user_id)
    REFERENCES email_folders(id, account_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT email_remote_commands_action_check
    CHECK (action IN (
      'mark_read', 'mark_unread', 'star', 'unstar',
      'archive', 'move', 'trash', 'delete'
    )),
  CONSTRAINT email_remote_commands_status_check
    CHECK (status IN (
      'scheduled', 'running', 'retry_wait', 'succeeded',
      'conflict', 'failed', 'cancelled'
    )),
  CONSTRAINT email_remote_commands_idempotency_key_check
    CHECK (
      char_length(idempotency_key) BETWEEN 16 AND 128
      AND idempotency_key ~ '^[A-Za-z0-9._:-]+$'
    ),
  CONSTRAINT email_remote_commands_request_hash_check
    CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT email_remote_commands_uid_validity_check
    CHECK (expected_uid_validity BETWEEN 1 AND 4294967295),
  CONSTRAINT email_remote_commands_uid_check
    CHECK (expected_uid BETWEEN 1 AND 4294967295),
  CONSTRAINT email_remote_commands_modseq_check
    CHECK (
      expected_modseq IS NULL
      OR expected_modseq BETWEEN 1 AND 18446744073709551615
    ),
  CONSTRAINT email_remote_commands_attempt_count_check
    CHECK (attempt_count BETWEEN 0 AND 20 AND max_attempts BETWEEN 1 AND 20),
  CONSTRAINT email_remote_commands_error_code_check
    CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_.-]+$'),
  CONSTRAINT email_remote_commands_result_uid_validity_check
    CHECK (result_uid_validity IS NULL OR result_uid_validity BETWEEN 1 AND 4294967295),
  CONSTRAINT email_remote_commands_result_uid_check
    CHECK (result_uid IS NULL OR result_uid BETWEEN 1 AND 4294967295),
  CONSTRAINT email_remote_commands_move_target_check
    CHECK ((action = 'move' AND target_folder_id IS NOT NULL) OR action <> 'move'),
  CONSTRAINT email_remote_commands_delete_confirmation_check
    CHECK ((action = 'delete' AND permanent_confirmed_at IS NOT NULL) OR action <> 'delete'),
  CONSTRAINT email_remote_commands_undo_window_check
    CHECK (undo_until >= created_at AND next_attempt_at >= created_at),
  CONSTRAINT email_remote_commands_user_idempotency_unique
    UNIQUE (user_id, idempotency_key)
);

CREATE INDEX idx_email_remote_commands_due
  ON email_remote_commands (next_attempt_at ASC, created_at ASC, id)
  WHERE status IN ('scheduled', 'retry_wait');

CREATE INDEX idx_email_remote_commands_user_created
  ON email_remote_commands (user_id, created_at DESC, id DESC);

CREATE INDEX idx_email_remote_commands_source_location
  ON email_remote_commands (source_location_id, created_at DESC, id DESC);

INSERT INTO maintenance_job_status (job_name)
VALUES ('email_remote_commands')
ON CONFLICT (job_name) DO NOTHING;
