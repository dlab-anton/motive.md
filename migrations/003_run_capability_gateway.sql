-- P1 gateway capability boundary.  A worker receives only an opaque bearer
-- value; PostgreSQL retains a hash and the exact authorization fence.

CREATE TABLE motive.run_capabilities (
  id UUID PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^sha256:[a-f0-9]{64}$'),
  project_id UUID NOT NULL REFERENCES motive.projects(id) ON DELETE RESTRICT,
  attempt_id UUID NOT NULL REFERENCES motive.attempts(id) ON DELETE RESTRICT,
  grant_id UUID NOT NULL REFERENCES motive.grants(id) ON DELETE RESTRICT,
  source_id UUID NOT NULL REFERENCES motive.funding_sources(id) ON DELETE RESTRICT,
  profile_digest TEXT NOT NULL CHECK (profile_digest ~ '^sha256:[a-f0-9]{64}$'),
  lease_epoch INTEGER NOT NULL CHECK (lease_epoch > 0),
  controller_generation BIGINT NOT NULL CHECK (controller_generation > 0),
  issued_by_actor_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revoked_by_actor_id TEXT,
  revocation_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at > created_at),
  CHECK (
    (revoked_at IS NULL AND revoked_by_actor_id IS NULL AND revocation_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by_actor_id IS NOT NULL)
  ),
  FOREIGN KEY (attempt_id, project_id) REFERENCES motive.attempts(id, project_id) ON DELETE RESTRICT,
  FOREIGN KEY (attempt_id, grant_id, source_id) REFERENCES motive.attempts(id, grant_id, source_id) ON DELETE RESTRICT
);
CREATE INDEX run_capabilities_attempt_idx ON motive.run_capabilities (attempt_id, expires_at) WHERE revoked_at IS NULL;
CREATE INDEX run_capabilities_project_idx ON motive.run_capabilities (project_id, expires_at) WHERE revoked_at IS NULL;

-- A committed dispatch claim is the send-once boundary.  A later retry sees
-- the claimed operation and must reconcile it rather than send again.
ALTER TABLE motive.request_operations
  ADD COLUMN dispatch_claimed_at TIMESTAMPTZ,
  ADD COLUMN dispatch_claimed_by TEXT,
  ADD COLUMN dispatch_invocation_hash TEXT CHECK (dispatch_invocation_hash IS NULL OR dispatch_invocation_hash ~ '^sha256:[a-f0-9]{64}$');
ALTER TABLE motive.request_operations
  ADD CONSTRAINT request_operations_dispatch_claim_fields_check CHECK (
    (dispatch_claimed_at IS NULL AND dispatch_claimed_by IS NULL AND dispatch_invocation_hash IS NULL)
    OR (dispatch_claimed_at IS NOT NULL AND dispatch_claimed_by IS NOT NULL AND dispatch_invocation_hash IS NOT NULL)
  );
CREATE INDEX request_operations_dispatch_claim_idx
  ON motive.request_operations (dispatch_claimed_at, provider_operation_id)
  WHERE dispatch_claimed_at IS NOT NULL;

-- The original P1 trigger intentionally left provider metadata mutable.  The
-- gateway needs early identifiers to be append-only too, and a dispatch claim
-- must never be reassigned after the durable send boundary is crossed.
CREATE OR REPLACE FUNCTION motive.guard_operation_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.provider_operation_id IS DISTINCT FROM OLD.provider_operation_id
    OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
    OR NEW.grant_id IS DISTINCT FROM OLD.grant_id
    OR NEW.source_id IS DISTINCT FROM OLD.source_id
    OR NEW.request_sequence IS DISTINCT FROM OLD.request_sequence
    OR NEW.request_body_digest IS DISTINCT FROM OLD.request_body_digest
    OR NEW.profile_digest IS DISTINCT FROM OLD.profile_digest
    OR NEW.reserved_amount IS DISTINCT FROM OLD.reserved_amount
    OR NEW.admitted_at IS DISTINCT FROM OLD.admitted_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'operation admission identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.provider_request_id IS NOT NULL AND NEW.provider_request_id IS DISTINCT FROM OLD.provider_request_id THEN
    RAISE EXCEPTION 'provider request identity is write-once' USING ERRCODE = '55000';
  END IF;
  IF OLD.provider_response_id IS NOT NULL AND NEW.provider_response_id IS DISTINCT FROM OLD.provider_response_id THEN
    RAISE EXCEPTION 'provider response identity is write-once' USING ERRCODE = '55000';
  END IF;
  IF OLD.dispatch_claimed_at IS NOT NULL AND (
    NEW.dispatch_claimed_at IS DISTINCT FROM OLD.dispatch_claimed_at
    OR NEW.dispatch_claimed_by IS DISTINCT FROM OLD.dispatch_claimed_by
    OR NEW.dispatch_invocation_hash IS DISTINCT FROM OLD.dispatch_invocation_hash
  ) THEN
    RAISE EXCEPTION 'operation dispatch claim is write-once' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION motive.guard_run_capability_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
    OR NEW.grant_id IS DISTINCT FROM OLD.grant_id
    OR NEW.source_id IS DISTINCT FROM OLD.source_id
    OR NEW.profile_digest IS DISTINCT FROM OLD.profile_digest
    OR NEW.lease_epoch IS DISTINCT FROM OLD.lease_epoch
    OR NEW.controller_generation IS DISTINCT FROM OLD.controller_generation
    OR NEW.issued_by_actor_id IS DISTINCT FROM OLD.issued_by_actor_id
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'run capability scope and expiry are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (
    NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
    OR NEW.revoked_by_actor_id IS DISTINCT FROM OLD.revoked_by_actor_id
    OR NEW.revocation_reason IS DISTINCT FROM OLD.revocation_reason
  ) THEN
    RAISE EXCEPTION 'run capability revocation is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER run_capabilities_identity_immutable
  BEFORE UPDATE ON motive.run_capabilities FOR EACH ROW EXECUTE FUNCTION motive.guard_run_capability_identity();

REVOKE ALL ON motive.run_capabilities FROM PUBLIC;
