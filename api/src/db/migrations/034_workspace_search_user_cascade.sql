CREATE OR REPLACE FUNCTION nav_mark_workspace_search_dirty()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP <> 'DELETE' THEN
    INSERT INTO workspace_search_index_state (user_id, dirty, changed_at)
    SELECT NEW.user_id, TRUE, NOW()
    FROM users AS owner_user
    WHERE owner_user.id = NEW.user_id
    ON CONFLICT (user_id)
    DO UPDATE SET dirty = TRUE, changed_at = NOW();
  END IF;

  IF TG_OP <> 'INSERT' AND (TG_OP = 'DELETE' OR OLD.user_id <> NEW.user_id) THEN
    INSERT INTO workspace_search_index_state (user_id, dirty, changed_at)
    SELECT OLD.user_id, TRUE, NOW()
    FROM users AS owner_user
    WHERE owner_user.id = OLD.user_id
    ON CONFLICT (user_id)
    DO UPDATE SET dirty = TRUE, changed_at = NOW();
  END IF;

  RETURN NULL;
END;
$$;
