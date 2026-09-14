-- Independent, append-only admission decisions for exact immutable research
-- delivery packages. Admission authorizes only draft + neutral engine writes;
-- it never records hypothesis support, conclusion approval, or geometry review.

CREATE TABLE motive.hypothesis_submission_delivery_admission_decisions (
  id UUID PRIMARY KEY,
  delivery_id UUID NOT NULL REFERENCES motive.hypothesis_submission_deliveries(id) ON DELETE RESTRICT,
  review_package JSONB NOT NULL CHECK (jsonb_typeof(review_package)='object'
    AND octet_length(review_package::text)<=131072),
  review_package_digest TEXT NOT NULL CHECK (review_package_digest ~ '^sha256:[a-f0-9]{64}$'),
  previous_decision_id UUID,
  decision TEXT NOT NULL CHECK (decision IN ('ADMIT','DECLINE')),
  reviewer_actor_id TEXT NOT NULL CHECK (reviewer_actor_id ~ '^account:[A-Za-z0-9._~-]+$'),
  rationale TEXT NOT NULL CHECK (char_length(rationale) BETWEEN 1 AND 2000 AND rationale=btrim(rationale)),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200
    AND idempotency_key ~ '^[A-Za-z0-9._~-]+$'),
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(id,delivery_id),
  UNIQUE(reviewer_actor_id,idempotency_key),
  FOREIGN KEY(previous_decision_id,delivery_id)
    REFERENCES motive.hypothesis_submission_delivery_admission_decisions(id,delivery_id) ON DELETE RESTRICT,
  CHECK (previous_decision_id IS NULL OR previous_decision_id<>id),
  CHECK ((review_package->>'format') IS NOT DISTINCT FROM 'motive.research-delivery-review-package/0.1'),
  CHECK ((review_package#>>'{delivery,id}') IS NOT DISTINCT FROM delivery_id::text),
  CHECK ((review_package#>>'{assessment,hypothesisSupport}') IS NOT DISTINCT FROM 'UNASSESSED'),
  CHECK ((review_package#>>'{assessment,conclusionApproval}') IS NOT DISTINCT FROM 'UNASSESSED')
);

CREATE UNIQUE INDEX hypothesis_submission_admission_chain_root_idx
  ON motive.hypothesis_submission_delivery_admission_decisions(delivery_id)
  WHERE previous_decision_id IS NULL;
CREATE UNIQUE INDEX hypothesis_submission_admission_chain_successor_idx
  ON motive.hypothesis_submission_delivery_admission_decisions(previous_decision_id)
  WHERE previous_decision_id IS NOT NULL;
CREATE INDEX hypothesis_submission_admission_delivery_created_idx
  ON motive.hypothesis_submission_delivery_admission_decisions(delivery_id,created_at DESC,id DESC);

CREATE OR REPLACE FUNCTION motive.guard_hypothesis_submission_delivery_admission()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,motive AS $$
BEGIN
  -- This is also the serialization lock shared by decision append and dispatch.
  PERFORM 1 FROM motive.hypothesis_submission_deliveries delivery
    WHERE delivery.id=NEW.delivery_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'research admission delivery was not found' USING ERRCODE='23503';
  END IF;

  IF NEW.previous_decision_id IS NULL THEN
    IF EXISTS (SELECT 1 FROM motive.hypothesis_submission_delivery_admission_decisions item
      WHERE item.delivery_id=NEW.delivery_id) THEN
      RAISE EXCEPTION 'research admission expected decision is stale' USING ERRCODE='40001';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1 FROM motive.hypothesis_submission_delivery_admission_decisions prior
    WHERE prior.id=NEW.previous_decision_id AND prior.delivery_id=NEW.delivery_id
      AND NOT EXISTS (SELECT 1 FROM motive.hypothesis_submission_delivery_admission_decisions successor
        WHERE successor.previous_decision_id=prior.id)
  ) THEN
    RAISE EXCEPTION 'research admission expected decision is stale' USING ERRCODE='40001';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM motive.hypothesis_submission_deliveries delivery
    JOIN motive.hypothesis_writeback_intents intent ON intent.id=delivery.source_intent_id
      AND intent.payload_digest=delivery.source_intent_payload_digest
    JOIN motive.participation_submission_artifacts artifact ON artifact.submission_id=delivery.source_submission_id
      AND artifact.project_id=delivery.project_id
    JOIN motive.participation_agent_tokens token ON token.id=artifact.agent_token_id
      AND token.project_id=delivery.project_id
    JOIN motive.participation_post_check_assessments assessment ON assessment.submission_id=artifact.submission_id
      AND assessment.project_id=delivery.project_id AND assessment.agent_token_id=token.id
      AND assessment.report_digest=artifact.report_digest
    JOIN motive.project_research_scopes scope ON scope.id=delivery.scope_id AND scope.project_id=delivery.project_id
      AND scope.status='CONNECTED' AND scope.configuration_digest=delivery.scope_configuration_digest
      AND scope.api_base_url=delivery.engine_api_base_url AND scope.api_version=delivery.engine_api_version
    JOIN motive.memberships reviewer_membership ON reviewer_membership.project_id=delivery.project_id
      AND reviewer_membership.actor_id=NEW.reviewer_actor_id AND reviewer_membership.revoked_at IS NULL
      AND reviewer_membership.role IN ('OWNER','STEWARD')
    JOIN motive.account_identities reviewer ON reviewer.actor_id=NEW.reviewer_actor_id AND reviewer.status='ACTIVE'
    LEFT JOIN motive.participation_submission_reproducibility reproducibility
      ON reproducibility.submission_id=artifact.submission_id AND reproducibility.project_id=delivery.project_id
      AND reproducibility.agent_token_id=token.id AND reproducibility.report_digest=artifact.report_digest
    JOIN motive.hypothesis_submission_delivery_operations draft ON draft.delivery_id=delivery.id
      AND draft.operation='DRAFT_HYPOTHESIS'
    WHERE delivery.id=NEW.delivery_id AND NEW.reviewer_actor_id<>token.owner_actor_id
      AND (NEW.review_package#>>'{delivery,projectId}')=delivery.project_id::text
      AND (NEW.review_package#>>'{delivery,scopeId}')=delivery.scope_id::text
      AND (NEW.review_package#>>'{delivery,sourceSubmissionId}')=delivery.source_submission_id::text
      AND (NEW.review_package#>>'{delivery,sourceIntentId}')=delivery.source_intent_id::text
      AND (NEW.review_package#>>'{delivery,sourceIntentPayloadDigest}')=delivery.source_intent_payload_digest
      AND (NEW.review_package#>>'{scope,configurationDigest}')=delivery.scope_configuration_digest
      AND (NEW.review_package#>>'{scope,apiBaseUrl}')=delivery.engine_api_base_url
      AND (NEW.review_package#>>'{scope,apiVersion}')=delivery.engine_api_version
      AND (NEW.review_package#>>'{scope,engineActor}')=delivery.engine_actor
      AND (NEW.review_package#>>'{report,digest}')=artifact.report_digest
      AND (NEW.review_package#>>'{report,status}')=artifact.report::text
      AND (NEW.review_package#>'{report,exactScore}') IS NOT DISTINCT FROM coalesce(to_jsonb(artifact.exact_score),'null'::jsonb)
      AND (NEW.review_package#>'{report,exceedsReference}') IS NOT DISTINCT FROM coalesce(to_jsonb(artifact.exceeds_reference),'null'::jsonb)
      AND (NEW.review_package#>>'{postCheck,requestDigest}')=assessment.request_digest
      AND (NEW.review_package#>>'{postCheck,reportDigest}')=assessment.report_digest
      AND (NEW.review_package#>>'{postCheck,assessment}')=assessment.assessment
      AND (NEW.review_package#>>'{postCheck,nextAction}')=assessment.next_action
      AND (NEW.review_package#>>'{postCheck,createdAt}')=to_char(assessment.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      AND (NEW.review_package#>>'{contract,fileDigest}')=delivery.reviewed_contract_digest
      AND (NEW.review_package#>>'{contract,contractVersion}')=delivery.reviewed_contract_version
      AND (NEW.review_package#>>'{contract,apiVersion}')=delivery.engine_api_version
      AND (NEW.review_package#>>'{contract,surfaceDigest}')=delivery.reviewed_contract_surface_digest
      AND (NEW.review_package#>>'{contract,implementationDigest}')=delivery.reviewed_implementation_digest
      AND (NEW.review_package#>>'{operations,draft,bodyDigest}')=draft.request_body_digest
      AND (NEW.review_package#>>'{operations,draft,requestDigest}')=draft.request_digest
      AND (NEW.review_package#>>'{operations,draft,method}')='POST'
      AND (NEW.review_package#>>'{operations,draft,path}')=draft.request_path
      AND (NEW.review_package#>'{operations,draft,body}')=draft.request_body
      AND ((reproducibility.submission_id IS NULL AND (NEW.review_package->'reproducibility')='null'::jsonb)
        OR (reproducibility.submission_id IS NOT NULL
          AND (NEW.review_package#>>'{reproducibility,requestDigest}')=reproducibility.request_digest
          AND (NEW.review_package#>>'{reproducibility,solverSourceDigest}')=reproducibility.solver_source_digest
          AND (NEW.review_package#>>'{reproducibility,trialResultsDigest}')=reproducibility.trial_results_digest))
  ) THEN
    RAISE EXCEPTION 'research admission requires exact immutable source material and independent current review authority'
      USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER hypothesis_submission_delivery_admission_guard
  BEFORE INSERT ON motive.hypothesis_submission_delivery_admission_decisions
  FOR EACH ROW EXECUTE FUNCTION motive.guard_hypothesis_submission_delivery_admission();
CREATE TRIGGER hypothesis_submission_delivery_admissions_immutable
  BEFORE UPDATE OR DELETE ON motive.hypothesis_submission_delivery_admission_decisions
  FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();

REVOKE ALL ON motive.hypothesis_submission_delivery_admission_decisions FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_hypothesis_submission_delivery_admission() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    EXECUTE 'REVOKE ALL ON motive.hypothesis_submission_delivery_admission_decisions FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    EXECUTE 'REVOKE ALL ON motive.hypothesis_submission_delivery_admission_decisions FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='motive_control_reader') THEN
    EXECUTE 'REVOKE ALL ON motive.hypothesis_submission_delivery_admission_decisions FROM motive_control_reader';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_hypothesis_submission_delivery_admission() FROM motive_control_reader';
  END IF;
END $$;
