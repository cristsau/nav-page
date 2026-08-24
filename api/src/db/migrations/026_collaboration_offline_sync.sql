CREATE TABLE IF NOT EXISTS note_collaborators (
  note_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  invited_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT note_collaborators_pkey PRIMARY KEY (note_id, user_id),
  CONSTRAINT note_collaborators_role_check
    CHECK (role IN ('editor', 'commenter', 'viewer'))
);

CREATE INDEX IF NOT EXISTS idx_note_collaborators_user_note
  ON note_collaborators (user_id, note_id);

CREATE TABLE IF NOT EXISTS note_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES note_comments(id) ON DELETE CASCADE,
  block_id TEXT,
  selection JSONB,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  edited_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT note_comments_body_check
    CHECK (char_length(btrim(body)) BETWEEN 1 AND 4000),
  CONSTRAINT note_comments_block_id_check
    CHECK (block_id IS NULL OR char_length(block_id) BETWEEN 1 AND 160),
  CONSTRAINT note_comments_selection_object_check
    CHECK (selection IS NULL OR jsonb_typeof(selection) = 'object'),
  CONSTRAINT note_comments_status_check
    CHECK (status IN ('open', 'resolved')),
  CONSTRAINT note_comments_resolution_state_check
    CHECK (
      (status = 'open' AND resolved_by IS NULL AND resolved_at IS NULL)
      OR (status = 'resolved' AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_note_comments_note_created
  ON note_comments (note_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_note_comments_note_open
  ON note_comments (note_id, updated_at DESC)
  WHERE status = 'open';

CREATE TABLE IF NOT EXISTS note_crdt_documents (
  note_id UUID PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  state BYTEA NOT NULL,
  state_vector BYTEA NOT NULL,
  update_count BIGINT NOT NULL DEFAULT 0,
  compacted_through BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT note_crdt_documents_update_count_check CHECK (update_count >= 0),
  CONSTRAINT note_crdt_documents_compacted_through_check CHECK (compacted_through >= 0)
);

CREATE TABLE IF NOT EXISTS note_crdt_updates (
  id BIGSERIAL PRIMARY KEY,
  note_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  update BYTEA NOT NULL,
  update_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT note_crdt_updates_payload_check CHECK (octet_length(update) BETWEEN 1 AND 1048576),
  CONSTRAINT note_crdt_updates_hash_check CHECK (update_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT note_crdt_updates_note_hash_key UNIQUE (note_id, update_hash)
);

CREATE INDEX IF NOT EXISTS idx_note_crdt_updates_note_id
  ON note_crdt_updates (note_id, id);

CREATE TABLE IF NOT EXISTS note_sync_events (
  id BIGSERIAL PRIMARY KEY,
  note_id UUID,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  event_kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  revision BIGINT,
  audience_user_ids UUID[] NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT note_sync_events_kind_check CHECK (
    event_kind IN (
      'note.upsert',
      'note.delete',
      'member.upsert',
      'member.delete',
      'comment.upsert',
      'comment.delete',
      'crdt.update'
    )
  ),
  CONSTRAINT note_sync_events_entity_id_check CHECK (char_length(entity_id) BETWEEN 1 AND 160),
  CONSTRAINT note_sync_events_revision_check CHECK (revision IS NULL OR revision >= 1),
  CONSTRAINT note_sync_events_audience_check CHECK (cardinality(audience_user_ids) > 0),
  CONSTRAINT note_sync_events_payload_object_check CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_note_sync_events_audience_id
  ON note_sync_events USING GIN (audience_user_ids);
CREATE INDEX IF NOT EXISTS idx_note_sync_events_created
  ON note_sync_events (created_at, id);

CREATE TABLE IF NOT EXISTS offline_mutation_receipts (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_id UUID NOT NULL,
  mutation_kind TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
  CONSTRAINT offline_mutation_receipts_pkey PRIMARY KEY (user_id, operation_id),
  CONSTRAINT offline_mutation_receipts_kind_check
    CHECK (char_length(mutation_kind) BETWEEN 1 AND 80),
  CONSTRAINT offline_mutation_receipts_request_hash_check
    CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT offline_mutation_receipts_response_status_check
    CHECK (response_status BETWEEN 200 AND 499),
  CONSTRAINT offline_mutation_receipts_payload_object_check
    CHECK (jsonb_typeof(response_payload) = 'object'),
  CONSTRAINT offline_mutation_receipts_expiry_check CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_offline_mutation_receipts_expiry
  ON offline_mutation_receipts (expires_at);

CREATE TABLE IF NOT EXISTS note_sync_devices (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id UUID NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  last_cursor BIGINT NOT NULL DEFAULT 0,
  last_sync_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT note_sync_devices_pkey PRIMARY KEY (user_id, device_id),
  CONSTRAINT note_sync_devices_label_check CHECK (char_length(label) <= 120),
  CONSTRAINT note_sync_devices_cursor_check CHECK (last_cursor >= 0)
);

CREATE OR REPLACE FUNCTION nav_validate_collaboration_target()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  target_owner_id UUID;
  target_encrypted BOOLEAN;
BEGIN
  SELECT user_id, encrypted
  INTO target_owner_id, target_encrypted
  FROM notes
  WHERE id = NEW.note_id;

  IF target_owner_id IS NULL THEN
    RAISE EXCEPTION 'collaboration target note does not exist' USING ERRCODE = '23503';
  END IF;
  IF target_encrypted THEN
    RAISE EXCEPTION 'encrypted notes cannot use server collaboration' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'note_collaborators' AND NEW.user_id = target_owner_id THEN
    RAISE EXCEPTION 'note owner cannot also be a collaborator' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_note_collaborators_validate_target ON note_collaborators;
CREATE TRIGGER trg_note_collaborators_validate_target
BEFORE INSERT OR UPDATE ON note_collaborators
FOR EACH ROW EXECUTE FUNCTION nav_validate_collaboration_target();

DROP TRIGGER IF EXISTS trg_note_comments_validate_target ON note_comments;
CREATE TRIGGER trg_note_comments_validate_target
BEFORE INSERT OR UPDATE ON note_comments
FOR EACH ROW EXECUTE FUNCTION nav_validate_collaboration_target();

DROP TRIGGER IF EXISTS trg_note_crdt_documents_validate_target ON note_crdt_documents;
CREATE TRIGGER trg_note_crdt_documents_validate_target
BEFORE INSERT OR UPDATE ON note_crdt_documents
FOR EACH ROW EXECUTE FUNCTION nav_validate_collaboration_target();

DROP TRIGGER IF EXISTS trg_note_crdt_updates_validate_target ON note_crdt_updates;
CREATE TRIGGER trg_note_crdt_updates_validate_target
BEFORE INSERT OR UPDATE ON note_crdt_updates
FOR EACH ROW EXECUTE FUNCTION nav_validate_collaboration_target();

CREATE OR REPLACE FUNCTION nav_note_sync_audience(target_note_id UUID)
RETURNS UUID[]
LANGUAGE SQL
STABLE
AS $$
  SELECT COALESCE(
    array_agg(DISTINCT audience_id ORDER BY audience_id),
    ARRAY[]::UUID[]
  )
  FROM (
    SELECT n.user_id AS audience_id
    FROM notes n
    WHERE n.id = target_note_id
    UNION ALL
    SELECT c.user_id
    FROM note_collaborators c
    WHERE c.note_id = target_note_id
  ) audience;
$$;

CREATE OR REPLACE FUNCTION nav_emit_note_sync_event()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  target_note_id UUID;
  target_owner_id UUID;
  target_audience UUID[];
  target_revision BIGINT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_note_id := OLD.id;
    target_owner_id := OLD.user_id;
    target_revision := COALESCE(OLD.revision, 1);
    SELECT array_agg(DISTINCT audience_id ORDER BY audience_id)
    INTO target_audience
    FROM (
      SELECT target_owner_id AS audience_id
      UNION ALL
      SELECT c.user_id FROM note_collaborators c WHERE c.note_id = target_note_id
    ) audience;
  ELSE
    target_note_id := NEW.id;
    target_owner_id := NEW.user_id;
    target_revision := COALESCE(NEW.revision, 1);
    target_audience := nav_note_sync_audience(target_note_id);
  END IF;

  INSERT INTO note_sync_events (
    note_id,
    event_kind,
    entity_id,
    revision,
    audience_user_ids,
    payload
  ) VALUES (
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE target_note_id END,
    CASE WHEN TG_OP = 'DELETE' THEN 'note.delete' ELSE 'note.upsert' END,
    target_note_id::TEXT,
    target_revision,
    target_audience,
    jsonb_build_object(
      'ownerId', target_owner_id,
      'deleted', TG_OP = 'DELETE'
    )
  );
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notes_sync_event ON notes;
DROP TRIGGER IF EXISTS trg_notes_sync_event_upsert ON notes;
DROP TRIGGER IF EXISTS trg_notes_sync_event_delete ON notes;
CREATE TRIGGER trg_notes_sync_event_upsert
AFTER INSERT OR UPDATE ON notes
FOR EACH ROW EXECUTE FUNCTION nav_emit_note_sync_event();
CREATE TRIGGER trg_notes_sync_event_delete
BEFORE DELETE ON notes
FOR EACH ROW EXECUTE FUNCTION nav_emit_note_sync_event();

CREATE OR REPLACE FUNCTION nav_emit_collaborator_sync_event()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  target_note_id UUID;
  target_user_id UUID;
  target_actor_id UUID;
  target_role TEXT;
  target_audience UUID[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_note_id := OLD.note_id;
    target_user_id := OLD.user_id;
    target_actor_id := OLD.invited_by;
    target_role := NULL;
  ELSE
    target_note_id := NEW.note_id;
    target_user_id := NEW.user_id;
    target_actor_id := NEW.invited_by;
    target_role := NEW.role;
  END IF;
  target_audience := nav_note_sync_audience(target_note_id);
  IF NOT target_user_id = ANY(target_audience) THEN
    target_audience := array_append(target_audience, target_user_id);
  END IF;

  INSERT INTO note_sync_events (
    note_id,
    actor_user_id,
    event_kind,
    entity_id,
    audience_user_ids,
    payload
  ) VALUES (
    target_note_id,
    target_actor_id,
    CASE WHEN TG_OP = 'DELETE' THEN 'member.delete' ELSE 'member.upsert' END,
    target_user_id::TEXT,
    target_audience,
    jsonb_build_object(
      'userId', target_user_id,
      'role', target_role,
      'deleted', TG_OP = 'DELETE'
    )
  );
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_note_collaborators_sync_event ON note_collaborators;
CREATE TRIGGER trg_note_collaborators_sync_event
AFTER INSERT OR UPDATE OR DELETE ON note_collaborators
FOR EACH ROW EXECUTE FUNCTION nav_emit_collaborator_sync_event();

CREATE OR REPLACE FUNCTION nav_emit_comment_sync_event()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  target_note_id UUID;
  target_comment_id UUID;
  target_actor_id UUID;
  target_status TEXT;
  target_audience UUID[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_note_id := OLD.note_id;
    target_comment_id := OLD.id;
    target_actor_id := OLD.user_id;
    target_status := NULL;
  ELSE
    target_note_id := NEW.note_id;
    target_comment_id := NEW.id;
    target_actor_id := NEW.user_id;
    target_status := NEW.status;
  END IF;
  target_audience := nav_note_sync_audience(target_note_id);
  IF cardinality(target_audience) = 0 THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  INSERT INTO note_sync_events (
    note_id,
    actor_user_id,
    event_kind,
    entity_id,
    audience_user_ids,
    payload
  ) VALUES (
    target_note_id,
    target_actor_id,
    CASE WHEN TG_OP = 'DELETE' THEN 'comment.delete' ELSE 'comment.upsert' END,
    target_comment_id::TEXT,
    target_audience,
    jsonb_build_object(
      'commentId', target_comment_id,
      'status', target_status,
      'deleted', TG_OP = 'DELETE'
    )
  );
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_note_comments_sync_event ON note_comments;
CREATE TRIGGER trg_note_comments_sync_event
AFTER INSERT OR UPDATE OR DELETE ON note_comments
FOR EACH ROW EXECUTE FUNCTION nav_emit_comment_sync_event();
