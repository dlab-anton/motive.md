-- Preserve the exact lease and controller generation that admitted a paid
-- operation.  Historical rows remain nullable and are deliberately not
-- dispatchable; fabricating a past fence would make recovery less safe.
ALTER TABLE motive.request_operations
  ADD COLUMN admission_lease_epoch INTEGER,
  ADD COLUMN admission_controller_generation BIGINT,
  ADD CONSTRAINT request_operations_admission_fence_pair_check CHECK (
    (admission_lease_epoch IS NULL AND admission_controller_generation IS NULL)
    OR (admission_lease_epoch IS NOT NULL AND admission_lease_epoch > 0 AND admission_controller_generation IS NOT NULL AND admission_controller_generation > 0)
  );

CREATE OR REPLACE FUNCTION motive.require_operation_admission_fence()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  attempt_lease_epoch INTEGER;
  attempt_controller_generation BIGINT;
  controller_generation BIGINT;
BEGIN
  IF NEW.admission_lease_epoch IS NULL OR NEW.admission_controller_generation IS NULL THEN
    RAISE EXCEPTION 'new request operations require an admission lease and controller generation' USING ERRCODE = '55000';
  END IF;
  SELECT lease_epoch, controller_generation
    INTO attempt_lease_epoch, attempt_controller_generation
    FROM motive.attempts WHERE id = NEW.attempt_id;
  SELECT generation INTO controller_generation FROM motive.controller_state WHERE singleton = TRUE;
  IF attempt_lease_epoch IS NULL OR controller_generation IS NULL
    OR NEW.admission_lease_epoch <> attempt_lease_epoch
    OR NEW.admission_controller_generation <> attempt_controller_generation
    OR NEW.admission_controller_generation <> controller_generation THEN
    RAISE EXCEPTION 'request operation admission fence does not match the current attempt/controller' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER request_operations_admission_fence_required
  BEFORE INSERT ON motive.request_operations FOR EACH ROW EXECUTE FUNCTION motive.require_operation_admission_fence();

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
    OR NEW.admission_metadata IS DISTINCT FROM OLD.admission_metadata
    OR NEW.admission_lease_epoch IS DISTINCT FROM OLD.admission_lease_epoch
    OR NEW.admission_controller_generation IS DISTINCT FROM OLD.admission_controller_generation
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

REVOKE ALL ON motive.request_operations FROM PUBLIC;
