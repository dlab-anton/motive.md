-- Controller-private identity of the root-owned pre-exec workspace marker.
-- This records collector observations; it is not proof of image review.
CREATE TABLE motive.native_workspace_bindings (
  environment_id UUID PRIMARY KEY,
  attempt_id UUID NOT NULL,
  provider TEXT NOT NULL CHECK (provider = 'vercel'),
  external_id TEXT NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 512),
  session_id TEXT NOT NULL CHECK (session_id ~ '^[A-Za-z0-9_-]{1,512}$'),
  lease_epoch INTEGER NOT NULL CHECK (lease_epoch > 0),
  controller_generation BIGINT NOT NULL CHECK (controller_generation > 0),
  profile_digest TEXT NOT NULL CHECK (profile_digest ~ '^sha256:[a-f0-9]{64}$'),
  worker_runtime_digest TEXT NOT NULL CHECK (worker_runtime_digest ~ '^sha256:[a-f0-9]{64}$'),
  collector_runtime_digest TEXT NOT NULL CHECK (collector_runtime_digest ~ '^sha256:[a-f0-9]{64}$'),
  workspace_identity TEXT NOT NULL CHECK (workspace_identity ~ '^(0|[1-9][0-9]{0,19}):(0|[1-9][0-9]{0,19}):(0|[1-9][0-9]{0,19})$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (environment_id, attempt_id)
    REFERENCES motive.orchestration_environments(id, attempt_id) ON DELETE RESTRICT
);

CREATE FUNCTION motive.guard_native_workspace_binding()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, motive AS $$
DECLARE environment motive.orchestration_environments%ROWTYPE;
BEGIN
  SELECT * INTO environment FROM motive.orchestration_environments WHERE id = NEW.environment_id;
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
       WHERE environment_id = NEW.environment_id AND kind = 'COMMAND'
         AND state IN ('CLAIMED', 'UNKNOWN', 'RESULT_RECORDED'))
  THEN
    RAISE EXCEPTION 'native workspace binding requires the exact launched protected worker' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER native_workspace_binding_guard BEFORE INSERT ON motive.native_workspace_bindings
  FOR EACH ROW EXECUTE FUNCTION motive.guard_native_workspace_binding();
CREATE TRIGGER native_workspace_binding_immutable BEFORE UPDATE OR DELETE ON motive.native_workspace_bindings
  FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();
REVOKE ALL ON motive.native_workspace_bindings FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_native_workspace_binding() FROM PUBLIC;
