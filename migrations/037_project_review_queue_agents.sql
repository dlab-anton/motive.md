-- Finite reviewer-owned queue sessions. A session can select only shared-memory
-- admission work and delegates each claimed item through the existing exact,
-- one-package reviewer-agent credential.

CREATE TABLE motive.project_review_queue_agent_grants (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES motive.projects(id) ON DELETE RESTRICT,
  reviewer_actor_id TEXT NOT NULL CHECK (reviewer_actor_id ~ '^account:[A-Za-z0-9._~-]+$'
    AND char_length(reviewer_actor_id) BETWEEN 9 AND 488),
  review_kind TEXT NOT NULL CHECK (review_kind='MEMORY_ADMISSION'),
  max_decisions SMALLINT NOT NULL CHECK (max_decisions BETWEEN 1 AND 10),
  token_digest TEXT NOT NULL UNIQUE CHECK (token_digest ~ '^sha256:[a-f0-9]{64}$'),
  token_hint TEXT NOT NULL CHECK (token_hint ~ '^[a-f0-9]{12}$'),
  issuance_idempotency_key TEXT NOT NULL CHECK (char_length(issuance_idempotency_key) BETWEEN 8 AND 200
    AND issuance_idempotency_key ~ '^[A-Za-z0-9._~-]+$'),
  issuance_request_digest TEXT NOT NULL CHECK (issuance_request_digest ~ '^sha256:[a-f0-9]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  first_seen_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(reviewer_actor_id,issuance_idempotency_key),
  CHECK (expires_at>created_at AND expires_at<=created_at+interval '1 hour'),
  CHECK (revoked_at IS NULL OR revoked_at>=created_at),
  CHECK ((first_seen_at IS NULL AND last_seen_at IS NULL) OR
    (first_seen_at IS NOT NULL AND last_seen_at IS NOT NULL
      AND first_seen_at>=created_at AND last_seen_at>=first_seen_at AND last_seen_at<expires_at))
);

-- Persist the parent before a child token is returned. This closes the small
-- issue/link transaction gap: parent expiry or revocation can fence an orphaned
-- child even when its queue claim has not been linked yet.
ALTER TABLE motive.hypothesis_submission_admission_agent_access
  ADD COLUMN queue_grant_id UUID REFERENCES motive.project_review_queue_agent_grants(id) ON DELETE RESTRICT;
CREATE INDEX hypothesis_submission_admission_agent_queue_grant_idx
  ON motive.hypothesis_submission_admission_agent_access(queue_grant_id)
  WHERE queue_grant_id IS NOT NULL;

CREATE OR REPLACE FUNCTION motive.guard_hypothesis_submission_admission_agent_queue_binding()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,motive AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.queue_grant_id IS DISTINCT FROM OLD.queue_grant_id THEN
    RAISE EXCEPTION 'reviewer agent queue parent is immutable' USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' AND NEW.queue_grant_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM motive.project_review_queue_agent_grants grant_row
    WHERE grant_row.id=NEW.queue_grant_id AND grant_row.project_id=NEW.project_id
      AND grant_row.reviewer_actor_id=NEW.reviewer_actor_id AND grant_row.review_kind='MEMORY_ADMISSION'
      AND grant_row.revoked_at IS NULL AND grant_row.expires_at>clock_timestamp()
      AND (SELECT count(*) FROM motive.project_review_queue_agent_claims used
        WHERE used.grant_id=grant_row.id AND used.consumed_at IS NOT NULL)<grant_row.max_decisions
    FOR SHARE
  ) THEN
    RAISE EXCEPTION 'reviewer agent queue parent is not current' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER hypothesis_submission_admission_agent_queue_binding_guard
BEFORE INSERT OR UPDATE ON motive.hypothesis_submission_admission_agent_access
FOR EACH ROW EXECUTE FUNCTION motive.guard_hypothesis_submission_admission_agent_queue_binding();

