-- Tighten P1 referential identity after the initial private schema. These
-- constraints prevent a valid ID from being combined with another project's
-- grant, source, attempt, or provider operation.

ALTER TABLE motive.grants ADD CONSTRAINT grants_id_project_unique UNIQUE (id, project_id);
ALTER TABLE motive.attempts ADD CONSTRAINT attempts_id_project_unique UNIQUE (id, project_id);
ALTER TABLE motive.attempts ADD CONSTRAINT attempts_id_funding_unique UNIQUE (id, grant_id, source_id);
ALTER TABLE motive.request_operations ADD CONSTRAINT request_operations_id_chain_unique UNIQUE (provider_operation_id, attempt_id, grant_id, source_id);

ALTER TABLE motive.attempts
  ADD CONSTRAINT attempts_grant_project_identity_fk
  FOREIGN KEY (grant_id, project_id) REFERENCES motive.grants(id, project_id) ON DELETE RESTRICT;

ALTER TABLE motive.request_operations
  ADD CONSTRAINT request_operations_attempt_chain_fk
  FOREIGN KEY (attempt_id, grant_id, source_id)
  REFERENCES motive.attempts(id, grant_id, source_id) ON DELETE RESTRICT;

ALTER TABLE motive.reservations
  ADD CONSTRAINT reservations_grant_source_identity_fk
  FOREIGN KEY (grant_id, source_id) REFERENCES motive.grants(id, source_id) ON DELETE RESTRICT;
ALTER TABLE motive.reservations
  ADD CONSTRAINT reservations_attempt_chain_fk
  FOREIGN KEY (attempt_id, grant_id, source_id)
  REFERENCES motive.attempts(id, grant_id, source_id) ON DELETE RESTRICT;
ALTER TABLE motive.reservations
  ADD CONSTRAINT reservations_operation_chain_fk
  FOREIGN KEY (operation_id, attempt_id, grant_id, source_id)
  REFERENCES motive.request_operations(provider_operation_id, attempt_id, grant_id, source_id) ON DELETE RESTRICT;

ALTER TABLE motive.usage_records
  ADD CONSTRAINT usage_records_operation_chain_fk
  FOREIGN KEY (operation_id, attempt_id, grant_id, source_id)
  REFERENCES motive.request_operations(provider_operation_id, attempt_id, grant_id, source_id) ON DELETE RESTRICT;

ALTER TABLE motive.work_claims
  ADD CONSTRAINT work_claims_work_order_project_fk
  FOREIGN KEY (work_order_id, project_id) REFERENCES motive.work_orders(id, project_id) ON DELETE RESTRICT;
ALTER TABLE motive.submissions
  ADD CONSTRAINT submissions_work_order_project_fk
  FOREIGN KEY (work_order_id, project_id) REFERENCES motive.work_orders(id, project_id) ON DELETE RESTRICT;
ALTER TABLE motive.submissions
  ADD CONSTRAINT submissions_attempt_project_fk
  FOREIGN KEY (attempt_id, project_id) REFERENCES motive.attempts(id, project_id) ON DELETE RESTRICT;

-- The issuer/source terms are frozen. Counters and status remain mutable so a
-- real overrun can be preserved without inventing a negative hold.
CREATE OR REPLACE FUNCTION motive.guard_funding_source_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.owner_actor_id IS DISTINCT FROM OLD.owner_actor_id
    OR NEW.controller_actor_id IS DISTINCT FROM OLD.controller_actor_id
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.authorized_amount IS DISTINCT FROM OLD.authorized_amount
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'funding source identity and authorization are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION motive.guard_grant_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.source_id IS DISTINCT FROM OLD.source_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.issuer_actor_id IS DISTINCT FROM OLD.issuer_actor_id
    OR NEW.beneficiary_actor_id IS DISTINCT FROM OLD.beneficiary_actor_id
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.limit_amount IS DISTINCT FROM OLD.limit_amount
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'grant authorization terms are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION motive.guard_attempt_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.work_order_id IS DISTINCT FROM OLD.work_order_id
    OR NEW.grant_id IS DISTINCT FROM OLD.grant_id
    OR NEW.source_id IS DISTINCT FROM OLD.source_id
    OR NEW.terms_digest IS DISTINCT FROM OLD.terms_digest
    OR NEW.profile_digest IS DISTINCT FROM OLD.profile_digest
    OR NEW.input_digest IS DISTINCT FROM OLD.input_digest
    OR NEW.ceiling_amount IS DISTINCT FROM OLD.ceiling_amount
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'attempt authorization terms are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.lease_epoch < OLD.lease_epoch OR NEW.controller_generation < OLD.controller_generation THEN
    RAISE EXCEPTION 'lease epoch and controller generation are monotonic' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION motive.guard_controller_generation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.singleton IS DISTINCT FROM OLD.singleton OR NEW.generation < OLD.generation THEN
    RAISE EXCEPTION 'controller identity and generation are monotonic' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER controller_generation_monotonic
  BEFORE UPDATE ON motive.controller_state FOR EACH ROW EXECUTE FUNCTION motive.guard_controller_generation();

-- An actor/action/key tuple is the idempotency key; effect_id additionally
-- provides a stable opaque identifier for correlating the resulting durable
-- effect with an outbox event or operational trace.
ALTER TABLE motive.idempotency_records ADD COLUMN effect_id UUID;
UPDATE motive.idempotency_records
  SET effect_id = md5(actor_id || E'\\x1f' || action || E'\\x1f' || idempotency_key)::uuid
  WHERE effect_id IS NULL;
ALTER TABLE motive.idempotency_records ALTER COLUMN effect_id SET NOT NULL;
CREATE UNIQUE INDEX idempotency_records_effect_id_idx ON motive.idempotency_records (effect_id);

-- Initial product policy: one active hosted attempt per project. This is not a
-- claim about observed physical sandbox concurrency; P2 adds that lifecycle.
CREATE UNIQUE INDEX one_active_attempt_per_project_idx ON motive.attempts (project_id)
  WHERE execution_status IN ('RESERVED', 'PROVISIONING', 'RUNNING', 'OUTPUT_SEALED', 'EVALUATING', 'WAITING_ACCEPTANCE', 'CANCEL_REQUESTED', 'QUARANTINED');
