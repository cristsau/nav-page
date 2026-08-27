ALTER TABLE email_drafts
  ADD CONSTRAINT email_drafts_identity_user_unique
    UNIQUE (id, user_id);

ALTER TABLE mail_outbox
  ADD CONSTRAINT mail_outbox_identity_user_unique
    UNIQUE (id, user_id);

CREATE TABLE IF NOT EXISTS email_attachment_objects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  draft_id UUID NOT NULL,
  outbox_id UUID,
  state VARCHAR(16) NOT NULL DEFAULT 'draft',
  ordinal SMALLINT NOT NULL,
  sha256 CHAR(64) NOT NULL,
  size_bytes BIGINT NOT NULL,
  chunk_count SMALLINT NOT NULL,
  metadata_encrypted BYTEA,
  metadata_digest CHAR(64) NOT NULL,
  scrubbed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT email_attachment_objects_draft_user_fkey
    FOREIGN KEY (draft_id, user_id)
    REFERENCES email_drafts(id, user_id) ON DELETE CASCADE,
  CONSTRAINT email_attachment_objects_outbox_user_fkey
    FOREIGN KEY (outbox_id, user_id)
    REFERENCES mail_outbox(id, user_id) ON DELETE CASCADE,
  CONSTRAINT email_attachment_objects_identity_user_unique
    UNIQUE (id, user_id),
  CONSTRAINT email_attachment_objects_state_check
    CHECK (state IN ('draft', 'claimed', 'scrubbed')),
  CONSTRAINT email_attachment_objects_ordinal_check
    CHECK (ordinal BETWEEN 0 AND 9),
  CONSTRAINT email_attachment_objects_sha256_check
    CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT email_attachment_objects_size_check
    CHECK (size_bytes BETWEEN 1 AND 10485760),
  CONSTRAINT email_attachment_objects_chunk_count_check
    CHECK (chunk_count BETWEEN 1 AND 40),
  CONSTRAINT email_attachment_objects_metadata_size_check
    CHECK (
      metadata_encrypted IS NULL
      OR octet_length(metadata_encrypted) BETWEEN 32 AND 32768
    ),
  CONSTRAINT email_attachment_objects_metadata_digest_check
    CHECK (metadata_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT email_attachment_objects_lifecycle_check
    CHECK (
      (
        state = 'draft'
        AND outbox_id IS NULL
        AND metadata_encrypted IS NOT NULL
        AND scrubbed_at IS NULL
      )
      OR (
        state = 'claimed'
        AND outbox_id IS NOT NULL
        AND metadata_encrypted IS NOT NULL
        AND scrubbed_at IS NULL
      )
      OR (
        state = 'scrubbed'
        AND outbox_id IS NOT NULL
        AND metadata_encrypted IS NULL
        AND scrubbed_at IS NOT NULL
      )
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_attachment_objects_draft_ordinal
  ON email_attachment_objects (draft_id, ordinal);

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_attachment_objects_outbox_ordinal
  ON email_attachment_objects (outbox_id, ordinal)
  WHERE outbox_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_email_attachment_objects_user_staged
  ON email_attachment_objects (user_id, state, created_at, id)
  WHERE state IN ('draft', 'claimed');

CREATE INDEX IF NOT EXISTS idx_email_attachment_objects_outbox_state
  ON email_attachment_objects (outbox_id, state, ordinal, id)
  WHERE outbox_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS email_attachment_chunks (
  attachment_id UUID NOT NULL,
  user_id UUID NOT NULL,
  chunk_index SMALLINT NOT NULL,
  plaintext_size INTEGER NOT NULL,
  ciphertext_encrypted BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (attachment_id, chunk_index),
  CONSTRAINT email_attachment_chunks_attachment_user_fkey
    FOREIGN KEY (attachment_id, user_id)
    REFERENCES email_attachment_objects(id, user_id) ON DELETE CASCADE,
  CONSTRAINT email_attachment_chunks_index_check
    CHECK (chunk_index BETWEEN 0 AND 39),
  CONSTRAINT email_attachment_chunks_plaintext_size_check
    CHECK (plaintext_size BETWEEN 1 AND 262144),
  CONSTRAINT email_attachment_chunks_ciphertext_size_check
    CHECK (octet_length(ciphertext_encrypted) = plaintext_size + 29)
);

CREATE INDEX IF NOT EXISTS idx_email_attachment_chunks_user_attachment
  ON email_attachment_chunks (user_id, attachment_id, chunk_index);