CREATE TABLE motive.project_review_queue_agent_claims (
  id UUID PRIMARY KEY,
  grant_id UUID NOT NULL REFERENCES motive.project_review_queue_agent_grants(id) ON DELETE RESTRICT,
  project_id UUID NOT NULL REFERENCES motive.projects(id) ON DELETE RESTRICT,
  submission_id UUID NOT NULL REFERENCES motive.submissions(id) ON DELETE RESTRICT,
  delivery_id UUID REFERENCES motive.hypothesis_submission_deliveries(id) ON DELETE RESTRICT,
  child_access_id UUID UNIQUE REFERENCES motive.hypothesis_submission_admission_agent_access(id) ON DELETE RESTRICT,
  claim_idempotency_key TEXT NOT NULL CHECK (char_length(claim_idempotency_key) BETWEEN 8 AND 200
    AND claim_idempotency_key ~ '^[A-Za-z0-9._~-]+$'),
  claim_request_digest TEXT NOT NULL CHECK (claim_request_digest ~ '^sha256:[a-f0-9]{64}$'),
  assignment_expires_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  release_reason TEXT CHECK (release_reason IS NULL OR
    (char_length(release_reason) BETWEEN 1 AND 500 AND btrim(release_reason)=release_reason)),
  release_idempotency_key TEXT CHECK (release_idempotency_key IS NULL OR
    (char_length(release_idempotency_key) BETWEEN 8 AND 200 AND release_idempotency_key ~ '^[A-Za-z0-9._~-]+$')),
  release_request_digest TEXT CHECK (release_request_digest IS NULL OR release_request_digest ~ '^sha256:[a-f0-9]{64}$'),
  expired_at TIMESTAMPTZ,
  consumed_decision_id UUID REFERENCES motive.hypothesis_submission_delivery_admission_decisions(id) ON DELETE RESTRICT,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(grant_id,claim_idempotency_key),
  UNIQUE(grant_id,release_idempotency_key),
  UNIQUE(grant_id,submission_id),
  UNIQUE(id,grant_id),
  CHECK (assignment_expires_at>created_at),
  CHECK ((delivery_id IS NULL AND child_access_id IS NULL) OR
    (delivery_id IS NOT NULL AND child_access_id IS NOT NULL)),
  CHECK ((released_at IS NULL AND release_reason IS NULL AND release_idempotency_key IS NULL AND release_request_digest IS NULL) OR
    (released_at IS NOT NULL AND release_reason IS NOT NULL AND release_idempotency_key IS NOT NULL
      AND release_request_digest IS NOT NULL AND released_at>=created_at)),
  CHECK (expired_at IS NULL OR expired_at>=created_at),
  CHECK ((consumed_decision_id IS NULL AND consumed_at IS NULL) OR
    (consumed_decision_id IS NOT NULL AND consumed_at IS NOT NULL AND consumed_at>=created_at)),
  CHECK (((released_at IS NOT NULL)::integer+(expired_at IS NOT NULL)::integer+
    (consumed_at IS NOT NULL)::integer)<=1)
);

CREATE UNIQUE INDEX project_review_queue_agent_one_open_claim_idx
  ON motive.project_review_queue_agent_claims(grant_id)
  WHERE released_at IS NULL AND expired_at IS NULL AND consumed_at IS NULL;
CREATE UNIQUE INDEX project_review_queue_agent_one_open_submission_idx
  ON motive.project_review_queue_agent_claims(project_id,submission_id)
  WHERE released_at IS NULL AND expired_at IS NULL AND consumed_at IS NULL;
CREATE INDEX project_review_queue_agent_claims_grant_created_idx
  ON motive.project_review_queue_agent_claims(grant_id,created_at DESC,id DESC);

