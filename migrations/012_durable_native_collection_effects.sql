-- Durable native collector commands are separate from the one worker COMMAND
-- effect. They are finite provider work: every bootstrap/capture has an intent,
-- exactly one claimant, and an immutable provider command identity if dispatch
-- returns. Raw stdout and candidate artifact bytes never enter PostgreSQL.

CREATE TYPE motive.native_collection_effect_kind AS ENUM ('BOOTSTRAP', 'CAPTURE');
CREATE TYPE motive.native_collection_effect_status AS ENUM (
  'INTENT_RECORDED', 'CLAIMED', 'START_RECORDED', 'COMPLETED', 'UNKNOWN'
);

-- A plan is frozen while the worker is still RESERVED and the CREATE effect is
-- unclaimed. It binds the finite path set to the exact future worker identity.
CREATE TABLE motive.native_collection_plans (
  environment_id UUID PRIMARY KEY REFERENCES motive.orchestration_environments(id) ON DELETE RESTRICT,
  attempt_id UUID NOT NULL REFERENCES motive.attempts(id) ON DELETE RESTRICT,
  lease_epoch INTEGER NOT NULL CHECK (lease_epoch > 0),
  controller_generation BIGINT NOT NULL CHECK (controller_generation > 0),
  profile_digest TEXT NOT NULL CHECK (profile_digest ~ '^sha256:[a-f0-9]{64}$'),
  worker_runtime_digest TEXT NOT NULL CHECK (worker_runtime_digest ~ '^sha256:[a-f0-9]{64}$'),
  collector_runtime_digest TEXT NOT NULL CHECK (collector_runtime_digest ~ '^sha256:[a-f0-9]{64}$'),
  collection_plan_digest TEXT NOT NULL CHECK (collection_plan_digest ~ '^sha256:[a-f0-9]{64}$'),
  maximum_file_bytes INTEGER NOT NULL CHECK (maximum_file_bytes > 0 AND maximum_file_bytes <= 8388608 AND maximum_file_bytes <= maximum_total_bytes),
  maximum_total_bytes BIGINT NOT NULL CHECK (maximum_total_bytes > 0 AND maximum_total_bytes <= 2147483647),
  maximum_files INTEGER NOT NULL CHECK (maximum_files BETWEEN 1 AND 10000),
  path_count INTEGER NOT NULL CHECK (path_count BETWEEN 1 AND 10000 AND path_count <= maximum_files),
  maximum_helper_commands INTEGER NOT NULL CHECK (maximum_helper_commands = path_count + 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (environment_id, collection_plan_digest)
);

CREATE TABLE motive.native_collection_plan_paths (
  environment_id UUID NOT NULL REFERENCES motive.native_collection_plans(environment_id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  relative_path TEXT NOT NULL CHECK (
    octet_length(relative_path) BETWEEN 1 AND 1024
    AND position(chr(92) IN relative_path) = 0
    AND relative_path !~ '[[:cntrl:]]'
    AND relative_path !~* '^[a-z]:'
    AND relative_path !~ '^/'
    AND relative_path !~ '(^|/)([.][.]?)(/|$)'
    AND position('//' IN relative_path) = 0
    AND right(relative_path, 1) <> '/'
    AND relative_path <> 'manifest.json'
  ),
  path_digest TEXT NOT NULL CHECK (path_digest ~ '^sha256:[a-f0-9]{64}$'),
  media_type TEXT NOT NULL CHECK (
    char_length(media_type) BETWEEN 1 AND 255
    AND media_type = lower(media_type)
    AND media_type ~ '^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+$'
  ),
  availability TEXT NOT NULL CHECK (availability IN ('REQUIRED', 'OPTIONAL_ON_FAILURE')),
  maximum_bytes INTEGER NOT NULL CHECK (maximum_bytes > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (environment_id, ordinal),
  UNIQUE (environment_id, relative_path),
  UNIQUE (environment_id, path_digest)
);

CREATE TABLE motive.native_collection_effects (
  id UUID PRIMARY KEY,
  environment_id UUID NOT NULL REFERENCES motive.native_collection_plans(environment_id) ON DELETE RESTRICT,
  attempt_id UUID NOT NULL REFERENCES motive.attempts(id) ON DELETE RESTRICT,
  worker_command_effect_id UUID NOT NULL REFERENCES motive.orchestration_effects(id) ON DELETE RESTRICT,
  kind motive.native_collection_effect_kind NOT NULL,
  effect_key TEXT NOT NULL UNIQUE CHECK (char_length(effect_key) BETWEEN 1 AND 768),
  provider TEXT NOT NULL CHECK (provider = 'vercel'),
  external_id TEXT NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 512),
  session_id TEXT NOT NULL CHECK (char_length(session_id) BETWEEN 1 AND 512 AND session_id ~ '^[A-Za-z0-9_-]+$'),
  lease_epoch INTEGER NOT NULL CHECK (lease_epoch > 0),
  controller_generation BIGINT NOT NULL CHECK (controller_generation > 0),
  profile_digest TEXT NOT NULL CHECK (profile_digest ~ '^sha256:[a-f0-9]{64}$'),
  worker_runtime_digest TEXT NOT NULL CHECK (worker_runtime_digest ~ '^sha256:[a-f0-9]{64}$'),
  collector_runtime_digest TEXT NOT NULL CHECK (collector_runtime_digest ~ '^sha256:[a-f0-9]{64}$'),
  collection_plan_digest TEXT NOT NULL CHECK (collection_plan_digest ~ '^sha256:[a-f0-9]{64}$'),
  bootstrap_effect_id UUID REFERENCES motive.native_collection_effects(id) ON DELETE RESTRICT,
  path_ordinal INTEGER,
  relative_path TEXT,
  path_digest TEXT CHECK (path_digest IS NULL OR path_digest ~ '^sha256:[a-f0-9]{64}$'),
  maximum_bytes INTEGER CHECK (maximum_bytes IS NULL OR maximum_bytes > 0),
  workspace_identity TEXT CHECK (workspace_identity IS NULL OR workspace_identity ~ '^(0|[1-9][0-9]{0,19}):(0|[1-9][0-9]{0,19}):(0|[1-9][0-9]{0,19})$'),
  state motive.native_collection_effect_status NOT NULL DEFAULT 'INTENT_RECORDED',
  claimed_by TEXT CHECK (claimed_by IS NULL OR char_length(claimed_by) BETWEEN 1 AND 512),
  claimed_lease_epoch INTEGER CHECK (claimed_lease_epoch IS NULL OR claimed_lease_epoch > 0),
  claimed_at TIMESTAMPTZ,
  provider_command_id TEXT CHECK (provider_command_id IS NULL OR char_length(provider_command_id) BETWEEN 1 AND 512),
  exit_code INTEGER CHECK (exit_code IS NULL OR exit_code BETWEEN 0 AND 255),
  stdout_digest TEXT CHECK (stdout_digest IS NULL OR stdout_digest ~ '^sha256:[a-f0-9]{64}$'),
  stdout_bytes BIGINT CHECK (stdout_bytes IS NULL OR stdout_bytes >= 0),
  completed_at TIMESTAMPTZ,
  unknown_reason TEXT CHECK (unknown_reason IS NULL OR char_length(unknown_reason) BETWEEN 1 AND 512),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (environment_id, path_ordinal)
    REFERENCES motive.native_collection_plan_paths(environment_id, ordinal) ON DELETE RESTRICT,
  CHECK (claimed_lease_epoch IS NULL OR claimed_lease_epoch = lease_epoch),
  CHECK (kind <> 'BOOTSTRAP' OR stdout_bytes IS NULL OR stdout_bytes <= 256),
  CHECK (kind <> 'CAPTURE' OR stdout_bytes IS NULL OR stdout_bytes <= 257 + (4 * ((maximum_bytes + 2) / 3))),
  CHECK (
    (kind = 'BOOTSTRAP' AND bootstrap_effect_id IS NULL AND path_ordinal IS NULL
      AND relative_path IS NULL AND path_digest IS NULL AND maximum_bytes IS NULL AND workspace_identity IS NULL)
    OR
    (kind = 'CAPTURE' AND bootstrap_effect_id IS NOT NULL AND path_ordinal IS NOT NULL
      AND relative_path IS NOT NULL AND path_digest IS NOT NULL AND maximum_bytes IS NOT NULL AND workspace_identity IS NOT NULL)
  ),
  CHECK (
    (state = 'INTENT_RECORDED' AND claimed_by IS NULL AND claimed_lease_epoch IS NULL AND claimed_at IS NULL
      AND provider_command_id IS NULL AND exit_code IS NULL AND stdout_digest IS NULL AND stdout_bytes IS NULL
      AND completed_at IS NULL AND unknown_reason IS NULL)
    OR
    (state = 'CLAIMED' AND claimed_by IS NOT NULL AND claimed_lease_epoch IS NOT NULL AND claimed_at IS NOT NULL
      AND provider_command_id IS NULL AND exit_code IS NULL AND stdout_digest IS NULL AND stdout_bytes IS NULL
      AND completed_at IS NULL AND unknown_reason IS NULL)
    OR
    (state = 'START_RECORDED' AND claimed_by IS NOT NULL AND claimed_lease_epoch IS NOT NULL AND claimed_at IS NOT NULL
      AND provider_command_id IS NOT NULL AND exit_code IS NULL AND stdout_digest IS NULL AND stdout_bytes IS NULL
      AND completed_at IS NULL AND unknown_reason IS NULL)
    OR
    (state = 'COMPLETED' AND claimed_by IS NOT NULL AND claimed_lease_epoch IS NOT NULL AND claimed_at IS NOT NULL
      AND provider_command_id IS NOT NULL AND exit_code IS NOT NULL AND stdout_digest IS NOT NULL AND stdout_bytes IS NOT NULL
      AND completed_at IS NOT NULL AND unknown_reason IS NULL)
    OR
    (state = 'UNKNOWN' AND claimed_by IS NOT NULL AND claimed_lease_epoch IS NOT NULL AND claimed_at IS NOT NULL
      AND exit_code IS NULL AND stdout_digest IS NULL AND stdout_bytes IS NULL AND completed_at IS NULL AND unknown_reason IS NOT NULL)
  )
);

CREATE UNIQUE INDEX native_collection_bootstrap_once_idx
  ON motive.native_collection_effects(environment_id) WHERE kind = 'BOOTSTRAP';
CREATE UNIQUE INDEX native_collection_capture_once_idx
  ON motive.native_collection_effects(environment_id, path_ordinal) WHERE kind = 'CAPTURE';
CREATE UNIQUE INDEX native_collection_provider_command_identity_idx
  ON motive.native_collection_effects(environment_id, provider_command_id) WHERE provider_command_id IS NOT NULL;
CREATE INDEX native_collection_effect_reconcile_idx
  ON motive.native_collection_effects(state, created_at) WHERE state IN ('CLAIMED', 'START_RECORDED', 'UNKNOWN');

-- Older local-only binding callers intentionally leave this null. A binding
-- created through the new helper boundary always carries its completed effect.
ALTER TABLE motive.native_workspace_bindings
  ADD COLUMN bootstrap_effect_id UUID REFERENCES motive.native_collection_effects(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX native_workspace_binding_bootstrap_effect_idx
  ON motive.native_workspace_bindings(bootstrap_effect_id) WHERE bootstrap_effect_id IS NOT NULL;

CREATE OR REPLACE FUNCTION motive.guard_native_collection_plan()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, motive AS $$
DECLARE environment motive.orchestration_environments%ROWTYPE;
DECLARE profile_max_files NUMERIC;
DECLARE profile_max_file_bytes NUMERIC;
DECLARE profile_max_total_bytes NUMERIC;
BEGIN
  SELECT * INTO environment FROM motive.orchestration_environments
    WHERE id = NEW.environment_id FOR UPDATE;
  IF NOT FOUND
    OR COALESCE(environment.profile_snapshot #>> '{artifacts,maxFiles}', '') !~ '^[1-9][0-9]*$'
    OR COALESCE(environment.profile_snapshot #>> '{artifacts,maxFileBytes}', '') !~ '^[1-9][0-9]*$'
    OR COALESCE(environment.profile_snapshot #>> '{artifacts,maxTotalBytes}', '') !~ '^[1-9][0-9]*$' THEN
    RAISE EXCEPTION 'native collection plan requires a bounded protected worker profile' USING ERRCODE = '23514';
  END IF;
  profile_max_files := (environment.profile_snapshot #>> '{artifacts,maxFiles}')::NUMERIC;
  profile_max_file_bytes := (environment.profile_snapshot #>> '{artifacts,maxFileBytes}')::NUMERIC;
  profile_max_total_bytes := (environment.profile_snapshot #>> '{artifacts,maxTotalBytes}')::NUMERIC;
  IF NOT FOUND OR environment.kind <> 'WORKER' OR environment.state <> 'RESERVED'
    OR environment.provider IS NOT NULL OR environment.external_id IS NOT NULL OR environment.session_id IS NOT NULL
    OR (environment.attempt_id, environment.lease_epoch, environment.controller_generation, environment.profile_digest)
       IS DISTINCT FROM (NEW.attempt_id, NEW.lease_epoch, NEW.controller_generation, NEW.profile_digest)
    OR (environment.profile_snapshot #>> '{protectedRuntime,runtimeDigest}') IS DISTINCT FROM NEW.worker_runtime_digest
    OR NEW.maximum_files <> profile_max_files
    OR NEW.maximum_file_bytes > profile_max_file_bytes
    OR NEW.maximum_total_bytes > profile_max_total_bytes
    OR NOT EXISTS (SELECT 1 FROM motive.orchestration_effects AS effect
      WHERE effect.environment_id = NEW.environment_id AND effect.attempt_id = NEW.attempt_id
        AND effect.kind = 'CREATE' AND effect.state = 'INTENT_RECORDED')
  THEN
    RAISE EXCEPTION 'native collection plan requires an unclaimed reserved worker' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION motive.guard_native_collection_plan_path()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, motive AS $$
DECLARE plan motive.native_collection_plans%ROWTYPE;
BEGIN
  SELECT * INTO plan FROM motive.native_collection_plans WHERE environment_id = NEW.environment_id FOR UPDATE;
  IF NOT FOUND OR NEW.ordinal < 0 OR NEW.ordinal >= plan.path_count
    OR NEW.maximum_bytes > plan.maximum_file_bytes
    OR EXISTS (SELECT 1 FROM regexp_split_to_table(NEW.relative_path, '/') AS segment
      WHERE octet_length(segment) > 255)
    OR (SELECT COALESCE(sum(maximum_bytes), 0) FROM motive.native_collection_plan_paths
      WHERE environment_id = NEW.environment_id) + NEW.maximum_bytes > plan.maximum_total_bytes THEN
    RAISE EXCEPTION 'native collection path does not fit its frozen plan' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION motive.guard_native_collection_effect()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, motive AS $$
DECLARE plan motive.native_collection_plans%ROWTYPE;
DECLARE environment motive.orchestration_environments%ROWTYPE;
DECLARE path motive.native_collection_plan_paths%ROWTYPE;
BEGIN
  IF NEW.state IS DISTINCT FROM 'INTENT_RECORDED' THEN
    RAISE EXCEPTION 'native collection effect must begin as an intent' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO environment FROM motive.orchestration_environments WHERE id = NEW.environment_id FOR UPDATE;
  SELECT * INTO plan FROM motive.native_collection_plans WHERE environment_id = NEW.environment_id FOR UPDATE;
  IF NOT FOUND OR plan.environment_id IS NULL OR environment.kind <> 'WORKER' OR environment.state <> 'ACTIVE'
    OR environment.provider <> 'vercel'
    OR (environment.attempt_id, environment.lease_epoch, environment.controller_generation, environment.profile_digest,
        environment.profile_snapshot #>> '{protectedRuntime,runtimeDigest}')
       IS DISTINCT FROM
       (NEW.attempt_id, NEW.lease_epoch, NEW.controller_generation, NEW.profile_digest, NEW.worker_runtime_digest)
    OR (plan.attempt_id, plan.lease_epoch, plan.controller_generation, plan.profile_digest,
        plan.worker_runtime_digest, plan.collector_runtime_digest, plan.collection_plan_digest)
       IS DISTINCT FROM
       (NEW.attempt_id, NEW.lease_epoch, NEW.controller_generation, NEW.profile_digest,
        NEW.worker_runtime_digest, NEW.collector_runtime_digest, NEW.collection_plan_digest)
    OR (environment.provider, environment.external_id, environment.session_id)
       IS DISTINCT FROM (NEW.provider, NEW.external_id, NEW.session_id)
    OR (SELECT count(*) FROM motive.native_collection_plan_paths WHERE environment_id = NEW.environment_id) <> plan.path_count
    OR NOT EXISTS (SELECT 1 FROM motive.orchestration_effects AS worker_command
      WHERE worker_command.id = NEW.worker_command_effect_id
        AND worker_command.environment_id = NEW.environment_id AND worker_command.attempt_id = NEW.attempt_id
        AND worker_command.kind = 'COMMAND' AND worker_command.claimed_lease_epoch = NEW.lease_epoch
        AND worker_command.state IN ('CLAIMED', 'RESULT_RECORDED', 'UNKNOWN'))
  THEN
    RAISE EXCEPTION 'native collection effect requires the exact active worker command and frozen plan' USING ERRCODE = '23514';
  END IF;

  IF NEW.kind = 'BOOTSTRAP' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO path FROM motive.native_collection_plan_paths
    WHERE environment_id = NEW.environment_id AND ordinal = NEW.path_ordinal;
  IF NOT FOUND
    OR (path.relative_path, path.path_digest, path.maximum_bytes)
       IS DISTINCT FROM (NEW.relative_path, NEW.path_digest, NEW.maximum_bytes)
    OR NOT EXISTS (SELECT 1 FROM motive.native_workspace_bindings AS binding
      JOIN motive.native_collection_effects AS bootstrap ON bootstrap.id = binding.bootstrap_effect_id
      WHERE binding.environment_id = NEW.environment_id AND binding.bootstrap_effect_id = NEW.bootstrap_effect_id
        AND binding.attempt_id = NEW.attempt_id AND binding.lease_epoch = NEW.lease_epoch
        AND binding.controller_generation = NEW.controller_generation
        AND binding.profile_digest = NEW.profile_digest
        AND binding.worker_runtime_digest = NEW.worker_runtime_digest
        AND binding.collector_runtime_digest = NEW.collector_runtime_digest
        AND binding.workspace_identity = NEW.workspace_identity
        AND bootstrap.kind = 'BOOTSTRAP' AND bootstrap.state = 'COMPLETED'
        AND bootstrap.worker_command_effect_id = NEW.worker_command_effect_id)
  THEN
    RAISE EXCEPTION 'native capture requires the completed exact bootstrap binding and frozen path' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION motive.guard_native_collection_effect_identity()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, motive AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.environment_id IS DISTINCT FROM OLD.environment_id
    OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
    OR NEW.worker_command_effect_id IS DISTINCT FROM OLD.worker_command_effect_id
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.effect_key IS DISTINCT FROM OLD.effect_key
    OR NEW.provider IS DISTINCT FROM OLD.provider
    OR NEW.external_id IS DISTINCT FROM OLD.external_id
    OR NEW.session_id IS DISTINCT FROM OLD.session_id
    OR NEW.lease_epoch IS DISTINCT FROM OLD.lease_epoch
    OR NEW.controller_generation IS DISTINCT FROM OLD.controller_generation
    OR NEW.profile_digest IS DISTINCT FROM OLD.profile_digest
    OR NEW.worker_runtime_digest IS DISTINCT FROM OLD.worker_runtime_digest
    OR NEW.collector_runtime_digest IS DISTINCT FROM OLD.collector_runtime_digest
    OR NEW.collection_plan_digest IS DISTINCT FROM OLD.collection_plan_digest
    OR NEW.bootstrap_effect_id IS DISTINCT FROM OLD.bootstrap_effect_id
    OR NEW.path_ordinal IS DISTINCT FROM OLD.path_ordinal
    OR NEW.relative_path IS DISTINCT FROM OLD.relative_path
    OR NEW.path_digest IS DISTINCT FROM OLD.path_digest
    OR NEW.maximum_bytes IS DISTINCT FROM OLD.maximum_bytes
    OR NEW.workspace_identity IS DISTINCT FROM OLD.workspace_identity
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'native collection effect identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.claimed_by IS NOT NULL AND (
    NEW.claimed_by IS DISTINCT FROM OLD.claimed_by
    OR NEW.claimed_lease_epoch IS DISTINCT FROM OLD.claimed_lease_epoch
    OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
  ) THEN
    RAISE EXCEPTION 'native collection effect claim is write-once' USING ERRCODE = '55000';
  END IF;
  IF OLD.provider_command_id IS NOT NULL AND NEW.provider_command_id IS DISTINCT FROM OLD.provider_command_id THEN
    RAISE EXCEPTION 'native collection provider command is write-once' USING ERRCODE = '55000';
  END IF;
  IF OLD.completed_at IS NOT NULL AND (
    NEW.completed_at IS DISTINCT FROM OLD.completed_at
    OR NEW.exit_code IS DISTINCT FROM OLD.exit_code
    OR NEW.stdout_digest IS DISTINCT FROM OLD.stdout_digest
    OR NEW.stdout_bytes IS DISTINCT FROM OLD.stdout_bytes
  ) THEN
    RAISE EXCEPTION 'native collection completion is write-once' USING ERRCODE = '55000';
  END IF;
  IF (OLD.state = 'INTENT_RECORDED' AND NEW.state NOT IN ('INTENT_RECORDED', 'CLAIMED'))
    OR (OLD.state = 'CLAIMED' AND NEW.state NOT IN ('CLAIMED', 'START_RECORDED', 'UNKNOWN'))
    OR (OLD.state = 'START_RECORDED' AND NEW.state NOT IN ('START_RECORDED', 'COMPLETED', 'UNKNOWN'))
    OR (OLD.state IN ('COMPLETED', 'UNKNOWN') AND NEW.state IS DISTINCT FROM OLD.state) THEN
    RAISE EXCEPTION 'native collection effect state transition is invalid' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'UNKNOWN' AND (
    NEW.provider_command_id IS DISTINCT FROM OLD.provider_command_id
    OR NEW.unknown_reason IS DISTINCT FROM OLD.unknown_reason
    OR NEW.exit_code IS DISTINCT FROM OLD.exit_code
    OR NEW.stdout_digest IS DISTINCT FROM OLD.stdout_digest
    OR NEW.stdout_bytes IS DISTINCT FROM OLD.stdout_bytes
    OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
  ) THEN
    RAISE EXCEPTION 'native collection unknown outcome is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER native_collection_plan_guard BEFORE INSERT ON motive.native_collection_plans
  FOR EACH ROW EXECUTE FUNCTION motive.guard_native_collection_plan();
CREATE TRIGGER native_collection_plan_immutable BEFORE UPDATE OR DELETE ON motive.native_collection_plans
  FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();
CREATE TRIGGER native_collection_plan_path_guard BEFORE INSERT ON motive.native_collection_plan_paths
  FOR EACH ROW EXECUTE FUNCTION motive.guard_native_collection_plan_path();
CREATE TRIGGER native_collection_plan_path_immutable BEFORE UPDATE OR DELETE ON motive.native_collection_plan_paths
  FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();
CREATE TRIGGER native_collection_effect_guard BEFORE INSERT ON motive.native_collection_effects
  FOR EACH ROW EXECUTE FUNCTION motive.guard_native_collection_effect();
CREATE TRIGGER native_collection_effect_identity_immutable BEFORE UPDATE ON motive.native_collection_effects
  FOR EACH ROW EXECUTE FUNCTION motive.guard_native_collection_effect_identity();
CREATE TRIGGER native_collection_effect_delete_immutable BEFORE DELETE ON motive.native_collection_effects
  FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();

-- Preserve the legacy local-only binding API, but a durable helper binding
-- must reference the exact completed bootstrap command from this migration.
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
    OR (
      NEW.bootstrap_effect_id IS NULL AND NOT EXISTS (SELECT 1 FROM motive.orchestration_effects
        WHERE environment_id = NEW.environment_id AND attempt_id = NEW.attempt_id
          AND claimed_lease_epoch = NEW.lease_epoch AND kind = 'COMMAND'
          AND state IN ('CLAIMED', 'UNKNOWN', 'RESULT_RECORDED'))
    )
    OR (
      NEW.bootstrap_effect_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM motive.native_collection_effects AS bootstrap
        WHERE bootstrap.id = NEW.bootstrap_effect_id AND bootstrap.environment_id = NEW.environment_id
          AND bootstrap.attempt_id = NEW.attempt_id AND bootstrap.kind = 'BOOTSTRAP'
          AND bootstrap.state = 'COMPLETED' AND bootstrap.lease_epoch = NEW.lease_epoch
          AND bootstrap.controller_generation = NEW.controller_generation
          AND bootstrap.profile_digest = NEW.profile_digest
          AND bootstrap.worker_runtime_digest = NEW.worker_runtime_digest
          AND bootstrap.collector_runtime_digest = NEW.collector_runtime_digest
          AND bootstrap.exit_code = 0
          AND bootstrap.stdout_bytes = octet_length(convert_to(
            'MOTIVE_COLLECTOR_BOOTSTRAP_V1' || E'\n' || NEW.workspace_identity || E'\n', 'UTF8'))
          AND bootstrap.stdout_digest = ('sha256:' || encode(sha256(convert_to(
            'MOTIVE_COLLECTOR_BOOTSTRAP_V1' || E'\n' || NEW.workspace_identity || E'\n', 'UTF8')), 'hex')))
    )
  THEN
    RAISE EXCEPTION 'native workspace binding requires the exact launched protected worker and completed bootstrap' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON motive.native_collection_plans FROM PUBLIC;
REVOKE ALL ON motive.native_collection_plan_paths FROM PUBLIC;
REVOKE ALL ON motive.native_collection_effects FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_native_collection_plan() FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_native_collection_plan_path() FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_native_collection_effect() FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_native_collection_effect_identity() FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_native_workspace_binding() FROM PUBLIC;
