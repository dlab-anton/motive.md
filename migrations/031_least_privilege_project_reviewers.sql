-- Activate the existing least-privilege REVIEWER membership only at the three
-- independent review boundaries. All source, report, terminal-state, package,
-- identity, and independence guards from the original migrations remain intact.

CREATE OR REPLACE FUNCTION motive.guard_participation_review()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, motive AS $$
DECLARE artifact motive.participation_submission_artifacts%ROWTYPE;
DECLARE contributor_actor TEXT;
BEGIN
  SELECT * INTO artifact FROM motive.participation_submission_artifacts item
  WHERE item.submission_id = NEW.submission_id FOR KEY SHARE;
  SELECT token.owner_actor_id INTO contributor_actor
  FROM motive.participation_agent_tokens token
  WHERE token.id = artifact.agent_token_id FOR KEY SHARE;
  IF artifact.submission_id IS NULL OR artifact.project_id IS DISTINCT FROM NEW.project_id
    OR contributor_actor IS NULL OR contributor_actor = NEW.reviewer_actor_id
    OR NOT EXISTS (SELECT 1 FROM motive.memberships membership WHERE membership.project_id = NEW.project_id
      AND membership.actor_id = NEW.reviewer_actor_id AND membership.revoked_at IS NULL
      AND membership.role IN ('OWNER', 'STEWARD', 'REVIEWER'))
    OR (NEW.decision = 'ACCEPTED' AND artifact.report <> 'VALID')
  THEN
    RAISE EXCEPTION 'participation review requires an independent owner/steward and an acceptable report' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION motive.guard_hosted_circle_review()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, motive AS $$
DECLARE result_record motive.hosted_circle_results%ROWTYPE;
BEGIN
  SELECT * INTO result_record FROM motive.hosted_circle_results WHERE id=NEW.result_id FOR KEY SHARE;
  IF result_record.id IS NULL OR result_record.project_id IS DISTINCT FROM NEW.project_id
    OR result_record.research_actor_id IS NOT DISTINCT FROM NEW.reviewer_actor_id
    OR NOT EXISTS (SELECT 1 FROM motive.memberships membership
      WHERE membership.project_id=NEW.project_id AND membership.actor_id=NEW.reviewer_actor_id
        AND membership.revoked_at IS NULL AND membership.role IN ('OWNER','STEWARD','REVIEWER'))
    OR (NEW.decision='ACCEPTED' AND result_record.status <> 'VALID')
    OR EXISTS (SELECT 1 FROM motive.orchestration_environments environment
      WHERE environment.attempt_id=result_record.attempt_id AND environment.kind IN ('WORKER','EVALUATOR')
        AND environment.state NOT IN ('TERMINATED','ABANDONED'))
  THEN
    RAISE EXCEPTION 'hosted circle review requires an independent current owner or steward and terminal execution'
      USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;

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
      AND reviewer_membership.role IN ('OWNER','STEWARD','REVIEWER')
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


REVOKE ALL ON FUNCTION motive.guard_participation_review() FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_hosted_circle_review() FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_hypothesis_submission_delivery_admission() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='motive_control_reader') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_participation_review() FROM motive_control_reader';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_hosted_circle_review() FROM motive_control_reader';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_hypothesis_submission_delivery_admission() FROM motive_control_reader';
  END IF;
END $$;
