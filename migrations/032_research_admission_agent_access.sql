-- Single-purpose reviewer-agent credentials bound to one immutable research
-- admission package. They carry no contributor, engine, funding, policy, or
-- engine write authority.

CREATE TABLE motive.hypothesis_submission_admission_agent_access (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES motive.projects(id) ON DELETE RESTRICT,
  submission_id UUID NOT NULL REFERENCES motive.submissions(id) ON DELETE RESTRICT,
  delivery_id UUID NOT NULL REFERENCES motive.hypothesis_submission_deliveries(id) ON DELETE RESTRICT,
  reviewer_actor_id TEXT NOT NULL CHECK (reviewer_actor_id ~ '^account:[A-Za-z0-9._~-]+$'
    AND char_length(reviewer_actor_id) BETWEEN 9 AND 488),
  review_package JSONB NOT NULL CHECK (jsonb_typeof(review_package)='object'
    AND octet_length(review_package::text)<=131072),
  review_package_digest TEXT NOT NULL CHECK (review_package_digest ~ '^sha256:[a-f0-9]{64}$'),
  expected_decision_id UUID,
  token_digest TEXT NOT NULL UNIQUE CHECK (token_digest ~ '^sha256:[a-f0-9]{64}$'),
  token_hint TEXT NOT NULL CHECK (token_hint ~ '^[a-f0-9]{12}$'),
  issuance_idempotency_key TEXT NOT NULL CHECK (char_length(issuance_idempotency_key) BETWEEN 8 AND 200
    AND issuance_idempotency_key ~ '^[A-Za-z0-9._~-]+$'),
  issuance_request_digest TEXT NOT NULL CHECK (issuance_request_digest ~ '^sha256:[a-f0-9]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  first_seen_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  consumed_decision_id UUID,
  consumed_idempotency_key TEXT CHECK (consumed_idempotency_key IS NULL OR
    (char_length(consumed_idempotency_key) BETWEEN 8 AND 200 AND consumed_idempotency_key ~ '^[A-Za-z0-9._~-]+$')),
  consumed_request_digest TEXT CHECK (consumed_request_digest IS NULL OR consumed_request_digest ~ '^sha256:[a-f0-9]{64}$'),
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(reviewer_actor_id,issuance_idempotency_key),
  UNIQUE(id,delivery_id),
  FOREIGN KEY(expected_decision_id,delivery_id)
    REFERENCES motive.hypothesis_submission_delivery_admission_decisions(id,delivery_id) ON DELETE RESTRICT,
  FOREIGN KEY(consumed_decision_id,delivery_id)
    REFERENCES motive.hypothesis_submission_delivery_admission_decisions(id,delivery_id) ON DELETE RESTRICT,
  CHECK (expires_at>created_at AND expires_at<=created_at+interval '1 hour'),
  CHECK ((review_package->>'format') IS NOT DISTINCT FROM 'motive.research-delivery-review-package/0.1'),
  CHECK ((review_package#>>'{delivery,id}') IS NOT DISTINCT FROM delivery_id::text),
  CHECK ((review_package#>>'{delivery,projectId}') IS NOT DISTINCT FROM project_id::text),
  CHECK ((review_package#>>'{delivery,sourceSubmissionId}') IS NOT DISTINCT FROM submission_id::text),
  CHECK ((review_package#>>'{assessment,hypothesisSupport}') IS NOT DISTINCT FROM 'UNASSESSED'),
  CHECK ((review_package#>>'{assessment,conclusionApproval}') IS NOT DISTINCT FROM 'UNASSESSED'),
  CHECK ((first_seen_at IS NULL AND last_seen_at IS NULL) OR
    (first_seen_at IS NOT NULL AND last_seen_at IS NOT NULL
      AND first_seen_at>=created_at AND last_seen_at>=first_seen_at AND last_seen_at<expires_at)),
  CHECK (revoked_at IS NULL OR revoked_at>=created_at),
  CHECK ((consumed_decision_id IS NULL AND consumed_idempotency_key IS NULL
      AND consumed_request_digest IS NULL AND consumed_at IS NULL)
    OR (consumed_decision_id IS NOT NULL AND consumed_idempotency_key IS NOT NULL
      AND consumed_request_digest IS NOT NULL AND consumed_at IS NOT NULL
      AND consumed_at>=created_at AND consumed_at<expires_at))
);

CREATE UNIQUE INDEX hypothesis_submission_admission_agent_one_open_idx
  ON motive.hypothesis_submission_admission_agent_access(reviewer_actor_id,delivery_id)
  WHERE revoked_at IS NULL AND consumed_at IS NULL;
CREATE INDEX hypothesis_submission_admission_agent_submission_idx
  ON motive.hypothesis_submission_admission_agent_access(reviewer_actor_id,submission_id,created_at DESC);

CREATE OR REPLACE FUNCTION motive.guard_hypothesis_submission_admission_agent_insert()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,motive AS $$
BEGIN
  PERFORM 1 FROM motive.hypothesis_submission_deliveries delivery
    WHERE delivery.id=NEW.delivery_id AND delivery.project_id=NEW.project_id
      AND delivery.source_submission_id=NEW.submission_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reviewer agent access requires its exact delivery and submission' USING ERRCODE='23514';
  END IF;

  IF NEW.expected_decision_id IS NULL THEN
    IF EXISTS (SELECT 1 FROM motive.hypothesis_submission_delivery_admission_decisions item
      WHERE item.delivery_id=NEW.delivery_id) THEN
      RAISE EXCEPTION 'reviewer agent access expected decision is stale' USING ERRCODE='40001';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1 FROM motive.hypothesis_submission_delivery_admission_decisions item
    WHERE item.id=NEW.expected_decision_id AND item.delivery_id=NEW.delivery_id
      AND NOT EXISTS (SELECT 1 FROM motive.hypothesis_submission_delivery_admission_decisions successor
        WHERE successor.previous_decision_id=item.id)
  ) THEN
    RAISE EXCEPTION 'reviewer agent access expected decision is stale' USING ERRCODE='40001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM motive.hypothesis_submission_deliveries delivery
    JOIN motive.participation_submission_artifacts artifact ON artifact.submission_id=delivery.source_submission_id
      AND artifact.project_id=delivery.project_id
    JOIN motive.participation_agent_tokens contributor ON contributor.id=artifact.agent_token_id
      AND contributor.project_id=delivery.project_id
    JOIN motive.memberships membership ON membership.project_id=delivery.project_id
      AND membership.actor_id=NEW.reviewer_actor_id AND membership.revoked_at IS NULL
      AND membership.role IN ('OWNER','STEWARD','REVIEWER')
    JOIN motive.account_identities identity ON identity.actor_id=NEW.reviewer_actor_id AND identity.status='ACTIVE'
    WHERE delivery.id=NEW.delivery_id AND NEW.reviewer_actor_id<>contributor.owner_actor_id
  ) THEN
    RAISE EXCEPTION 'reviewer agent access requires independent current review authority' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION motive.guard_hypothesis_submission_admission_agent_update()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,motive AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.submission_id IS DISTINCT FROM OLD.submission_id OR NEW.delivery_id IS DISTINCT FROM OLD.delivery_id
    OR NEW.reviewer_actor_id IS DISTINCT FROM OLD.reviewer_actor_id
    OR NEW.review_package IS DISTINCT FROM OLD.review_package OR NEW.review_package_digest IS DISTINCT FROM OLD.review_package_digest
    OR NEW.expected_decision_id IS DISTINCT FROM OLD.expected_decision_id
    OR NEW.token_digest IS DISTINCT FROM OLD.token_digest OR NEW.token_hint IS DISTINCT FROM OLD.token_hint
    OR NEW.issuance_idempotency_key IS DISTINCT FROM OLD.issuance_idempotency_key
    OR NEW.issuance_request_digest IS DISTINCT FROM OLD.issuance_request_digest
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
    OR (OLD.first_seen_at IS NOT NULL AND NEW.first_seen_at IS DISTINCT FROM OLD.first_seen_at)
    OR (OLD.last_seen_at IS NOT NULL AND (NEW.last_seen_at IS NULL OR NEW.last_seen_at<OLD.last_seen_at))
    OR (OLD.consumed_decision_id IS NOT NULL AND (
      NEW.consumed_decision_id IS DISTINCT FROM OLD.consumed_decision_id
      OR NEW.consumed_idempotency_key IS DISTINCT FROM OLD.consumed_idempotency_key
      OR NEW.consumed_request_digest IS DISTINCT FROM OLD.consumed_request_digest
      OR NEW.consumed_at IS DISTINCT FROM OLD.consumed_at))
  THEN
    RAISE EXCEPTION 'reviewer agent access bindings and terminal state are immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.consumed_decision_id IS NULL AND NEW.consumed_decision_id IS NOT NULL THEN
    IF NEW.revoked_at IS NOT NULL OR OLD.expires_at<=clock_timestamp() OR NOT EXISTS (
      SELECT 1
      FROM motive.hypothesis_submission_delivery_admission_decisions decision
      WHERE decision.id=NEW.consumed_decision_id
        AND decision.delivery_id=OLD.delivery_id
        AND decision.reviewer_actor_id=OLD.reviewer_actor_id
        AND decision.review_package_digest=OLD.review_package_digest
        AND decision.previous_decision_id IS NOT DISTINCT FROM OLD.expected_decision_id
    ) THEN
      RAISE EXCEPTION 'reviewer agent access cannot consume an expired, revoked, or mismatched decision'
        USING ERRCODE='42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER hypothesis_submission_admission_agent_insert_guard
BEFORE INSERT ON motive.hypothesis_submission_admission_agent_access
FOR EACH ROW EXECUTE FUNCTION motive.guard_hypothesis_submission_admission_agent_insert();
CREATE TRIGGER hypothesis_submission_admission_agent_update_guard
BEFORE UPDATE ON motive.hypothesis_submission_admission_agent_access
FOR EACH ROW EXECUTE FUNCTION motive.guard_hypothesis_submission_admission_agent_update();
CREATE TRIGGER hypothesis_submission_admission_agent_no_delete
BEFORE DELETE ON motive.hypothesis_submission_admission_agent_access
FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();

REVOKE ALL ON motive.hypothesis_submission_admission_agent_access FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_hypothesis_submission_admission_agent_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_hypothesis_submission_admission_agent_update() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    EXECUTE 'REVOKE ALL ON motive.hypothesis_submission_admission_agent_access FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_hypothesis_submission_admission_agent_insert() FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_hypothesis_submission_admission_agent_update() FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    EXECUTE 'REVOKE ALL ON motive.hypothesis_submission_admission_agent_access FROM authenticated';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_hypothesis_submission_admission_agent_insert() FROM authenticated';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_hypothesis_submission_admission_agent_update() FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='motive_control_reader') THEN
    EXECUTE 'REVOKE ALL ON motive.hypothesis_submission_admission_agent_access FROM motive_control_reader';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_hypothesis_submission_admission_agent_insert() FROM motive_control_reader';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_hypothesis_submission_admission_agent_update() FROM motive_control_reader';
  END IF;
END $$;
