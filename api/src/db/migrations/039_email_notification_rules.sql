CREATE TABLE IF NOT EXISTS email_notification_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL,
  scope VARCHAR(16) NOT NULL,
  action VARCHAR(16) NOT NULL,
  priority SMALLINT NOT NULL,
  match_value_digest CHAR(64) NOT NULL,
  match_value_encrypted BYTEA NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  critical_override_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMPTZ,
  explanation TEXT NOT NULL DEFAULT '',
  hit_count BIGINT NOT NULL DEFAULT 0,
  last_hit_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT email_notification_rules_account_user_fkey
    FOREIGN KEY (account_id, user_id)
    REFERENCES email_accounts(id, user_id) ON DELETE CASCADE,
  CONSTRAINT email_notification_rules_scope_check
    CHECK (scope IN ('conversation', 'sender', 'domain', 'category', 'account')),
  CONSTRAINT email_notification_rules_action_check
    CHECK (action IN ('immediate', 'digest', 'in_app_only', 'silent')),
  CONSTRAINT email_notification_rules_priority_check
    CHECK (priority IN (100, 200, 300, 400, 500)),
  CONSTRAINT email_notification_rules_match_digest_check
    CHECK (match_value_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT email_notification_rules_match_ciphertext_size_check
    CHECK (octet_length(match_value_encrypted) BETWEEN 32 AND 65536),
  CONSTRAINT email_notification_rules_explanation_check
    CHECK (char_length(explanation) <= 600),
  CONSTRAINT email_notification_rules_hit_count_check
    CHECK (hit_count >= 0),
  CONSTRAINT email_notification_rules_expiry_check
    CHECK (expires_at IS NULL OR expires_at > created_at),
  CONSTRAINT email_notification_rules_identity_user_unique
    UNIQUE (id, user_id),
  CONSTRAINT email_notification_rules_identity_unique
    UNIQUE (user_id, account_id, scope, match_value_digest)
);

CREATE INDEX IF NOT EXISTS idx_email_notification_rules_active
  ON email_notification_rules (
    user_id, account_id, enabled, priority DESC, updated_at DESC, id
  );

CREATE INDEX IF NOT EXISTS idx_email_notification_rules_expiry
  ON email_notification_rules (expires_at ASC, id)
  WHERE enabled = TRUE AND expires_at IS NOT NULL;

ALTER TABLE email_events
  ADD COLUMN IF NOT EXISTS category VARCHAR(24) NOT NULL DEFAULT 'other',
  ADD COLUMN IF NOT EXISTS importance_score SMALLINT NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS notification_action VARCHAR(16),
  ADD COLUMN IF NOT EXISTS notification_reason TEXT,
  ADD COLUMN IF NOT EXISTS notification_rule_id UUID,
  ADD COLUMN IF NOT EXISTS notification_evaluated_at TIMESTAMPTZ;

UPDATE email_events
SET
  importance_score = CASE
    WHEN tier = 1 AND urgency = 'high' THEN 95
    WHEN tier = 1 THEN 85
    WHEN tier = 2 AND urgency = 'high' THEN 75
    WHEN tier = 2 AND urgency = 'medium' THEN 65
    WHEN tier = 2 THEN 55
    WHEN urgency = 'high' THEN 45
    WHEN urgency = 'medium' THEN 35
    ELSE 20
  END,
  notification_action = CASE
    WHEN tier = 1 THEN 'immediate'
    WHEN tier = 2 THEN 'digest'
    ELSE 'silent'
  END,
  notification_reason = CASE
    WHEN tier = 1 THEN '默认策略：高风险邮件立即提醒。'
    WHEN tier = 2 THEN '默认策略：当天处理邮件进入摘要。'
    ELSE '默认策略：低风险邮件静默收件。'
  END,
  notification_evaluated_at = COALESCE(notification_evaluated_at, updated_at, created_at)
WHERE notification_action IS NULL
   OR notification_reason IS NULL
   OR notification_evaluated_at IS NULL;

ALTER TABLE email_events
  ALTER COLUMN notification_action SET DEFAULT 'silent',
  ALTER COLUMN notification_action SET NOT NULL,
  ALTER COLUMN notification_reason SET DEFAULT '',
  ALTER COLUMN notification_reason SET NOT NULL,
  ALTER COLUMN notification_evaluated_at SET DEFAULT NOW(),
  ALTER COLUMN notification_evaluated_at SET NOT NULL;

ALTER TABLE email_events
  ADD CONSTRAINT email_events_category_check
    CHECK (
      category IN (
        'security', 'payment', 'operations', 'action', 'status',
        'personal', 'marketing', 'social', 'other'
      )
    ),
  ADD CONSTRAINT email_events_importance_score_check
    CHECK (importance_score BETWEEN 0 AND 100),
  ADD CONSTRAINT email_events_notification_action_check
    CHECK (
      notification_action IS NULL
      OR notification_action IN ('immediate', 'digest', 'in_app_only', 'silent')
    ),
  ADD CONSTRAINT email_events_notification_reason_check
    CHECK (notification_reason IS NULL OR char_length(notification_reason) <= 1000),
  ADD CONSTRAINT email_events_notification_rule_fkey
    FOREIGN KEY (notification_rule_id, user_id)
    REFERENCES email_notification_rules(id, user_id)
    ON DELETE SET NULL (notification_rule_id);

CREATE INDEX IF NOT EXISTS idx_email_events_pending_notification_digest
  ON email_events (user_id, received_at ASC, id)
  WHERE notification_action = 'digest'
    AND digested_at IS NULL
    AND duplicate_of IS NULL;

CREATE INDEX IF NOT EXISTS idx_email_events_user_category
  ON email_events (user_id, category, received_at DESC, id);