CREATE TABLE motive.project_review_queue_agent_claim_requests (
  id UUID PRIMARY KEY,
  grant_id UUID NOT NULL REFERENCES motive.project_review_queue_agent_grants(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200
    AND idempotency_key ~ '^[A-Za-z0-9._~-]+$'),
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  claim_id UUID,
  outcome TEXT NOT NULL CHECK (outcome IN ('ASSIGNED','EMPTY')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(grant_id,idempotency_key),
  CHECK ((outcome='ASSIGNED' AND claim_id IS NOT NULL) OR (outcome='EMPTY' AND claim_id IS NULL)),
  FOREIGN KEY(claim_id,grant_id) REFERENCES motive.project_review_queue_agent_claims(id,grant_id) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION motive.guard_project_review_queue_agent_grant_insert()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,motive AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM motive.memberships membership
    JOIN motive.account_identities identity ON identity.actor_id=membership.actor_id
    WHERE membership.project_id=NEW.project_id AND membership.actor_id=NEW.reviewer_actor_id
      AND membership.revoked_at IS NULL AND membership.role IN ('OWNER','STEWARD','REVIEWER')
      AND identity.status='ACTIVE'
  ) THEN
    RAISE EXCEPTION 'review queue agent grant requires current reviewer authority' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION motive.guard_project_review_queue_agent_grant_update()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,motive AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.reviewer_actor_id IS DISTINCT FROM OLD.reviewer_actor_id
    OR NEW.review_kind IS DISTINCT FROM OLD.review_kind OR NEW.max_decisions IS DISTINCT FROM OLD.max_decisions
    OR NEW.token_digest IS DISTINCT FROM OLD.token_digest OR NEW.token_hint IS DISTINCT FROM OLD.token_hint
    OR NEW.issuance_idempotency_key IS DISTINCT FROM OLD.issuance_idempotency_key
    OR NEW.issuance_request_digest IS DISTINCT FROM OLD.issuance_request_digest
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
    OR (OLD.first_seen_at IS NOT NULL AND NEW.first_seen_at IS DISTINCT FROM OLD.first_seen_at)
    OR (OLD.last_seen_at IS NOT NULL AND (NEW.last_seen_at IS NULL OR NEW.last_seen_at<OLD.last_seen_at))
  THEN
    RAISE EXCEPTION 'review queue agent grant bindings and terminal state are immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION motive.guard_project_review_queue_agent_claim()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,motive AS $$
DECLARE
  grant_record motive.project_review_queue_agent_grants%ROWTYPE;
  child_record motive.hypothesis_submission_admission_agent_access%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' AND (
    NEW.id IS DISTINCT FROM OLD.id OR NEW.grant_id IS DISTINCT FROM OLD.grant_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.submission_id IS DISTINCT FROM OLD.submission_id
    OR NEW.claim_idempotency_key IS DISTINCT FROM OLD.claim_idempotency_key
    OR NEW.claim_request_digest IS DISTINCT FROM OLD.claim_request_digest OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (OLD.delivery_id IS NOT NULL AND NEW.delivery_id IS DISTINCT FROM OLD.delivery_id)
    OR (OLD.child_access_id IS NOT NULL AND NEW.child_access_id IS DISTINCT FROM OLD.child_access_id)
    OR (OLD.assignment_expires_at IS DISTINCT FROM NEW.assignment_expires_at AND OLD.child_access_id IS NOT NULL)
    OR (OLD.released_at IS NOT NULL AND (NEW.released_at IS DISTINCT FROM OLD.released_at OR NEW.release_reason IS DISTINCT FROM OLD.release_reason
      OR NEW.release_idempotency_key IS DISTINCT FROM OLD.release_idempotency_key
      OR NEW.release_request_digest IS DISTINCT FROM OLD.release_request_digest))
    OR (OLD.expired_at IS NOT NULL AND NEW.expired_at IS DISTINCT FROM OLD.expired_at)
    OR (OLD.consumed_decision_id IS NOT NULL AND
      (NEW.consumed_decision_id IS DISTINCT FROM OLD.consumed_decision_id OR NEW.consumed_at IS DISTINCT FROM OLD.consumed_at))
  ) THEN
    RAISE EXCEPTION 'review queue claim bindings and terminal state are immutable' USING ERRCODE='55000';
  END IF;

  SELECT * INTO grant_record FROM motive.project_review_queue_agent_grants WHERE id=NEW.grant_id FOR SHARE;
  IF NOT FOUND OR grant_record.project_id<>NEW.project_id OR grant_record.review_kind<>'MEMORY_ADMISSION'
    OR NEW.assignment_expires_at>grant_record.expires_at THEN
    RAISE EXCEPTION 'review queue claim requires its exact parent grant' USING ERRCODE='23514';
  END IF;

  IF TG_OP='INSERT' AND (grant_record.revoked_at IS NOT NULL OR grant_record.expires_at<=clock_timestamp()
    OR NOT EXISTS (SELECT 1 FROM motive.memberships membership
      JOIN motive.account_identities identity ON identity.actor_id=membership.actor_id
      WHERE membership.project_id=grant_record.project_id AND membership.actor_id=grant_record.reviewer_actor_id
        AND membership.revoked_at IS NULL AND membership.role IN ('OWNER','STEWARD','REVIEWER') AND identity.status='ACTIVE')
    OR (SELECT count(*) FROM motive.project_review_queue_agent_claims used
      WHERE used.grant_id=grant_record.id AND used.consumed_at IS NOT NULL)>=grant_record.max_decisions) THEN
    RAISE EXCEPTION 'review queue claim requires current parent authority and quota' USING ERRCODE='42501';
  END IF;

  IF TG_OP='INSERT' AND NOT EXISTS (
    SELECT 1 FROM motive.submissions submission
    JOIN motive.participation_submission_artifacts artifact ON artifact.submission_id=submission.id
      AND artifact.project_id=submission.project_id
    JOIN motive.participation_agent_tokens contributor ON contributor.id=artifact.agent_token_id
      AND contributor.project_id=artifact.project_id
    JOIN motive.participation_claim_completions completion ON completion.submission_id=submission.id
      AND completion.claim_id=submission.claim_id
    JOIN motive.participation_post_check_assessments assessment ON assessment.submission_id=submission.id
      AND assessment.project_id=submission.project_id AND assessment.agent_token_id=artifact.agent_token_id
      AND assessment.report_digest=artifact.report_digest
    JOIN motive.project_research_scopes scope ON scope.project_id=submission.project_id AND scope.status='CONNECTED'
    WHERE submission.id=NEW.submission_id AND submission.project_id=NEW.project_id
      AND submission.origin='EXTERNAL' AND submission.attempt_id IS NULL
      AND submission.operator_actor_id=('agent:'||contributor.id::text)
      AND submission.provenance ? 'investigation'
      AND artifact.report_body->'agentInvestigation'=submission.provenance->'investigation'
      AND contributor.owner_actor_id<>grant_record.reviewer_actor_id
      AND EXISTS (SELECT 1 FROM motive.work_claims source_claim
        JOIN motive.work_orders source_work ON source_work.id=source_claim.work_order_id
          AND source_work.project_id=submission.project_id AND source_work.revision=submission.work_order_revision
        WHERE source_claim.id=submission.claim_id AND source_claim.work_order_id=submission.work_order_id
          AND source_claim.operator_actor_id=submission.operator_actor_id AND source_claim.lease_epoch=submission.lease_epoch)
      AND NOT EXISTS (
        SELECT 1 FROM motive.hypothesis_submission_deliveries delivery
        JOIN motive.hypothesis_submission_delivery_admission_decisions decision ON decision.delivery_id=delivery.id
        WHERE delivery.project_id=submission.project_id AND delivery.source_submission_id=submission.id)
  ) THEN
    RAISE EXCEPTION 'review queue claim requires eligible independent memory-admission work' USING ERRCODE='42501';
  END IF;

  IF NEW.child_access_id IS NOT NULL THEN
    SELECT * INTO child_record FROM motive.hypothesis_submission_admission_agent_access
      WHERE id=NEW.child_access_id FOR SHARE;
    IF NOT FOUND OR child_record.project_id<>NEW.project_id OR child_record.submission_id<>NEW.submission_id
      OR child_record.delivery_id<>NEW.delivery_id OR child_record.reviewer_actor_id<>grant_record.reviewer_actor_id
      OR child_record.expires_at<>NEW.assignment_expires_at OR child_record.queue_grant_id<>NEW.grant_id THEN
      RAISE EXCEPTION 'review queue claim requires its exact child access' USING ERRCODE='23514';
    END IF;
  END IF;

  IF NEW.consumed_decision_id IS NOT NULL AND (
    NEW.child_access_id IS NULL OR child_record.consumed_decision_id IS DISTINCT FROM NEW.consumed_decision_id
    OR child_record.consumed_at IS NULL OR NEW.consumed_at IS DISTINCT FROM child_record.consumed_at
  ) THEN
    RAISE EXCEPTION 'review queue claim consumption must match its child decision' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER project_review_queue_agent_grant_insert_guard
