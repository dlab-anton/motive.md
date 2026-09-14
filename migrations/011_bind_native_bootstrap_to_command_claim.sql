-- Keep the initial applied binding schema immutable. Require the exact launch
-- attempt and claim epoch even for SQL callers, and serialize initial binding
-- with provider terminal observations on the environment row.
CREATE OR REPLACE FUNCTION motive.guard_native_workspace_binding()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, motive AS $$
DECLARE environment motive.orchestration_environments%ROWTYPE;
BEGIN
  SELECT * INTO environment FROM motive.orchestration_environments WHERE id = NEW.environment_id FOR UPDATE;
  IF NOT FOUND OR environment.kind <> 'WORKER'
    OR environment.state IN ('TERMINATED', 'ABANDONED')
    OR (environment.attempt_id, environment.provider, environment.external_id,
        environment.session_id, environment.lease_epoch, environment.controller_generation,
        environment.profile_digest)
       IS DISTINCT FROM
       (NEW.attempt_id, NEW.provider, NEW.external_id, NEW.session_id,
        NEW.lease_epoch, NEW.controller_generation, NEW.profile_digest)
    OR (environment.profile_snapshot #>> '{protectedRuntime,runtimeDigest}') IS DISTINCT FROM NEW.worker_runtime_digest
    OR NOT EXISTS (SELECT 1 FROM motive.orchestration_effects
       WHERE environment_id = NEW.environment_id AND attempt_id = NEW.attempt_id
         AND claimed_lease_epoch = NEW.lease_epoch AND kind = 'COMMAND'
         AND state IN ('CLAIMED', 'UNKNOWN', 'RESULT_RECORDED'))
  THEN
    RAISE EXCEPTION 'native workspace binding requires the exact launched protected worker' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
