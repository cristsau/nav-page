CREATE OR REPLACE FUNCTION nav_notify_note_sync_event()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  notification_note_id TEXT;
BEGIN
  IF NEW.event_kind NOT IN (
    'comment.upsert',
    'comment.delete',
    'member.upsert',
    'member.delete',
    'note.delete'
  ) THEN
    RETURN NEW;
  END IF;

  notification_note_id := COALESCE(
    NEW.note_id::TEXT,
    CASE WHEN NEW.event_kind = 'note.delete' THEN NEW.entity_id ELSE NULL END
  );

  IF notification_note_id IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM pg_notify(
    'nav_note_sync_events',
    json_build_object(
      'eventId', NEW.id::TEXT,
      'noteId', notification_note_id,
      'eventKind', NEW.event_kind
    )::TEXT
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_note_sync_events_notify ON note_sync_events;
CREATE TRIGGER trg_note_sync_events_notify
AFTER INSERT ON note_sync_events
FOR EACH ROW EXECUTE FUNCTION nav_notify_note_sync_event();
