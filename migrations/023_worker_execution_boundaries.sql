-- Add an explicit execution boundary to frozen collection plans. Historical
-- native plans retain their protected-runtime digest and canonical plan hash;
-- provider-session plans make no native filesystem or helper claim.

CREATE TYPE motive.worker_execution_boundary_kind AS ENUM (
  'PROTECTED_RUNTIME',
  'PROVIDER_UNTRUSTED_CIRCLE_DATA'
);

ALTER TABLE motive.native_collection_plans
  ADD COLUMN execution_boundary_kind motive.worker_execution_boundary_kind,
  ADD COLUMN execution_boundary_digest TEXT;

-- Application rows are immutable. Remove only the immutable guard inside this
-- migration transaction for the one additive backfill, then restore it.
DROP TRIGGER native_collection_plan_immutable ON motive.native_collection_plans;
UPDATE motive.native_collection_plans
SET execution_boundary_kind = 'PROTECTED_RUNTIME',
    execution_boundary_digest = worker_runtime_digest;
CREATE TRIGGER native_collection_plan_immutable BEFORE UPDATE OR DELETE ON motive.native_collection_plans
  FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();

ALTER TABLE motive.native_collection_plans
  ALTER COLUMN execution_boundary_kind SET NOT NULL,
  ALTER COLUMN execution_boundary_digest SET NOT NULL,
  ALTER COLUMN worker_runtime_digest DROP NOT NULL,
  DROP CONSTRAINT native_collection_plans_worker_runtime_digest_check,
  DROP CONSTRAINT native_collection_plans_check2,
  ADD CONSTRAINT native_collection_plans_execution_boundary_digest_check
    CHECK (execution_boundary_digest ~ '^sha256:[a-f0-9]{64}$'),
  ADD CONSTRAINT native_collection_plans_worker_runtime_boundary_check CHECK (
    (execution_boundary_kind = 'PROTECTED_RUNTIME'
      AND worker_runtime_digest IS NOT NULL
      AND worker_runtime_digest = execution_boundary_digest
      AND worker_runtime_digest ~ '^sha256:[a-f0-9]{64}$')
    OR
    (execution_boundary_kind = 'PROVIDER_UNTRUSTED_CIRCLE_DATA'
      AND worker_runtime_digest IS NULL)
  ),
  ADD CONSTRAINT native_collection_plans_helper_budget_check CHECK (
    (execution_boundary_kind = 'PROTECTED_RUNTIME' AND maximum_helper_commands = path_count + 1)
    OR
    (execution_boundary_kind = 'PROVIDER_UNTRUSTED_CIRCLE_DATA' AND maximum_helper_commands = 0)
  );

