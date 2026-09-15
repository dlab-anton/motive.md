-- A completed pre-policy draft can receive one later, independently accepted
-- finding without changing its immutable delivery history. The recovery request
-- is authorized by a current capability-3 owner policy and has its own durable,
-- idempotent operation and result receipt.

CREATE TABLE motive.agent_memory_recovery_operations (
  finding_decision_id UUID PRIMARY KEY REFERENCES motive.finding_review_decisions(id) ON DELETE RESTRICT,
  legacy_delivery_id UUID NOT NULL REFERENCES motive.hypothesis_submission_deliveries(id) ON DELETE RESTRICT,
  target_hypothesis_id UUID NOT NULL,
  target_channel_id UUID NOT NULL,
  request_path TEXT NOT NULL CHECK (request_path='/api/v1/hypotheses/'||target_hypothesis_id::TEXT||'/evidence'),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (idempotency_key='motive-agent-memory:'||finding_decision_id::TEXT||':evidence'),
  request_body JSONB NOT NULL CHECK (jsonb_typeof(request_body)='object'),
  request_body_digest TEXT NOT NULL CHECK (request_body_digest ~ '^sha256:[a-f0-9]{64}$'),
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE motive.agent_memory_recovery_authorizations (
  finding_decision_id UUID NOT NULL REFERENCES motive.agent_memory_recovery_operations(finding_decision_id) ON DELETE RESTRICT,
  policy_id UUID NOT NULL REFERENCES motive.project_research_delivery_policies(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(finding_decision_id,policy_id)
);

CREATE TABLE motive.agent_memory_recovery_results (
  finding_decision_id UUID PRIMARY KEY REFERENCES motive.agent_memory_recovery_operations(finding_decision_id) ON DELETE RESTRICT,
  evidence_id UUID NOT NULL,
  response_body JSONB NOT NULL CHECK (jsonb_typeof(response_body)='object'),
  response_digest TEXT NOT NULL CHECK (response_digest ~ '^sha256:[a-f0-9]{64}$'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE motive.agent_memory_recovery_blocks (
  finding_decision_id UUID PRIMARY KEY REFERENCES motive.agent_memory_recovery_operations(finding_decision_id) ON DELETE RESTRICT,
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  reason TEXT NOT NULL CHECK (reason='TARGET_PRECONDITION_CONFLICT'),
  http_status INTEGER NOT NULL CHECK (http_status=409),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE motive.agent_memory_recovery_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE motive.agent_memory_recovery_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE motive.agent_memory_recovery_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE motive.agent_memory_recovery_blocks ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION motive.valid_legacy_agent_memory_recovery(
  reviewer_actor TEXT, finding_decision UUID, target_delivery UUID, authorizing_policy UUID
)
RETURNS BOOLEAN LANGUAGE sql STABLE SET search_path=pg_catalog,motive AS $$
  SELECT finding_decision IS NOT NULL AND EXISTS (
    SELECT 1
    FROM motive.agent_memory_recovery_operations recovery
    JOIN motive.agent_memory_recovery_authorizations recovery_auth
      ON recovery_auth.finding_decision_id=recovery.finding_decision_id
    JOIN motive.finding_review_decisions finding ON finding.id=recovery.finding_decision_id
      AND finding.source_submission_id=(SELECT source_submission_id FROM motive.hypothesis_submission_deliveries
        WHERE id=recovery.legacy_delivery_id)
    JOIN motive.hypothesis_submission_deliveries delivery ON delivery.id=recovery.legacy_delivery_id
      AND delivery.project_id=finding.project_id AND delivery.source_submission_id=finding.source_submission_id
    JOIN motive.hypothesis_submission_delivery_operations draft ON draft.delivery_id=delivery.id
      AND draft.operation='DRAFT_HYPOTHESIS'
    JOIN motive.hypothesis_submission_delivery_results draft_result ON draft_result.delivery_id=delivery.id
      AND draft_result.operation='DRAFT_HYPOTHESIS' AND draft_result.resource_id=recovery.target_hypothesis_id
    JOIN motive.hypothesis_submission_delivery_operations original_evidence ON original_evidence.delivery_id=delivery.id
      AND original_evidence.operation='NEUTRAL_EVIDENCE'
    JOIN motive.hypothesis_submission_delivery_results original_result ON original_result.delivery_id=delivery.id
      AND original_result.operation='NEUTRAL_EVIDENCE'
    JOIN motive.project_research_delivery_policies policy ON policy.id=recovery_auth.policy_id
      AND policy.project_id=delivery.project_id AND policy.scope_id=delivery.scope_id
    LEFT JOIN motive.project_research_delivery_policy_revocations revocation ON revocation.policy_id=policy.id
    JOIN motive.projects project ON project.id=policy.project_id AND project.current_revision=policy.project_revision
    JOIN motive.work_orders work ON work.id=policy.work_order_id AND work.project_id=project.id
      AND work.project_revision=policy.project_revision AND work.revision=policy.work_order_revision
      AND work.terms_digest=policy.work_order_terms_digest
    JOIN motive.submissions submission ON submission.id=finding.source_submission_id
      AND submission.project_id=project.id AND submission.work_order_id=work.id
      AND submission.work_order_revision=work.revision
    JOIN motive.project_research_scopes scope ON scope.id=policy.scope_id AND scope.project_id=project.id
      AND scope.status='CONNECTED' AND scope.configuration_digest=policy.scope_configuration_digest
      AND scope.api_base_url=policy.engine_api_base_url AND scope.api_version=policy.engine_api_version
      AND scope.channel_id=recovery.target_channel_id
    JOIN motive.memberships approver_membership ON approver_membership.project_id=project.id
      AND approver_membership.actor_id=policy.approved_by_actor_id AND approver_membership.revoked_at IS NULL
      AND approver_membership.role IN ('OWNER','STEWARD')
    JOIN motive.account_identities approver ON approver.actor_id=policy.approved_by_actor_id AND approver.status='ACTIVE'
    WHERE recovery.finding_decision_id=finding_decision AND recovery.legacy_delivery_id=target_delivery
      AND recovery_auth.policy_id=authorizing_policy
      AND finding.reviewer_actor_id=reviewer_actor AND finding.decision='ACCEPT'
      AND finding.review_package->>'format'='motive.finding-review-package/0.2'
      AND NOT EXISTS(SELECT 1 FROM motive.finding_review_decisions successor
        WHERE successor.previous_decision_id=finding.id)
      AND motive.valid_agent_finding_review_proof(finding.reviewer_actor_id,finding.reviewer_agent_token_id,
        finding.review_submission_id,finding.source_submission_id,finding.project_id)
      AND delivery.delivery_mode='NEW_DRAFT' AND (delivery.created_by_actor_id ~ '^account:' OR EXISTS(
        SELECT 1 FROM motive.project_research_delivery_policies historical_policy
        WHERE delivery.created_by_actor_id='policy:'||historical_policy.id::TEXT
          AND historical_policy.project_id=delivery.project_id AND historical_policy.scope_id=delivery.scope_id
          AND historical_policy.reviewed_contract_digest=delivery.reviewed_contract_digest
          AND historical_policy.reviewed_contract_version=delivery.reviewed_contract_version
          AND historical_policy.reviewed_contract_surface_digest=delivery.reviewed_contract_surface_digest
          AND historical_policy.reviewed_implementation_digest=delivery.reviewed_implementation_digest
          AND historical_policy.engine_api_base_url=delivery.engine_api_base_url
          AND historical_policy.engine_api_version=delivery.engine_api_version
          AND historical_policy.scope_configuration_digest=delivery.scope_configuration_digest))
      AND delivery.reviewed_contract_digest='sha256:890d29b73511b2a3922ed1fd165c9cc4f1779d205118403406551420bf027aa4'
      AND delivery.reviewed_contract_version='hypothesis-http-writeback-capabilities/2'
      AND delivery.reviewed_contract_surface_digest='6586d546ef57af3633b94978e594da0a536ae3b7dc84c892a0875aba916caf47'
      AND delivery.reviewed_implementation_digest='5df840cefe905da907c62af4fafac6b14bafd97e97e4727b5ee189bb37ec321c'
      AND policy.reviewed_contract_digest='sha256:ddd18ff4ea1c98c51db4971e1aaeafe217d2c00f5625fae545414419c6349102'
      AND policy.reviewed_contract_version='hypothesis-http-writeback-capabilities/3'
      AND policy.reviewed_contract_surface_digest='c42a174eba3f293bcb2165c298ccb1750aff0ce6e8800c82ed31f2d138f81119'
      AND policy.reviewed_implementation_digest='faac1ad462664fd5b484399ae224e90c180615f9cce5f1432a3dcc4583e1165e'
      AND policy.engine_api_version='1.8.0' AND policy.delivery_mode='NEW_DRAFT'
      AND policy.permitted_operations=ARRAY['DRAFT_HYPOTHESIS','NEUTRAL_EVIDENCE']::TEXT[]
      AND policy.target_selection_rule IS NULL AND revocation.policy_id IS NULL
      AND recovery.request_body->>'expected_channel_id'=recovery.target_channel_id::TEXT
      AND recovery.request_body->>'created_by'=delivery.engine_actor
      AND recovery.request_body->>'evidence_type'='neutral'
      AND recovery.request_body_digest='sha256:'||encode(sha256(convert_to(
        motive.finding_review_canonical_json(recovery.request_body),'UTF8')),'hex')
      AND recovery.request_digest='sha256:'||encode(sha256(convert_to(motive.finding_review_canonical_json(
        jsonb_build_object('method','POST','path',recovery.request_path,'bodyDigest',recovery.request_body_digest)),'UTF8')),'hex')
  );
$$;

CREATE OR REPLACE FUNCTION motive.guard_agent_memory_recovery_authorization()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,motive AS $$
BEGIN
  IF NOT motive.valid_legacy_agent_memory_recovery(
    (SELECT reviewer_actor_id FROM motive.finding_review_decisions WHERE id=NEW.finding_decision_id),
    NEW.finding_decision_id,(SELECT legacy_delivery_id FROM motive.agent_memory_recovery_operations
      WHERE finding_decision_id=NEW.finding_decision_id),NEW.policy_id) THEN
    RAISE EXCEPTION 'legacy memory recovery requires exact current finding, delivery, and policy authority'
      USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_memory_recovery_authorization_guard
  AFTER INSERT ON motive.agent_memory_recovery_authorizations
  FOR EACH ROW EXECUTE FUNCTION motive.guard_agent_memory_recovery_authorization();

-- Clone the existing policy-principal proof without changing the original
-- function OID used by installed trigger dependencies.
DO $$ DECLARE definition TEXT; BEGIN
  SELECT pg_get_functiondef('motive.valid_agent_memory_admission_proof(text,uuid,uuid)'::regprocedure) INTO definition;
  definition:=regexp_replace(definition,'FUNCTION motive\.valid_agent_memory_admission_proof\(',
    'FUNCTION motive.valid_policy_agent_memory_admission_proof(');
  IF definition NOT LIKE '%FUNCTION motive.valid_policy_agent_memory_admission_proof(%' THEN
    RAISE EXCEPTION 'could not clone the installed policy memory proof';
  END IF;
  EXECUTE definition;
END $$;
CREATE OR REPLACE FUNCTION motive.valid_agent_memory_admission_proof(
  reviewer_actor TEXT, finding_decision UUID, target_delivery UUID
)
RETURNS BOOLEAN LANGUAGE sql STABLE SET search_path=pg_catalog,motive AS $$
  SELECT motive.valid_policy_agent_memory_admission_proof(reviewer_actor,finding_decision,target_delivery)
    OR EXISTS(SELECT 1 FROM motive.agent_memory_recovery_authorizations recovery_auth
      WHERE recovery_auth.finding_decision_id=finding_decision
        AND motive.valid_legacy_agent_memory_recovery(reviewer_actor,finding_decision,target_delivery,
          recovery_auth.policy_id));
$$;

-- A recorded exact reviewer may request execution of the delivery they admitted.
-- The request still binds the source submission's report and post-check; only the
-- authenticated agent credential may come from the accepted review proof.
DO $$ DECLARE definition TEXT; DECLARE needle TEXT; DECLARE replacement TEXT; DECLARE occurrences INTEGER; BEGIN
  SELECT pg_get_functiondef('motive.guard_agent_research_sync_request()'::regprocedure) INTO definition;
  needle:=$match$AND artifact.project_id=token.project_id AND artifact.agent_token_id=token.id
      AND artifact.report_digest=NEW.report_digest$match$;
  replacement:=$match$AND artifact.project_id=token.project_id AND artifact.report_digest=NEW.report_digest$match$;
  occurrences:=(length(definition)-length(replace(definition,needle,'')))/length(needle);
  IF occurrences<>1 THEN RAISE EXCEPTION 'expected sync source-token artifact predicate once, found %',occurrences; END IF;
  definition:=replace(definition,needle,replacement);
  needle:=$match$AND assessment.project_id=artifact.project_id AND assessment.agent_token_id=token.id
      AND assessment.report_digest=artifact.report_digest$match$;
  replacement:=$match$AND assessment.project_id=artifact.project_id AND assessment.agent_token_id=artifact.agent_token_id
      AND assessment.report_digest=artifact.report_digest$match$;
  occurrences:=(length(definition)-length(replace(definition,needle,'')))/length(needle);
  IF occurrences<>1 THEN RAISE EXCEPTION 'expected sync post-check token predicate once, found %',occurrences; END IF;
  definition:=replace(definition,needle,replacement);
  needle:=$match$WHERE token.id=NEW.agent_token_id AND token.project_id=NEW.project_id$match$;
  replacement:=$match$WHERE token.id=NEW.agent_token_id AND token.project_id=NEW.project_id
      AND (artifact.agent_token_id=token.id OR EXISTS(
        SELECT 1 FROM motive.finding_review_decisions finding
        JOIN motive.hypothesis_submission_deliveries delivery ON delivery.project_id=finding.project_id
          AND delivery.source_submission_id=finding.source_submission_id
        JOIN motive.hypothesis_submission_delivery_admission_decisions admission ON admission.delivery_id=delivery.id
          AND admission.finding_decision_id=finding.id AND admission.decision='ADMIT'
          AND NOT EXISTS(SELECT 1 FROM motive.hypothesis_submission_delivery_admission_decisions successor
            WHERE successor.previous_decision_id=admission.id)
        WHERE finding.source_submission_id=NEW.submission_id AND finding.project_id=NEW.project_id
          AND finding.reviewer_agent_token_id=token.id
          AND motive.valid_agent_memory_admission_proof(finding.reviewer_actor_id,finding.id,delivery.id)))$match$;
  occurrences:=(length(definition)-length(replace(definition,needle,'')))/length(needle);
  IF occurrences<>1 THEN RAISE EXCEPTION 'expected sync caller-token predicate once, found %',occurrences; END IF;
  EXECUTE replace(definition,needle,replacement);
END $$;

CREATE OR REPLACE FUNCTION motive.guard_agent_memory_recovery_result()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,motive AS $$
BEGIN
  IF NEW.response_digest<>'sha256:'||encode(sha256(convert_to(
      motive.finding_review_canonical_json(NEW.response_body),'UTF8')),'hex')
    OR NOT EXISTS(SELECT 1 FROM motive.agent_memory_recovery_operations operation
      WHERE operation.finding_decision_id=NEW.finding_decision_id
        AND NEW.evidence_id=(NEW.response_body#>>'{evidence,id}')::UUID
        AND operation.target_hypothesis_id=(NEW.response_body#>>'{evidence,hypothesis_id}')::UUID
        AND operation.target_hypothesis_id=(NEW.response_body#>>'{hypothesis,id}')::UUID
        AND operation.request_body->>'content'=NEW.response_body#>>'{evidence,content}'
        AND operation.request_body->>'source'=NEW.response_body#>>'{evidence,source}'
        AND NEW.response_body#>>'{evidence,evidence_type}'='neutral'
        AND operation.request_body->>'created_by'=NEW.response_body#>>'{evidence,created_by}') THEN
    RAISE EXCEPTION 'legacy memory recovery result does not match its immutable request' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_memory_recovery_result_guard
  BEFORE INSERT ON motive.agent_memory_recovery_results
  FOR EACH ROW EXECUTE FUNCTION motive.guard_agent_memory_recovery_result();

CREATE OR REPLACE FUNCTION motive.guard_agent_memory_recovery_block()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,motive AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM motive.agent_memory_recovery_operations operation
      WHERE operation.finding_decision_id=NEW.finding_decision_id
        AND operation.request_digest=NEW.request_digest)
    OR EXISTS(SELECT 1 FROM motive.agent_memory_recovery_results result
      WHERE result.finding_decision_id=NEW.finding_decision_id) THEN
    RAISE EXCEPTION 'legacy memory recovery block requires the exact unresolved request' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_memory_recovery_block_guard
  BEFORE INSERT ON motive.agent_memory_recovery_blocks
  FOR EACH ROW EXECUTE FUNCTION motive.guard_agent_memory_recovery_block();

CREATE TRIGGER agent_memory_recovery_operations_immutable
  BEFORE UPDATE OR DELETE ON motive.agent_memory_recovery_operations
  FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();
CREATE TRIGGER agent_memory_recovery_results_immutable
  BEFORE UPDATE OR DELETE ON motive.agent_memory_recovery_results
  FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();
CREATE TRIGGER agent_memory_recovery_blocks_immutable
  BEFORE UPDATE OR DELETE ON motive.agent_memory_recovery_blocks
  FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();
CREATE TRIGGER agent_memory_recovery_authorizations_immutable
  BEFORE UPDATE OR DELETE ON motive.agent_memory_recovery_authorizations
  FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();

REVOKE ALL ON motive.agent_memory_recovery_operations,motive.agent_memory_recovery_authorizations,
  motive.agent_memory_recovery_results,motive.agent_memory_recovery_blocks FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.valid_legacy_agent_memory_recovery(TEXT,UUID,UUID,UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.valid_policy_agent_memory_admission_proof(TEXT,UUID,UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.valid_agent_memory_admission_proof(TEXT,UUID,UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_agent_memory_recovery_authorization() FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_agent_memory_recovery_result() FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_agent_memory_recovery_block() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    EXECUTE 'REVOKE ALL ON motive.agent_memory_recovery_operations,motive.agent_memory_recovery_authorizations,motive.agent_memory_recovery_results,motive.agent_memory_recovery_blocks FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    EXECUTE 'REVOKE ALL ON motive.agent_memory_recovery_operations,motive.agent_memory_recovery_authorizations,motive.agent_memory_recovery_results,motive.agent_memory_recovery_blocks FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='motive_control_reader') THEN
    EXECUTE 'REVOKE ALL ON motive.agent_memory_recovery_operations,motive.agent_memory_recovery_authorizations,motive.agent_memory_recovery_results,motive.agent_memory_recovery_blocks FROM motive_control_reader';
  END IF;
END $$;

DO $$ DECLARE role_name TEXT; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','motive_control_reader'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION motive.valid_legacy_agent_memory_recovery(TEXT,UUID,UUID,UUID) FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON FUNCTION motive.valid_policy_agent_memory_admission_proof(TEXT,UUID,UUID) FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON FUNCTION motive.valid_agent_memory_admission_proof(TEXT,UUID,UUID) FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON FUNCTION motive.guard_agent_memory_recovery_authorization() FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON FUNCTION motive.guard_agent_memory_recovery_result() FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON FUNCTION motive.guard_agent_memory_recovery_block() FROM %I',role_name);
    END IF;
  END LOOP;
END $$;
