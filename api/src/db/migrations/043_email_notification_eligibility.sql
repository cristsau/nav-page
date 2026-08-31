ALTER TABLE email_classification_jobs
  ADD COLUMN IF NOT EXISTS notification_eligible BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN email_classification_jobs.notification_eligible IS
  'True only when the message was observed after the mailbox completed its initial catch-up; false keeps historical synchronization classifiable but silent.';
