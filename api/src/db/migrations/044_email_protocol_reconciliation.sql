ALTER TABLE email_folders
  ADD COLUMN IF NOT EXISTS reconciled_modseq NUMERIC(20, 0),
  ADD COLUMN IF NOT EXISTS last_reconciled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_reconcile_mode VARCHAR(24),
  ADD COLUMN IF NOT EXISTS last_reconcile_error_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_reconcile_error_code VARCHAR(64);

ALTER TABLE email_folders
  DROP CONSTRAINT IF EXISTS email_folders_reconciled_modseq_check,
  ADD CONSTRAINT email_folders_reconciled_modseq_check
    CHECK (
      reconciled_modseq IS NULL
      OR reconciled_modseq BETWEEN 1 AND 18446744073709551615
    ),
  DROP CONSTRAINT IF EXISTS email_folders_reconcile_mode_check,
  ADD CONSTRAINT email_folders_reconcile_mode_check
    CHECK (
      last_reconcile_mode IS NULL
      OR last_reconcile_mode IN (
        'qresync', 'condstore', 'uid_flags_scan', 'uidvalidity_reset'
      )
    ),
  DROP CONSTRAINT IF EXISTS email_folders_reconcile_error_check,
  ADD CONSTRAINT email_folders_reconcile_error_check
    CHECK (
      last_reconcile_error_code IS NULL
      OR last_reconcile_error_code ~ '^[A-Z0-9_.-]+$'
    );

CREATE INDEX IF NOT EXISTS idx_email_folders_reconcile_due
  ON email_folders (last_reconciled_at ASC NULLS FIRST, id)
  WHERE selectable = TRUE AND subscribed = TRUE;
