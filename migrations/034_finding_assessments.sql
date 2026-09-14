-- Motive-owned, append-only assessments of one completed investigation. These
-- decisions attach to the immutable source submission; they are not Hypothesis
-- Engine conclusions and do not authorize engine writes.

CREATE TABLE motive.finding_review_decisions (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES motive.projects(id) ON DELETE RESTRICT,
  source_submission_id UUID NOT NULL REFERENCES motive.submissions(id) ON DELETE RESTRICT,
  review_package JSONB NOT NULL CHECK (jsonb_typeof(review_package)='object'
    AND octet_length(review_package::text)<=524288),
  review_package_digest TEXT NOT NULL CHECK (review_package_digest ~ '^sha256:[a-f0-9]{64}$'),
  previous_decision_id UUID,
  decision TEXT NOT NULL CHECK (decision IN ('ACCEPT','DECLINE')),
  outcome TEXT CHECK (outcome IN ('SUPPORTED','CONTRADICTED','INCONCLUSIVE')),
  finding TEXT CHECK (finding IS NULL OR char_length(finding) BETWEEN 1 AND 2000 AND finding=btrim(finding)),
  limitations TEXT CHECK (limitations IS NULL OR char_length(limitations) BETWEEN 1 AND 2000 AND limitations=btrim(limitations)),
  novelty TEXT CHECK (novelty IN ('DISTINCT','DUPLICATE')),
  duplicate_of_submission_id UUID REFERENCES motive.submissions(id) ON DELETE RESTRICT,
  duplicate_of_decision_id UUID,
  reviewer_actor_id TEXT NOT NULL CHECK (reviewer_actor_id ~ '^account:[A-Za-z0-9._~-]+$'),
  rationale TEXT NOT NULL CHECK (char_length(rationale) BETWEEN 1 AND 2000 AND rationale=btrim(rationale)),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200
    AND idempotency_key ~ '^[A-Za-z0-9._~-]+$'),
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(id,project_id,source_submission_id),
  UNIQUE(reviewer_actor_id,idempotency_key),
  FOREIGN KEY(previous_decision_id,project_id,source_submission_id)
    REFERENCES motive.finding_review_decisions(id,project_id,source_submission_id) ON DELETE RESTRICT,
  FOREIGN KEY(duplicate_of_decision_id,project_id,duplicate_of_submission_id)
    REFERENCES motive.finding_review_decisions(id,project_id,source_submission_id) ON DELETE RESTRICT,
  CHECK (previous_decision_id IS NULL OR previous_decision_id<>id),
  CHECK ((review_package->>'format') IS NOT DISTINCT FROM 'motive.finding-review-package/0.1'),
  CHECK ((review_package->>'findingId') IS NOT DISTINCT FROM source_submission_id::text),
  CHECK ((review_package#>>'{project,id}') IS NOT DISTINCT FROM project_id::text),
  CHECK ((review_package#>>'{assessment,engineHypothesisSupport}') IS NOT DISTINCT FROM 'UNASSESSED'),
  CHECK ((review_package#>>'{assessment,engineConclusionApproval}') IS NOT DISTINCT FROM 'UNASSESSED'),
  CHECK ((decision='ACCEPT' AND outcome IS NOT NULL AND finding IS NOT NULL AND limitations IS NOT NULL
      AND novelty IS NOT NULL AND ((novelty='DISTINCT' AND duplicate_of_submission_id IS NULL AND duplicate_of_decision_id IS NULL)
        OR (novelty='DUPLICATE' AND duplicate_of_submission_id IS NOT NULL AND duplicate_of_decision_id IS NOT NULL
          AND duplicate_of_submission_id<>source_submission_id)))
    OR (decision='DECLINE' AND outcome IS NULL AND finding IS NULL AND limitations IS NULL AND novelty IS NULL
      AND duplicate_of_submission_id IS NULL AND duplicate_of_decision_id IS NULL))
);

CREATE UNIQUE INDEX finding_review_chain_root_idx ON motive.finding_review_decisions(source_submission_id)
  WHERE previous_decision_id IS NULL;
CREATE UNIQUE INDEX finding_review_chain_successor_idx ON motive.finding_review_decisions(previous_decision_id)
  WHERE previous_decision_id IS NOT NULL;
CREATE INDEX finding_review_project_created_idx
  ON motive.finding_review_decisions(project_id,created_at DESC,id DESC);

CREATE OR REPLACE FUNCTION motive.guard_finding_review_decision()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,motive AS $$
BEGIN
  -- Completion rows are the stable subject locks. Sorting keeps source and
  -- duplicate decisions in the same order for concurrent cross-references.
  PERFORM completion.submission_id FROM motive.participation_claim_completions completion
    WHERE completion.submission_id IN (NEW.source_submission_id,NEW.duplicate_of_submission_id)
    ORDER BY completion.submission_id FOR UPDATE;

  IF NEW.previous_decision_id IS NULL THEN
    IF EXISTS (SELECT 1 FROM motive.finding_review_decisions item
      WHERE item.source_submission_id=NEW.source_submission_id) THEN
      RAISE EXCEPTION 'finding review expected decision is stale' USING ERRCODE='40001';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1 FROM motive.finding_review_decisions prior
    WHERE prior.id=NEW.previous_decision_id AND prior.project_id=NEW.project_id
      AND prior.source_submission_id=NEW.source_submission_id
      AND NOT EXISTS(SELECT 1 FROM motive.finding_review_decisions successor
        WHERE successor.previous_decision_id=prior.id)
  ) THEN
    RAISE EXCEPTION 'finding review expected decision is stale' USING ERRCODE='40001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM motive.submissions submission
    JOIN motive.participation_submission_artifacts artifact ON artifact.submission_id=submission.id
      AND artifact.project_id=submission.project_id
    JOIN motive.participation_agent_tokens token ON token.id=artifact.agent_token_id
      AND token.project_id=submission.project_id
    JOIN motive.participation_claim_completions completion ON completion.submission_id=submission.id
      AND completion.claim_id=submission.claim_id
    JOIN motive.participation_post_check_assessments assessment ON assessment.submission_id=submission.id
      AND assessment.project_id=submission.project_id AND assessment.agent_token_id=artifact.agent_token_id
      AND assessment.report_digest=artifact.report_digest
    JOIN motive.memberships reviewer_membership ON reviewer_membership.project_id=submission.project_id
      AND reviewer_membership.actor_id=NEW.reviewer_actor_id AND reviewer_membership.revoked_at IS NULL
      AND reviewer_membership.role IN ('OWNER','STEWARD','REVIEWER')
    JOIN motive.account_identities reviewer ON reviewer.actor_id=NEW.reviewer_actor_id AND reviewer.status='ACTIVE'
    WHERE submission.id=NEW.source_submission_id AND submission.project_id=NEW.project_id
  ) THEN
    RAISE EXCEPTION 'finding review requires a completed immutable investigation and current reviewer authority'
      USING ERRCODE='42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM motive.submissions submission
    JOIN motive.participation_submission_artifacts artifact ON artifact.submission_id=submission.id
    JOIN motive.participation_agent_tokens token ON token.id=artifact.agent_token_id
    WHERE submission.id=NEW.source_submission_id AND NEW.reviewer_actor_id<>token.owner_actor_id
  ) THEN
    RAISE EXCEPTION 'finding review requires an independent reviewer' USING ERRCODE='42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM motive.submissions submission
    JOIN motive.work_orders work ON work.id=submission.work_order_id AND work.project_id=submission.project_id
    JOIN motive.work_claims claim ON claim.id=submission.claim_id AND claim.project_id=submission.project_id
    JOIN motive.participation_claim_completions completion ON completion.submission_id=submission.id
      AND completion.claim_id=submission.claim_id
    JOIN motive.participation_submission_artifacts artifact ON artifact.submission_id=submission.id
      AND artifact.project_id=submission.project_id
    JOIN motive.participation_agent_tokens token ON token.id=artifact.agent_token_id
      AND token.project_id=submission.project_id
    JOIN motive.participation_post_check_assessments post_check ON post_check.submission_id=submission.id
      AND post_check.project_id=submission.project_id AND post_check.agent_token_id=artifact.agent_token_id
      AND post_check.report_digest=artifact.report_digest
    JOIN motive.hypothesis_submission_deliveries delivery
      ON delivery.id=(NEW.review_package#>>'{delivery,id}')::UUID
      AND delivery.project_id=submission.project_id AND delivery.source_submission_id=submission.id
    JOIN motive.hypothesis_writeback_intents intent ON intent.id=delivery.source_intent_id
      AND intent.project_id=submission.project_id AND intent.source_submission_id=submission.id
      AND intent.payload_digest=delivery.source_intent_payload_digest
    JOIN motive.hypothesis_submission_delivery_operations draft ON draft.delivery_id=delivery.id
      AND draft.operation='DRAFT_HYPOTHESIS'
    JOIN motive.hypothesis_submission_delivery_results draft_result ON draft_result.delivery_id=delivery.id
      AND draft_result.operation='DRAFT_HYPOTHESIS'
    JOIN motive.hypothesis_submission_delivery_operations evidence ON evidence.delivery_id=delivery.id
      AND evidence.operation='NEUTRAL_EVIDENCE' AND evidence.target_hypothesis_id=draft_result.resource_id
    JOIN motive.hypothesis_submission_delivery_results evidence_result ON evidence_result.delivery_id=delivery.id
      AND evidence_result.operation='NEUTRAL_EVIDENCE'
    LEFT JOIN motive.participation_submission_reproducibility repro ON repro.submission_id=submission.id
      AND repro.project_id=submission.project_id AND repro.agent_token_id=artifact.agent_token_id
      AND repro.report_digest=artifact.report_digest
    LEFT JOIN motive.participation_claim_intents claim_intent ON claim_intent.claim_id=claim.id
      AND claim_intent.project_id=submission.project_id AND claim_intent.work_order_id=work.id
      AND claim_intent.work_order_revision=work.revision AND claim_intent.work_order_terms_digest=work.terms_digest
      AND claim_intent.lease_epoch=claim.lease_epoch AND claim_intent.agent_token_id=artifact.agent_token_id
    WHERE submission.id=NEW.source_submission_id AND submission.project_id=NEW.project_id
      AND (NEW.review_package#>>'{project,revision}')::INTEGER=work.project_revision
      AND NEW.review_package#>>'{workOrder,id}'=work.id::TEXT
      AND (NEW.review_package#>>'{workOrder,revision}')::INTEGER=work.revision
      AND (NEW.review_package#>>'{workOrder,projectRevision}')::INTEGER=work.project_revision
      AND NEW.review_package#>>'{workOrder,termsDigest}'=work.terms_digest
      AND NEW.review_package#>'{workOrder,terms}'=work.terms
      AND NEW.review_package#>>'{claim,id}'=claim.id::TEXT
      AND (NEW.review_package#>>'{claim,leaseEpoch}')::INTEGER=claim.lease_epoch
      AND NEW.review_package#>>'{claim,termsDigest}'=claim.terms_digest
      AND (NEW.review_package#>>'{claim,completedAt}')::TIMESTAMPTZ=date_trunc('milliseconds',completion.completed_at)
      AND NEW.review_package#>>'{source,submission,id}'=submission.id::TEXT
      AND NEW.review_package#>>'{source,submission,format}'=submission.format
      AND (NEW.review_package#>>'{source,submission,createdAt}')::TIMESTAMPTZ=date_trunc('milliseconds',submission.created_at)
      AND NEW.review_package#>>'{source,submission,baseCommit}'=submission.base_commit
      AND NEW.review_package#>>'{source,submission,artifactManifestDigest}'=submission.artifact_manifest_digest
      AND NEW.review_package#>>'{source,submission,licenseAcceptanceRef}'=submission.license_acceptance_ref
      AND NEW.review_package#>>'{source,submission,sourceIntentId}'=intent.id::TEXT
      AND NEW.review_package#>>'{source,submission,sourceIntentPayloadDigest}'=intent.payload_digest
      AND NEW.review_package#>'{source,submission,sourceIntentPayload}'=intent.payload
      AND NEW.review_package#>>'{source,attribution,contributorActorId}'=token.owner_actor_id
      AND NEW.review_package#>>'{source,attribution,agentTokenId}'=token.id::TEXT
      AND NEW.review_package#>>'{source,attribution,agentName}'=token.agent_name
      AND ((claim_intent.claim_id IS NULL AND NEW.review_package#>'{source,declaredIntent}'='null'::JSONB)
        OR (claim_intent.claim_id IS NOT NULL
          AND NEW.review_package#>>'{source,declaredIntent,proposal}'=claim_intent.proposal
          AND NEW.review_package#>>'{source,declaredIntent,expectation}'=claim_intent.expectation
          AND ARRAY(SELECT jsonb_array_elements_text(NEW.review_package#>'{source,declaredIntent,conditions}'))=claim_intent.conditions
          AND NULLIF(NEW.review_package#>'{source,declaredIntent,researchContext}','null'::JSONB)
            IS NOT DISTINCT FROM claim_intent.research_context
          AND NULLIF(NEW.review_package#>'{source,declaredIntent,researchReferences}','null'::JSONB)
            IS NOT DISTINCT FROM claim_intent.research_references
          AND NULLIF(NEW.review_package#>'{source,declaredIntent,motiveReferences}','null'::JSONB)
            IS NOT DISTINCT FROM claim_intent.motive_references
          AND (NEW.review_package#>>'{source,declaredIntent,declaredAt}')::TIMESTAMPTZ=date_trunc('milliseconds',claim_intent.created_at)
          AND NEW.review_package#>>'{source,declaredIntent,requestDigest}'=claim_intent.request_digest))
      AND NEW.review_package#>>'{source,artifact,format}'=artifact.witness_format
      AND NEW.review_package#>>'{source,artifact,witness}'=convert_from(artifact.witness_bytes,'UTF8')
      AND NEW.review_package#>>'{source,artifact,digest}'=artifact.witness_digest
      AND NEW.review_package#>>'{source,report,status}'=artifact.report::TEXT
      AND NEW.review_package#>'{source,report,body}'=artifact.report_body
      AND NEW.review_package#>>'{source,report,digest}'=artifact.report_digest
      AND NEW.review_package#>>'{source,postCheck,requestDigest}'=post_check.request_digest
      AND NEW.review_package#>>'{source,postCheck,reportDigest}'=post_check.report_digest
      AND NEW.review_package#>>'{source,postCheck,assessment}'=post_check.assessment
      AND NEW.review_package#>>'{source,postCheck,nextAction}'=post_check.next_action
      AND (NEW.review_package#>>'{source,postCheck,createdAt}')::TIMESTAMPTZ=date_trunc('milliseconds',post_check.created_at)
      AND ((repro.submission_id IS NULL AND NEW.review_package#>'{source,reproducibility}'='null'::JSONB)
        OR (repro.submission_id IS NOT NULL
          AND NEW.review_package#>>'{source,reproducibility,requestDigest}'=repro.request_digest
          AND NEW.review_package#>>'{source,reproducibility,solverSourceDigest}'=repro.solver_source_digest
          AND NEW.review_package#>>'{source,reproducibility,trialResultsDigest}'=repro.trial_results_digest))
      AND NEW.review_package#>>'{delivery,scopeId}'=delivery.scope_id::TEXT
      AND NEW.review_package#>>'{delivery,engineActor}'=delivery.engine_actor
      AND (NEW.review_package#>>'{delivery,createdAt}')::TIMESTAMPTZ=date_trunc('milliseconds',delivery.created_at)
      AND NEW.review_package#>'{engine,hypothesis,requestBody}'=draft.request_body
      AND NEW.review_package#>>'{engine,hypothesis,requestBodyDigest}'=draft.request_body_digest
      AND NEW.review_package#>>'{engine,hypothesis,requestDigest}'=draft.request_digest
      AND NEW.review_package#>>'{engine,hypothesis,id}'=draft_result.resource_id::TEXT
      AND NEW.review_package#>'{engine,hypothesis,responseBody}'=draft_result.response_body
      AND NEW.review_package#>>'{engine,hypothesis,responseDigest}'=draft_result.response_digest
      AND NEW.review_package#>'{engine,evidence,requestBody}'=evidence.request_body
      AND NEW.review_package#>>'{engine,evidence,requestBodyDigest}'=evidence.request_body_digest
      AND NEW.review_package#>>'{engine,evidence,requestDigest}'=evidence.request_digest
      AND NEW.review_package#>>'{engine,evidence,id}'=evidence_result.resource_id::TEXT
      AND NEW.review_package#>'{engine,evidence,responseBody}'=evidence_result.response_body
      AND NEW.review_package#>>'{engine,evidence,responseDigest}'=evidence_result.response_digest
      AND NOT EXISTS (
        SELECT 1 FROM motive.hypothesis_submission_deliveries newer
        WHERE newer.project_id=submission.project_id AND newer.source_submission_id=submission.id
          AND (newer.created_at,newer.id)>(delivery.created_at,delivery.id)
          AND EXISTS(SELECT 1 FROM motive.hypothesis_submission_delivery_results r
            WHERE r.delivery_id=newer.id AND r.operation='DRAFT_HYPOTHESIS')
          AND EXISTS(SELECT 1 FROM motive.hypothesis_submission_delivery_results r
            WHERE r.delivery_id=newer.id AND r.operation='NEUTRAL_EVIDENCE'))
  ) THEN
    RAISE EXCEPTION 'finding review package does not match the complete retained investigation' USING ERRCODE='23514';
  END IF;

  IF NEW.novelty='DUPLICATE' AND NOT EXISTS (
    SELECT 1 FROM motive.finding_review_decisions target
    WHERE target.id=NEW.duplicate_of_decision_id AND target.project_id=NEW.project_id
      AND target.source_submission_id=NEW.duplicate_of_submission_id
      AND target.decision='ACCEPT' AND target.novelty='DISTINCT'
      AND NOT EXISTS(SELECT 1 FROM motive.finding_review_decisions successor
        WHERE successor.previous_decision_id=target.id)
  ) THEN
    RAISE EXCEPTION 'duplicate finding target must be a current accepted distinct finding' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER finding_review_decision_guard BEFORE INSERT ON motive.finding_review_decisions
  FOR EACH ROW EXECUTE FUNCTION motive.guard_finding_review_decision();
CREATE TRIGGER finding_review_decisions_immutable BEFORE UPDATE OR DELETE ON motive.finding_review_decisions
  FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();

REVOKE ALL ON motive.finding_review_decisions FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_finding_review_decision() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    EXECUTE 'REVOKE ALL ON motive.finding_review_decisions FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_finding_review_decision() FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    EXECUTE 'REVOKE ALL ON motive.finding_review_decisions FROM authenticated';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_finding_review_decision() FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='motive_control_reader') THEN
    EXECUTE 'REVOKE ALL ON motive.finding_review_decisions FROM motive_control_reader';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_finding_review_decision() FROM motive_control_reader';
  END IF;
END $$;