BEFORE INSERT ON motive.project_review_queue_agent_grants
FOR EACH ROW EXECUTE FUNCTION motive.guard_project_review_queue_agent_grant_insert();
CREATE TRIGGER project_review_queue_agent_grant_update_guard
BEFORE UPDATE ON motive.project_review_queue_agent_grants
FOR EACH ROW EXECUTE FUNCTION motive.guard_project_review_queue_agent_grant_update();
CREATE TRIGGER project_review_queue_agent_grant_no_delete
BEFORE DELETE ON motive.project_review_queue_agent_grants
FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();
CREATE TRIGGER project_review_queue_agent_claim_guard
BEFORE INSERT OR UPDATE ON motive.project_review_queue_agent_claims
FOR EACH ROW EXECUTE FUNCTION motive.guard_project_review_queue_agent_claim();
CREATE TRIGGER project_review_queue_agent_claim_no_delete
BEFORE DELETE ON motive.project_review_queue_agent_claims
FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();
CREATE TRIGGER project_review_queue_agent_claim_request_no_update
BEFORE UPDATE OR DELETE ON motive.project_review_queue_agent_claim_requests
FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();

REVOKE ALL ON motive.project_review_queue_agent_grants FROM PUBLIC;
REVOKE ALL ON motive.project_review_queue_agent_claims FROM PUBLIC;
REVOKE ALL ON motive.project_review_queue_agent_claim_requests FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_project_review_queue_agent_grant_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_project_review_queue_agent_grant_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_project_review_queue_agent_claim() FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_hypothesis_submission_admission_agent_queue_binding() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON motive.project_review_queue_agent_grants,motive.project_review_queue_agent_claims,
      motive.project_review_queue_agent_claim_requests FROM anon;
    REVOKE ALL ON FUNCTION motive.guard_project_review_queue_agent_grant_insert() FROM anon;
    REVOKE ALL ON FUNCTION motive.guard_project_review_queue_agent_grant_update() FROM anon;
    REVOKE ALL ON FUNCTION motive.guard_project_review_queue_agent_claim() FROM anon;
    REVOKE ALL ON FUNCTION motive.guard_hypothesis_submission_admission_agent_queue_binding() FROM anon;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON motive.project_review_queue_agent_grants,motive.project_review_queue_agent_claims,
      motive.project_review_queue_agent_claim_requests FROM authenticated;
    REVOKE ALL ON FUNCTION motive.guard_project_review_queue_agent_grant_insert() FROM authenticated;
    REVOKE ALL ON FUNCTION motive.guard_project_review_queue_agent_grant_update() FROM authenticated;
    REVOKE ALL ON FUNCTION motive.guard_project_review_queue_agent_claim() FROM authenticated;
    REVOKE ALL ON FUNCTION motive.guard_hypothesis_submission_admission_agent_queue_binding() FROM authenticated;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='motive_control_reader') THEN
    REVOKE ALL ON motive.project_review_queue_agent_grants,motive.project_review_queue_agent_claims,
      motive.project_review_queue_agent_claim_requests FROM motive_control_reader;
    REVOKE ALL ON FUNCTION motive.guard_project_review_queue_agent_grant_insert() FROM motive_control_reader;
    REVOKE ALL ON FUNCTION motive.guard_project_review_queue_agent_grant_update() FROM motive_control_reader;
    REVOKE ALL ON FUNCTION motive.guard_project_review_queue_agent_claim() FROM motive_control_reader;
    REVOKE ALL ON FUNCTION motive.guard_hypothesis_submission_admission_agent_queue_binding() FROM motive_control_reader;
  END IF;
END $$;
