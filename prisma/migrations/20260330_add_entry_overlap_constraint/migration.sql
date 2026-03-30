CREATE OR REPLACE FUNCTION entry_prevent_overlap() RETURNS trigger AS $$
DECLARE
  is_leave boolean;
BEGIN
  is_leave := (NEW.project_id = 1) OR (NEW.notes LIKE '[BambooHR Leave]%');

  IF is_leave THEN
    DELETE FROM entry e
    WHERE e.employee_id = NEW.employee_id
      AND e.date = NEW.date
      AND e.start_time < NEW.end_time
      AND e.end_time > NEW.start_time
      AND (NEW.id IS NULL OR e.id <> NEW.id);
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM entry e
    WHERE e.employee_id = NEW.employee_id
      AND e.date = NEW.date
      AND e.start_time < NEW.end_time
      AND e.end_time > NEW.start_time
      AND (NEW.id IS NULL OR e.id <> NEW.id)
  ) THEN
    RAISE EXCEPTION 'Entry overlaps an existing timesheet entry'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS entry_prevent_overlap_trigger ON "entry";

CREATE TRIGGER entry_prevent_overlap_trigger
BEFORE INSERT OR UPDATE ON "entry"
FOR EACH ROW
EXECUTE FUNCTION entry_prevent_overlap();