CREATE OR REPLACE FUNCTION motive.guard_native_collection_plan()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, motive AS $$
DECLARE environment motive.orchestration_environments%ROWTYPE;
DECLARE profile_max_files NUMERIC;
DECLARE profile_max_file_bytes NUMERIC;
DECLARE profile_max_total_bytes NUMERIC;
DECLARE boundary_matches BOOLEAN;
BEGIN
  SELECT * INTO environment FROM motive.orchestration_environments
    WHERE id = NEW.environment_id FOR UPDATE;
  IF NOT FOUND
    OR COALESCE(environment.profile_snapshot #>> '{artifacts,maxFiles}', '') !~ '^[1-9][0-9]*$'
    OR COALESCE(environment.profile_snapshot #>> '{artifacts,maxFileBytes}', '') !~ '^[1-9][0-9]*$'
    OR COALESCE(environment.profile_snapshot #>> '{artifacts,maxTotalBytes}', '') !~ '^[1-9][0-9]*$' THEN
    RAISE EXCEPTION 'collection plan requires a bounded worker profile' USING ERRCODE = '23514';
  END IF;
  profile_max_files := (environment.profile_snapshot #>> '{artifacts,maxFiles}')::NUMERIC;
  profile_max_file_bytes := (environment.profile_snapshot #>> '{artifacts,maxFileBytes}')::NUMERIC;
  profile_max_total_bytes := (environment.profile_snapshot #>> '{artifacts,maxTotalBytes}')::NUMERIC;

  boundary_matches :=
    (NEW.execution_boundary_kind = 'PROTECTED_RUNTIME'
      AND NOT (environment.profile_snapshot ? 'providerUntrustedDataRuntime')
      AND (environment.profile_snapshot #>> '{protectedRuntime,runtimeDigest}') IS NOT DISTINCT FROM NEW.execution_boundary_digest
      AND NEW.worker_runtime_digest IS NOT DISTINCT FROM NEW.execution_boundary_digest
      AND NEW.maximum_helper_commands = NEW.path_count + 1)
    OR
    (NEW.execution_boundary_kind = 'PROVIDER_UNTRUSTED_CIRCLE_DATA'
      AND NOT (environment.profile_snapshot ? 'protectedRuntime')
      AND (environment.profile_snapshot -> 'providerUntrustedDataRuntime') IS NOT DISTINCT FROM
        '{"filesystemClaim":"none","format":"motive.circle-provider-untrusted-runtime/0.1","outputTrust":"untrusted","provider":"vercel","purpose":"circle-packing-data","runtimeDigest":"sha256:c8847f6e9c2feeefa505d8fe677d244477729451cd25b24915747e1eb7b2919e"}'::jsonb
      AND (environment.profile_snapshot #>> '{providerUntrustedDataRuntime,runtimeDigest}') IS NOT DISTINCT FROM NEW.execution_boundary_digest
      AND NEW.execution_boundary_digest = 'sha256:c8847f6e9c2feeefa505d8fe677d244477729451cd25b24915747e1eb7b2919e'
      AND NEW.worker_runtime_digest IS NULL
      AND NEW.maximum_helper_commands = 0
      AND NEW.maximum_file_bytes = 32768
      AND (
        (NEW.collector_runtime_digest = 'sha256:7c61c00cc179a9e31b54e76e6164ae96edf53551e4467207e9d3ec68a312655a'
          AND NEW.maximum_total_bytes = 32768 AND NEW.path_count = 1 AND NEW.maximum_files = 1)
        OR
        (NEW.collector_runtime_digest = 'sha256:94752a6e677741a93bebfe13fe97d8525bfbe1d13582e55d39d03837f9300415'
          AND NEW.maximum_total_bytes = 49152 AND NEW.path_count = 2 AND NEW.maximum_files = 2)
      )
    );

  IF environment.kind <> 'WORKER' OR environment.state <> 'RESERVED'
    OR environment.provider IS NOT NULL OR environment.external_id IS NOT NULL OR environment.session_id IS NOT NULL
    OR (environment.attempt_id, environment.lease_epoch, environment.controller_generation, environment.profile_digest)
       IS DISTINCT FROM (NEW.attempt_id, NEW.lease_epoch, NEW.controller_generation, NEW.profile_digest)
    OR boundary_matches IS DISTINCT FROM TRUE
    OR NEW.maximum_files <> profile_max_files
    OR NEW.maximum_file_bytes > profile_max_file_bytes
    OR NEW.maximum_total_bytes > profile_max_total_bytes
    OR NOT EXISTS (SELECT 1 FROM motive.orchestration_effects AS effect
      WHERE effect.environment_id = NEW.environment_id AND effect.attempt_id = NEW.attempt_id
        AND effect.kind = 'CREATE' AND effect.state = 'INTENT_RECORDED')
  THEN
    RAISE EXCEPTION 'collection plan requires the exact unclaimed worker boundary' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION motive.guard_native_collection_plan_path()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, motive AS $$
DECLARE plan motive.native_collection_plans%ROWTYPE;
DECLARE exact_provider_path BOOLEAN;
BEGIN
  SELECT * INTO plan FROM motive.native_collection_plans WHERE environment_id = NEW.environment_id FOR UPDATE;
  exact_provider_path := CASE
    WHEN plan.execution_boundary_kind = 'PROVIDER_UNTRUSTED_CIRCLE_DATA'
      AND NEW.ordinal = 0 THEN
        NEW.relative_path = 'candidate.json' AND NEW.media_type = 'application/json'
        AND NEW.availability = 'REQUIRED' AND NEW.maximum_bytes = 32768
    WHEN plan.execution_boundary_kind = 'PROVIDER_UNTRUSTED_CIRCLE_DATA'
      AND NEW.ordinal = 1
      AND plan.collector_runtime_digest = 'sha256:94752a6e677741a93bebfe13fe97d8525bfbe1d13582e55d39d03837f9300415' THEN
        NEW.relative_path = 'investigation.json' AND NEW.media_type = 'application/json'
        AND NEW.availability = 'OPTIONAL_ON_FAILURE' AND NEW.maximum_bytes = 16384
    WHEN plan.execution_boundary_kind = 'PROTECTED_RUNTIME' THEN TRUE
    ELSE FALSE
  END;
  IF NOT FOUND OR NEW.ordinal < 0 OR NEW.ordinal >= plan.path_count
    OR exact_provider_path IS DISTINCT FROM TRUE
    OR NEW.maximum_bytes > plan.maximum_file_bytes
    OR EXISTS (SELECT 1 FROM regexp_split_to_table(NEW.relative_path, '/') AS segment
      WHERE octet_length(segment) > 255)
    OR (SELECT COALESCE(sum(maximum_bytes), 0) FROM motive.native_collection_plan_paths
      WHERE environment_id = NEW.environment_id) + NEW.maximum_bytes > plan.maximum_total_bytes THEN
    RAISE EXCEPTION 'collection path does not fit its frozen boundary plan' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- Native effects remain native-only. Provider-session collection has no
-- bootstrap, capture helper, or protected workspace identity.
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
  IF NOT FOUND OR plan.environment_id IS NULL OR plan.execution_boundary_kind <> 'PROTECTED_RUNTIME'
    OR plan.worker_runtime_digest IS NULL OR environment.kind <> 'WORKER' OR environment.state <> 'ACTIVE'
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
    RAISE EXCEPTION 'native collection effect requires the exact protected worker command and plan' USING ERRCODE = '23514';
  END IF;

  IF NEW.kind = 'BOOTSTRAP' THEN RETURN NEW; END IF;
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

-- Keep both legacy and durable workspace bindings protected-runtime-only.
CREATE OR REPLACE FUNCTION motive.guard_native_workspace_binding()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, motive AS $$
DECLARE environment motive.orchestration_environments%ROWTYPE;
BEGIN
  SELECT * INTO environment FROM motive.orchestration_environments WHERE id = NEW.environment_id FOR UPDATE;
  IF NOT FOUND OR environment.kind <> 'WORKER'
    OR environment.state IN ('TERMINATED', 'ABANDONED')
    OR environment.profile_snapshot ? 'providerUntrustedDataRuntime'
    OR NOT (environment.profile_snapshot ? 'protectedRuntime')
    OR (environment.attempt_id, environment.provider, environment.external_id,
        environment.session_id, environment.lease_epoch, environment.controller_generation,
        environment.profile_digest)
       IS DISTINCT FROM
       (NEW.attempt_id, NEW.provider, NEW.external_id, NEW.session_id,
        NEW.lease_epoch, NEW.controller_generation, NEW.profile_digest)
    OR (environment.profile_snapshot #>> '{protectedRuntime,runtimeDigest}') IS DISTINCT FROM NEW.worker_runtime_digest
    OR (NEW.bootstrap_effect_id IS NULL AND NOT EXISTS (SELECT 1 FROM motive.orchestration_effects
      WHERE environment_id = NEW.environment_id AND attempt_id = NEW.attempt_id
        AND claimed_lease_epoch = NEW.lease_epoch AND kind = 'COMMAND'
        AND state IN ('CLAIMED', 'UNKNOWN', 'RESULT_RECORDED')))
    OR (NEW.bootstrap_effect_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM motive.native_collection_effects AS bootstrap
      JOIN motive.native_collection_plans AS plan ON plan.environment_id = bootstrap.environment_id
      WHERE bootstrap.id = NEW.bootstrap_effect_id AND bootstrap.environment_id = NEW.environment_id
        AND plan.execution_boundary_kind = 'PROTECTED_RUNTIME'
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
          'MOTIVE_COLLECTOR_BOOTSTRAP_V1' || E'\n' || NEW.workspace_identity || E'\n', 'UTF8')), 'hex'))))
  THEN
    RAISE EXCEPTION 'native workspace binding requires the exact protected worker boundary' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- Provider-session workers may cross the CREATE effect boundary only after
-- their complete immutable data plan exists. This covers direct SQL callers
-- as well as the application store.
CREATE OR REPLACE FUNCTION motive.guard_orchestration_effect_identity()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, motive AS $$
DECLARE environment motive.orchestration_environments%ROWTYPE;
DECLARE plan motive.native_collection_plans%ROWTYPE;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.environment_id IS DISTINCT FROM OLD.environment_id
    OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.effect_key IS DISTINCT FROM OLD.effect_key
    OR NEW.command_digest IS DISTINCT FROM OLD.command_digest
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'orchestration effect identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.claimed_by IS NOT NULL AND (
    NEW.claimed_by IS DISTINCT FROM OLD.claimed_by
    OR NEW.claimed_lease_epoch IS DISTINCT FROM OLD.claimed_lease_epoch
    OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
  ) THEN
    RAISE EXCEPTION 'orchestration effect claim is write-once' USING ERRCODE = '55000';
  END IF;
  IF OLD.result_recorded_at IS NOT NULL AND NEW.result_recorded_at IS DISTINCT FROM OLD.result_recorded_at THEN
    RAISE EXCEPTION 'orchestration effect result is write-once' USING ERRCODE = '55000';
  END IF;

  IF OLD.kind = 'CREATE' AND OLD.state = 'INTENT_RECORDED' AND NEW.state = 'CLAIMED' THEN
    SELECT * INTO environment FROM motive.orchestration_environments WHERE id = NEW.environment_id FOR UPDATE;
    IF environment.profile_snapshot ? 'providerUntrustedDataRuntime' THEN
      SELECT * INTO plan FROM motive.native_collection_plans WHERE environment_id = NEW.environment_id FOR UPDATE;
      IF NOT FOUND OR plan.execution_boundary_kind <> 'PROVIDER_UNTRUSTED_CIRCLE_DATA'
        OR (SELECT count(*) FROM motive.native_collection_plan_paths
              WHERE environment_id = NEW.environment_id) <> plan.path_count
        OR NOT EXISTS (SELECT 1 FROM motive.native_collection_plan_paths
              WHERE environment_id = NEW.environment_id AND ordinal = 0
                AND relative_path = 'candidate.json' AND media_type = 'application/json'
                AND availability = 'REQUIRED' AND maximum_bytes = 32768)
        OR (plan.path_count = 2 AND NOT EXISTS (SELECT 1 FROM motive.native_collection_plan_paths
              WHERE environment_id = NEW.environment_id AND ordinal = 1
                AND relative_path = 'investigation.json' AND media_type = 'application/json'
                AND availability = 'OPTIONAL_ON_FAILURE' AND maximum_bytes = 16384))
      THEN
        RAISE EXCEPTION 'provider worker create requires its complete exact frozen data plan' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION motive.guard_native_collection_plan() FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_native_collection_plan_path() FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_native_collection_effect() FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_native_workspace_binding() FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_orchestration_effect_identity() FROM PUBLIC;
