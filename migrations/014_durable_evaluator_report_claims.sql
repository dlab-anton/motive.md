-- Freeze the reviewed evaluator launch material and fence the one immutable
-- report object identity before its bytes are written outside PostgreSQL.

CREATE TABLE motive.evaluator_launch_plans (
  environment_id UUID PRIMARY KEY,
  attempt_id UUID NOT NULL,
  environment_lease_epoch INTEGER NOT NULL CHECK (environment_lease_epoch > 0),
  environment_controller_generation BIGINT NOT NULL CHECK (environment_controller_generation > 0),
  evaluator_profile_digest TEXT NOT NULL CHECK (evaluator_profile_digest ~ '^sha256:[a-f0-9]{64}$'),
  launch_plan_digest TEXT NOT NULL CHECK (launch_plan_digest ~ '^sha256:[a-f0-9]{64}$'),
  launch_plan JSONB NOT NULL CHECK (jsonb_typeof(launch_plan) = 'object'),
  frozen_by TEXT NOT NULL CHECK (char_length(frozen_by) BETWEEN 1 AND 512),
  frozen_lease_epoch INTEGER NOT NULL CHECK (frozen_lease_epoch > 0),
  frozen_controller_generation BIGINT NOT NULL CHECK (frozen_controller_generation > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (environment_id, attempt_id)
    REFERENCES motive.orchestration_environments(id, attempt_id) ON DELETE RESTRICT,
  CHECK ((launch_plan ->> 'evaluatorProfileDigest') IS NOT DISTINCT FROM evaluator_profile_digest)
);

CREATE TABLE motive.evaluator_report_claims (
  environment_id UUID PRIMARY KEY REFERENCES motive.evaluator_launch_plans(environment_id) ON DELETE RESTRICT,
  attempt_id UUID NOT NULL,
  report_digest TEXT NOT NULL CHECK (report_digest ~ '^sha256:[a-f0-9]{64}$'),
  provider_command_id TEXT CHECK (provider_command_id IS NULL OR char_length(provider_command_id) BETWEEN 1 AND 512),
  evaluator_provider TEXT NOT NULL CHECK (char_length(evaluator_provider) BETWEEN 1 AND 128),
  evaluator_external_id TEXT NOT NULL CHECK (char_length(evaluator_external_id) BETWEEN 1 AND 512),
  evaluator_session_id TEXT NOT NULL CHECK (char_length(evaluator_session_id) BETWEEN 1 AND 512),
  environment_lease_epoch INTEGER NOT NULL CHECK (environment_lease_epoch > 0),
  environment_controller_generation BIGINT NOT NULL CHECK (environment_controller_generation > 0),
  evaluator_profile_digest TEXT NOT NULL CHECK (evaluator_profile_digest ~ '^sha256:[a-f0-9]{64}$'),
  claimed_by TEXT NOT NULL CHECK (char_length(claimed_by) BETWEEN 1 AND 512),
  claimed_lease_epoch INTEGER NOT NULL CHECK (claimed_lease_epoch > 0),
  claimed_controller_generation BIGINT NOT NULL CHECK (claimed_controller_generation > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (environment_id, attempt_id)
    REFERENCES motive.orchestration_environments(id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (environment_id, provider_command_id)
    REFERENCES motive.orchestration_commands(environment_id, provider_command_id) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION motive.guard_evaluator_launch_plan()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, motive AS $$
DECLARE environment motive.orchestration_environments%ROWTYPE;
DECLARE current_lease motive.orchestration_leases%ROWTYPE;
BEGIN
  SELECT * INTO environment FROM motive.orchestration_environments
    WHERE id = NEW.environment_id FOR KEY SHARE;
  SELECT * INTO current_lease FROM motive.orchestration_leases
    WHERE attempt_id = NEW.attempt_id FOR KEY SHARE;
  IF NOT FOUND OR environment.id IS NULL OR current_lease.attempt_id IS NULL
    OR environment.kind <> 'EVALUATOR' OR environment.attempt_id IS NULL
    OR (environment.attempt_id, environment.lease_epoch, environment.controller_generation,
        environment.profile_digest, environment.launch_plan_digest)
       IS DISTINCT FROM
       (NEW.attempt_id, NEW.environment_lease_epoch, NEW.environment_controller_generation,
        NEW.evaluator_profile_digest, NEW.launch_plan_digest)
    OR (current_lease.owner_id, current_lease.epoch, current_lease.controller_generation)
       IS DISTINCT FROM (NEW.frozen_by, NEW.frozen_lease_epoch, NEW.frozen_controller_generation)
    OR current_lease.expires_at <= clock_timestamp()
  THEN
    RAISE EXCEPTION 'evaluator launch plan requires the exact tracked evaluator and current lease' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION motive.guard_evaluator_report_claim()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, motive AS $$
DECLARE environment motive.orchestration_environments%ROWTYPE;
DECLARE current_lease motive.orchestration_leases%ROWTYPE;
BEGIN
  SELECT * INTO environment FROM motive.orchestration_environments
    WHERE id = NEW.environment_id FOR KEY SHARE;
  SELECT * INTO current_lease FROM motive.orchestration_leases
    WHERE attempt_id = NEW.attempt_id FOR KEY SHARE;
  IF NOT FOUND OR environment.id IS NULL OR current_lease.attempt_id IS NULL
    OR environment.kind <> 'EVALUATOR' OR environment.attempt_id IS NULL
    OR environment.provider IS NULL OR environment.external_id IS NULL OR environment.session_id IS NULL
    OR (environment.attempt_id, environment.provider, environment.external_id, environment.session_id,
        environment.lease_epoch, environment.controller_generation, environment.profile_digest)
       IS DISTINCT FROM
       (NEW.attempt_id, NEW.evaluator_provider, NEW.evaluator_external_id, NEW.evaluator_session_id,
        NEW.environment_lease_epoch, NEW.environment_controller_generation, NEW.evaluator_profile_digest)
    OR (current_lease.owner_id, current_lease.epoch, current_lease.controller_generation)
       IS DISTINCT FROM (NEW.claimed_by, NEW.claimed_lease_epoch, NEW.claimed_controller_generation)
    OR current_lease.expires_at <= clock_timestamp()
    OR (NEW.provider_command_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM motive.orchestration_commands AS command
      JOIN motive.orchestration_effects AS effect ON effect.id = command.effect_id
      WHERE command.environment_id = NEW.environment_id
        AND command.provider_command_id = NEW.provider_command_id
        AND effect.environment_id = NEW.environment_id
        AND effect.kind = 'COMMAND' AND effect.state = 'RESULT_RECORDED'
    ))
  THEN
    RAISE EXCEPTION 'evaluator report claim requires the exact evaluator, current lease and persisted command' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER evaluator_launch_plan_guard BEFORE INSERT ON motive.evaluator_launch_plans
  FOR EACH ROW EXECUTE FUNCTION motive.guard_evaluator_launch_plan();
CREATE TRIGGER evaluator_launch_plan_immutable BEFORE UPDATE OR DELETE ON motive.evaluator_launch_plans
  FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();
CREATE TRIGGER evaluator_report_claim_guard BEFORE INSERT ON motive.evaluator_report_claims
  FOR EACH ROW EXECUTE FUNCTION motive.guard_evaluator_report_claim();
CREATE TRIGGER evaluator_report_claim_immutable BEFORE UPDATE OR DELETE ON motive.evaluator_report_claims
  FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();

REVOKE ALL ON motive.evaluator_launch_plans FROM PUBLIC;
REVOKE ALL ON motive.evaluator_report_claims FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_evaluator_launch_plan() FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_evaluator_report_claim() FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'motive_control_reader') THEN
    EXECUTE 'REVOKE ALL ON motive.evaluator_launch_plans FROM motive_control_reader';
    EXECUTE 'REVOKE ALL ON motive.evaluator_report_claims FROM motive_control_reader';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_evaluator_launch_plan() FROM motive_control_reader';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_evaluator_report_claim() FROM motive_control_reader';
  END IF;
END $$;
