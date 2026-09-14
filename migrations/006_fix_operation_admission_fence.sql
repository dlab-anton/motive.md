-- 005 introduced the admission-fence trigger.  Its local variable name
-- collided with a column name under PostgreSQL's PL/pgSQL name resolution.
-- Keep 005 immutable and replace only the function with qualified names.
CREATE OR REPLACE FUNCTION motive.require_operation_admission_fence()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  expected_lease_epoch INTEGER;
  expected_attempt_generation BIGINT;
  expected_controller_generation BIGINT;
BEGIN
  IF NEW.admission_lease_epoch IS NULL OR NEW.admission_controller_generation IS NULL THEN
    RAISE EXCEPTION 'new request operations require an admission lease and controller generation' USING ERRCODE = '55000';
  END IF;

  SELECT a.lease_epoch, a.controller_generation
    INTO expected_lease_epoch, expected_attempt_generation
    FROM motive.attempts AS a
    WHERE a.id = NEW.attempt_id;

  SELECT s.generation
    INTO expected_controller_generation
    FROM motive.controller_state AS s
    WHERE s.singleton = TRUE;

  IF expected_lease_epoch IS NULL OR expected_attempt_generation IS NULL OR expected_controller_generation IS NULL
    OR NEW.admission_lease_epoch <> expected_lease_epoch
    OR NEW.admission_controller_generation <> expected_attempt_generation
    OR NEW.admission_controller_generation <> expected_controller_generation THEN
    RAISE EXCEPTION 'request operation admission fence does not match the current attempt/controller' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
