-- P2 durable orchestration.  This migration deliberately keeps infrastructure
-- authorization separate from inference request_operations and reservations.
-- An environment's physical lifecycle is authoritative for the two-machine
-- policy; Trigger queue slots and lease expiry do not free capacity.

CREATE TYPE motive.infrastructure_authorization_status AS ENUM ('ACTIVE', 'FROZEN', 'CLOSED');
CREATE TYPE motive.orchestration_environment_kind AS ENUM ('WORKER', 'EVALUATOR');
CREATE TYPE motive.orchestration_environment_status AS ENUM (
  'RESERVED', 'PROVISIONING', 'ACTIVE', 'STOP_REQUESTED', 'UNKNOWN', 'ORPHANED', 'ABANDONED', 'TERMINATED'
);
CREATE TYPE motive.orchestration_effect_kind AS ENUM ('CREATE', 'COMMAND', 'STOP');
CREATE TYPE motive.orchestration_effect_status AS ENUM ('INTENT_RECORDED', 'CLAIMED', 'RESULT_RECORDED', 'UNKNOWN', 'ABANDONED');
CREATE TYPE motive.orchestration_artifact_seal_status AS ENUM ('SEALED', 'FAILED');

-- This is an infrastructure-only finite authorization.  source_account_id
-- supplies an established controller identity; its amount is not allocated
-- from an inference grant and is never represented as a request operation.
CREATE TABLE motive.infrastructure_authorizations (
  id UUID PRIMARY KEY,
  source_account_id UUID NOT NULL REFERENCES motive.funding_sources(id) ON DELETE RESTRICT,
  source_account_ref TEXT NOT NULL CHECK (char_length(source_account_ref) BETWEEN 1 AND 512),
  actor_id TEXT NOT NULL CHECK (char_length(actor_id) BETWEEN 1 AND 512),
  currency CHAR(3) NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  limit_usd NUMERIC(30,12) NOT NULL CHECK (limit_usd > 0),
  held_usd NUMERIC(30,12) NOT NULL DEFAULT 0 CHECK (held_usd >= 0),
  consumed_usd NUMERIC(30,12) NOT NULL DEFAULT 0 CHECK (consumed_usd >= 0),
  status motive.infrastructure_authorization_status NOT NULL DEFAULT 'ACTIVE',
  expires_at TIMESTAMPTZ NOT NULL,
  frozen_at TIMESTAMPTZ,
  freeze_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at > created_at),
  UNIQUE (id, source_account_id)
);
CREATE INDEX infrastructure_authorizations_source_idx
  ON motive.infrastructure_authorizations (source_account_id, status, expires_at);

-- The lease epoch is mirrored into attempts.  The row exists independently of
-- Trigger, so a retry can never turn an old queue run into the current owner.
CREATE TABLE motive.orchestration_leases (
  attempt_id UUID PRIMARY KEY REFERENCES motive.attempts(id) ON DELETE RESTRICT,
  owner_id TEXT NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 512),
  epoch INTEGER NOT NULL CHECK (epoch > 0),
  controller_generation BIGINT NOT NULL CHECK (controller_generation > 0),
  expires_at TIMESTAMPTZ NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX orchestration_leases_expiry_idx ON motive.orchestration_leases (expires_at, attempt_id);

