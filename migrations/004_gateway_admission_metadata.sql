-- 003 has already been applied to the local control database.  Keep it
-- immutable and add the gateway's frozen, non-secret admission facts here.
ALTER TABLE motive.request_operations
  ADD COLUMN admission_metadata JSONB NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(admission_metadata) = 'object');

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
