ALTER TABLE assistant_conversations
  ADD COLUMN IF NOT EXISTS model_mode VARCHAR(16) NOT NULL DEFAULT 'latest',
  ADD COLUMN IF NOT EXISTS model VARCHAR(256),
  ADD COLUMN IF NOT EXISTS reasoning_effort VARCHAR(16) NOT NULL DEFAULT 'low';

ALTER TABLE assistant_conversations
  DROP CONSTRAINT IF EXISTS assistant_conversations_model_mode_check,
  ADD CONSTRAINT assistant_conversations_model_mode_check
    CHECK (model_mode IN ('latest', 'pinned')),
  DROP CONSTRAINT IF EXISTS assistant_conversations_model_check,
  ADD CONSTRAINT assistant_conversations_model_check
    CHECK (
      (model_mode = 'latest' AND model IS NULL)
      OR (model_mode = 'pinned' AND char_length(model) BETWEEN 1 AND 256)
    ),
  DROP CONSTRAINT IF EXISTS assistant_conversations_reasoning_effort_check,
  ADD CONSTRAINT assistant_conversations_reasoning_effort_check
    CHECK (reasoning_effort IN (
      'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'
    ));
