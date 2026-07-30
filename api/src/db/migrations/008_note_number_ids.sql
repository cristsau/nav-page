CREATE SEQUENCE IF NOT EXISTS notes_number_id_seq
  START WITH 1000
  INCREMENT BY 1
  MINVALUE 1000
  MAXVALUE 999999999999999;

ALTER SEQUENCE notes_number_id_seq
  MINVALUE 1000
  MAXVALUE 999999999999999;

ALTER TABLE notes
  ADD COLUMN IF NOT EXISTS number_id BIGINT;

ALTER TABLE notes
  ALTER COLUMN number_id SET DEFAULT nextval('notes_number_id_seq');

ALTER SEQUENCE notes_number_id_seq
  OWNED BY notes.number_id;

UPDATE notes
SET number_id = nextval('notes_number_id_seq')
WHERE number_id IS NULL;

SELECT setval(
  'notes_number_id_seq',
  COALESCE(MAX(number_id), 1000),
  MAX(number_id) IS NOT NULL
)
FROM notes;

ALTER TABLE notes
  ALTER COLUMN number_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'notes_number_id_range'
      AND conrelid = 'notes'::regclass
  ) THEN
    ALTER TABLE notes
      ADD CONSTRAINT notes_number_id_range
      CHECK (number_id BETWEEN 1000 AND 999999999999999);
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_number_id
  ON notes (number_id);