-- This counter is a physical lifecycle admission lock, not a queue limit.
-- Reconciliation may push occupied_count above two when it discovers an
-- orphan; only new reservations require occupied_count < maximum_environments.
CREATE TABLE motive.orchestration_capacity (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  maximum_environments INTEGER NOT NULL DEFAULT 2 CHECK (maximum_environments = 2),
  occupied_count INTEGER NOT NULL DEFAULT 0 CHECK (occupied_count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO motive.orchestration_capacity (singleton) VALUES (TRUE)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE motive.orchestration_environments (
  id UUID PRIMARY KEY,
  attempt_id UUID REFERENCES motive.attempts(id) ON DELETE RESTRICT,
  source_id UUID REFERENCES motive.funding_sources(id) ON DELETE RESTRICT,
  grant_id UUID REFERENCES motive.grants(id) ON DELETE RESTRICT,
  kind motive.orchestration_environment_kind NOT NULL,
  lease_epoch INTEGER CHECK (lease_epoch IS NULL OR lease_epoch > 0),
  controller_generation BIGINT CHECK (controller_generation IS NULL OR controller_generation > 0),
  state motive.orchestration_environment_status NOT NULL,
  profile_digest TEXT CHECK (profile_digest IS NULL OR profile_digest ~ '^sha256:[a-f0-9]{64}$'),
  profile_snapshot JSONB,
  launch_plan_digest TEXT CHECK (launch_plan_digest IS NULL OR launch_plan_digest ~ '^sha256:[a-f0-9]{64}$'),
  infrastructure_authorization_id UUID REFERENCES motive.infrastructure_authorizations(id) ON DELETE RESTRICT,
  maximum_cost_usd NUMERIC(30,12) CHECK (maximum_cost_usd IS NULL OR maximum_cost_usd > 0),
  held_cost_usd NUMERIC(30,12) CHECK (held_cost_usd IS NULL OR held_cost_usd >= 0),
  consumed_cost_usd NUMERIC(30,12) CHECK (consumed_cost_usd IS NULL OR consumed_cost_usd >= 0),
  provider TEXT CHECK (provider IS NULL OR char_length(provider) BETWEEN 1 AND 128),
  external_id TEXT CHECK (external_id IS NULL OR char_length(external_id) BETWEEN 1 AND 512),
  session_id TEXT CHECK (session_id IS NULL OR char_length(session_id) BETWEEN 1 AND 512),
  provider_status TEXT CHECK (provider_status IS NULL OR char_length(provider_status) BETWEEN 1 AND 256),
  provider_expires_at TIMESTAMPTZ,
  last_observed_at TIMESTAMPTZ,
  terminated_at TIMESTAMPTZ,
  orphan_reason TEXT,
  orphan_identity_digest TEXT CHECK (orphan_identity_digest IS NULL OR orphan_identity_digest ~ '^sha256:[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (attempt_id IS NOT NULL AND source_id IS NOT NULL AND grant_id IS NOT NULL AND lease_epoch IS NOT NULL
      AND controller_generation IS NOT NULL AND profile_digest IS NOT NULL AND profile_snapshot IS NOT NULL
      AND jsonb_typeof(profile_snapshot) = 'object' AND launch_plan_digest IS NOT NULL
      AND infrastructure_authorization_id IS NOT NULL AND maximum_cost_usd IS NOT NULL
      AND held_cost_usd IS NOT NULL AND consumed_cost_usd IS NOT NULL AND orphan_identity_digest IS NULL)
    OR
    (attempt_id IS NULL AND source_id IS NULL AND grant_id IS NULL AND lease_epoch IS NULL
      AND controller_generation IS NULL AND profile_digest IS NULL AND profile_snapshot IS NULL
      AND launch_plan_digest IS NULL AND infrastructure_authorization_id IS NULL
      AND maximum_cost_usd IS NULL AND held_cost_usd IS NULL AND consumed_cost_usd IS NULL
      AND orphan_identity_digest IS NOT NULL)
  ),
  CHECK (
    (provider IS NULL AND external_id IS NULL AND session_id IS NULL)
    OR (provider IS NOT NULL AND external_id IS NOT NULL AND session_id IS NOT NULL)
  ),
  CHECK (
    (state = 'TERMINATED' AND terminated_at IS NOT NULL)
    OR (state <> 'TERMINATED' AND terminated_at IS NULL)
  ),
  FOREIGN KEY (attempt_id, grant_id, source_id)
    REFERENCES motive.attempts(id, grant_id, source_id) ON DELETE RESTRICT,
  FOREIGN KEY (infrastructure_authorization_id, source_id)
    REFERENCES motive.infrastructure_authorizations(id, source_account_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX orchestration_environment_attempt_kind_epoch_idx
  ON motive.orchestration_environments (attempt_id, kind, lease_epoch) WHERE attempt_id IS NOT NULL;
CREATE UNIQUE INDEX orchestration_one_live_environment_kind_idx
  ON motive.orchestration_environments (attempt_id, kind)
  WHERE attempt_id IS NOT NULL AND state NOT IN ('TERMINATED', 'ABANDONED');
CREATE UNIQUE INDEX orchestration_environment_provider_identity_idx
  ON motive.orchestration_environments (provider, external_id, session_id)
  WHERE provider IS NOT NULL AND external_id IS NOT NULL AND session_id IS NOT NULL AND state <> 'TERMINATED';
CREATE UNIQUE INDEX orchestration_orphan_identity_idx
  ON motive.orchestration_environments (orphan_identity_digest)
  WHERE attempt_id IS NULL AND state <> 'TERMINATED';
CREATE INDEX orchestration_environment_reconcile_idx
  ON motive.orchestration_environments (state, last_observed_at, created_at)
  WHERE state <> 'TERMINATED';

-- effect_key is deterministic and makes retries locate the one intent instead
-- of producing a second provider request.  Only digests and provider handles
-- are persisted; no command body or bearer capability is stored here.
CREATE TABLE motive.orchestration_effects (
  id UUID PRIMARY KEY,
  environment_id UUID NOT NULL REFERENCES motive.orchestration_environments(id) ON DELETE RESTRICT,
  attempt_id UUID REFERENCES motive.attempts(id) ON DELETE RESTRICT,
  kind motive.orchestration_effect_kind NOT NULL,
  effect_key TEXT NOT NULL UNIQUE CHECK (char_length(effect_key) BETWEEN 1 AND 768),
  command_digest TEXT CHECK (command_digest IS NULL OR command_digest ~ '^sha256:[a-f0-9]{64}$'),
  state motive.orchestration_effect_status NOT NULL DEFAULT 'INTENT_RECORDED',
  claimed_by TEXT CHECK (claimed_by IS NULL OR char_length(claimed_by) BETWEEN 1 AND 512),
  claimed_lease_epoch INTEGER CHECK (claimed_lease_epoch IS NULL OR claimed_lease_epoch > 0),
  claimed_at TIMESTAMPTZ,
  result_recorded_at TIMESTAMPTZ,
  unknown_reason TEXT CHECK (unknown_reason IS NULL OR char_length(unknown_reason) BETWEEN 1 AND 512),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (kind = 'COMMAND' AND command_digest IS NOT NULL)
    OR (kind IN ('CREATE', 'STOP') AND command_digest IS NULL)
  ),
  CHECK (
    (claimed_by IS NULL AND claimed_lease_epoch IS NULL AND claimed_at IS NULL)
    OR (claimed_by IS NOT NULL AND claimed_at IS NOT NULL)
  ),
  CHECK (
    (state = 'INTENT_RECORDED' AND claimed_by IS NULL AND result_recorded_at IS NULL AND unknown_reason IS NULL)
    OR (state = 'CLAIMED' AND claimed_by IS NOT NULL AND result_recorded_at IS NULL AND unknown_reason IS NULL)
    OR (state = 'RESULT_RECORDED' AND claimed_by IS NOT NULL AND result_recorded_at IS NOT NULL AND unknown_reason IS NULL)
    OR (state = 'UNKNOWN' AND claimed_by IS NOT NULL AND result_recorded_at IS NULL AND unknown_reason IS NOT NULL)
    OR (state = 'ABANDONED' AND claimed_by IS NULL AND result_recorded_at IS NULL AND unknown_reason IS NULL)
  )
);
CREATE UNIQUE INDEX orchestration_create_effect_once_idx
  ON motive.orchestration_effects (environment_id) WHERE kind = 'CREATE';
CREATE UNIQUE INDEX orchestration_command_effect_once_idx
  ON motive.orchestration_effects (environment_id) WHERE kind = 'COMMAND';
CREATE UNIQUE INDEX orchestration_stop_effect_once_idx
  ON motive.orchestration_effects (environment_id) WHERE kind = 'STOP';
CREATE INDEX orchestration_effect_reconcile_idx
  ON motive.orchestration_effects (state, kind, created_at)
  WHERE state IN ('CLAIMED', 'UNKNOWN');

CREATE TABLE motive.orchestration_commands (
  effect_id UUID PRIMARY KEY REFERENCES motive.orchestration_effects(id) ON DELETE RESTRICT,
  environment_id UUID NOT NULL REFERENCES motive.orchestration_environments(id) ON DELETE RESTRICT,
  provider_command_id TEXT NOT NULL CHECK (char_length(provider_command_id) BETWEEN 1 AND 512),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (environment_id),
  UNIQUE (environment_id, provider_command_id)
);

CREATE TABLE motive.infrastructure_usage_records (
  id UUID PRIMARY KEY,
  infrastructure_authorization_id UUID NOT NULL REFERENCES motive.infrastructure_authorizations(id) ON DELETE RESTRICT,
  environment_id UUID NOT NULL REFERENCES motive.orchestration_environments(id) ON DELETE RESTRICT,
  provider_usage_id TEXT NOT NULL CHECK (char_length(provider_usage_id) BETWEEN 1 AND 512),
  amount_usd NUMERIC(30,12) NOT NULL CHECK (amount_usd >= 0),
  raw_provider_amount TEXT CHECK (raw_provider_amount IS NULL OR char_length(raw_provider_amount) <= 512),
  authoritative_final BOOLEAN NOT NULL DEFAULT FALSE,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (infrastructure_authorization_id, provider_usage_id)
);
CREATE UNIQUE INDEX infrastructure_usage_one_final_per_environment_idx
  ON motive.infrastructure_usage_records (environment_id) WHERE authoritative_final;

CREATE TABLE motive.orchestration_artifact_seals (
  environment_id UUID PRIMARY KEY REFERENCES motive.orchestration_environments(id) ON DELETE RESTRICT,
  attempt_id UUID NOT NULL REFERENCES motive.attempts(id) ON DELETE RESTRICT,
  manifest_digest TEXT CHECK (manifest_digest IS NULL OR manifest_digest ~ '^sha256:[a-f0-9]{64}$'),
  receipt_id TEXT NOT NULL CHECK (char_length(receipt_id) BETWEEN 1 AND 512),
  status motive.orchestration_artifact_seal_status NOT NULL,
  failure_code TEXT CHECK (failure_code IS NULL OR char_length(failure_code) BETWEEN 1 AND 256),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (status = 'SEALED' AND manifest_digest IS NOT NULL AND failure_code IS NULL)
    OR (status = 'FAILED' AND manifest_digest IS NULL AND failure_code IS NOT NULL)
  )
);
CREATE UNIQUE INDEX orchestration_artifact_seals_attempt_idx
  ON motive.orchestration_artifact_seals (attempt_id);

CREATE OR REPLACE FUNCTION motive.guard_infrastructure_authorization_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.source_account_id IS DISTINCT FROM OLD.source_account_id
    OR NEW.source_account_ref IS DISTINCT FROM OLD.source_account_ref
    OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.limit_usd IS DISTINCT FROM OLD.limit_usd
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'infrastructure authorization terms are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION motive.guard_orchestration_environment_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
    OR NEW.source_id IS DISTINCT FROM OLD.source_id
    OR NEW.grant_id IS DISTINCT FROM OLD.grant_id
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.lease_epoch IS DISTINCT FROM OLD.lease_epoch
    OR NEW.controller_generation IS DISTINCT FROM OLD.controller_generation
    OR NEW.profile_digest IS DISTINCT FROM OLD.profile_digest
    OR NEW.profile_snapshot IS DISTINCT FROM OLD.profile_snapshot
    OR NEW.launch_plan_digest IS DISTINCT FROM OLD.launch_plan_digest
    OR NEW.infrastructure_authorization_id IS DISTINCT FROM OLD.infrastructure_authorization_id
    OR NEW.maximum_cost_usd IS DISTINCT FROM OLD.maximum_cost_usd
    OR NEW.orphan_identity_digest IS DISTINCT FROM OLD.orphan_identity_digest
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'orchestration environment identity and authorization are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.provider IS NOT NULL AND NEW.provider IS DISTINCT FROM OLD.provider
    OR OLD.external_id IS NOT NULL AND NEW.external_id IS DISTINCT FROM OLD.external_id
    OR OLD.session_id IS NOT NULL AND NEW.session_id IS DISTINCT FROM OLD.session_id THEN
    RAISE EXCEPTION 'orchestration provider handle is write-once' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'TERMINATED' AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'a terminal environment cannot return to a live state' USING ERRCODE = '55000';
  END IF;
  IF OLD.terminated_at IS NOT NULL AND NEW.terminated_at IS DISTINCT FROM OLD.terminated_at THEN
    RAISE EXCEPTION 'environment termination observation is write-once' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION motive.guard_orchestration_effect_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
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
  RETURN NEW;
END;
$$;

CREATE TRIGGER infrastructure_authorizations_identity_immutable
  BEFORE UPDATE ON motive.infrastructure_authorizations
  FOR EACH ROW EXECUTE FUNCTION motive.guard_infrastructure_authorization_identity();
CREATE TRIGGER orchestration_environments_identity_immutable
  BEFORE UPDATE ON motive.orchestration_environments
  FOR EACH ROW EXECUTE FUNCTION motive.guard_orchestration_environment_identity();
CREATE TRIGGER orchestration_effects_identity_immutable
  BEFORE UPDATE ON motive.orchestration_effects
  FOR EACH ROW EXECUTE FUNCTION motive.guard_orchestration_effect_identity();
CREATE TRIGGER infrastructure_usage_records_immutable
  BEFORE UPDATE OR DELETE ON motive.infrastructure_usage_records
  FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();
CREATE TRIGGER orchestration_artifact_seals_immutable
  BEFORE UPDATE OR DELETE ON motive.orchestration_artifact_seals
  FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();
CREATE TRIGGER orchestration_commands_immutable
  BEFORE UPDATE OR DELETE ON motive.orchestration_commands
  FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();

-- Fenced Trigger delivery.  Legacy consumers may still have claimed_at/
-- claimed_by values; token fields are independent so this additive migration
-- does not make the pre-P2 consumer fail before it is retired.
ALTER TABLE motive.outbox
  ADD COLUMN delivery_claim_token UUID,
  ADD COLUMN delivery_claim_expires_at TIMESTAMPTZ,
  ADD COLUMN trigger_run_id TEXT,
  ADD COLUMN delivery_last_error_code TEXT;
ALTER TABLE motive.outbox
  ADD CONSTRAINT outbox_delivery_claim_token_pair_check CHECK (
    (delivery_claim_token IS NULL AND delivery_claim_expires_at IS NULL)
    OR (delivery_claim_token IS NOT NULL AND delivery_claim_expires_at IS NOT NULL)
  );
CREATE INDEX outbox_delivery_fence_idx
  ON motive.outbox (available_at, id, delivery_claim_expires_at)
  WHERE delivered_at IS NULL;

REVOKE ALL ON motive.infrastructure_authorizations FROM PUBLIC;
REVOKE ALL ON motive.orchestration_leases FROM PUBLIC;
REVOKE ALL ON motive.orchestration_capacity FROM PUBLIC;
REVOKE ALL ON motive.orchestration_environments FROM PUBLIC;
REVOKE ALL ON motive.orchestration_effects FROM PUBLIC;
REVOKE ALL ON motive.orchestration_commands FROM PUBLIC;
REVOKE ALL ON motive.infrastructure_usage_records FROM PUBLIC;
REVOKE ALL ON motive.orchestration_artifact_seals FROM PUBLIC;
REVOKE ALL ON motive.outbox FROM PUBLIC;
